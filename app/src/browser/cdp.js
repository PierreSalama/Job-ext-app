'use strict';
// ============================================================================
//  JAT v11 — CDP browser harness (AI Apply, chunk 1)
//
//  WHY THIS EXISTS
//  The overnight hand-apply loop drove Chrome through a browser extension. Inside the app there
//  is no extension, so AI Apply needs its own way to see and drive a real page. This module is
//  that: launch a Chrome on a DEDICATED profile + debug port, attach to a page target, and expose
//  the same small verb set the extension gave us — navigate, read the tree, click, type, attach a
//  file, screenshot.
//
//  WHAT IT DELIBERATELY DOES NOT DO
//  It does not open its own WebSocket. `cdp-inject.js` already ships a dependency-free CDP client
//  over a raw TCP socket (Electron's main process has no global WebSocket), and it is exported.
//  Duplicating a second RFC 6455 codec to save one require would be two codecs to keep correct.
//  We reuse `openCdp` / `cdpHttp` untouched, so the cookie-injection path keeps working exactly
//  as it does today.
//
//  TARGET CHOICE
//  `/json/version` gives the BROWSER-level socket, which cannot speak Page/DOM/Input/Accessibility.
//  Those are per-target. Rather than Target.attachToTarget + sessionId routing (which would need
//  changes inside openCdp to carry sessionId), we connect straight to the page's own
//  webSocketDebuggerUrl from `/json/list`. Same client, no changes, one socket per page.
//
//  PROFILE ISOLATION
//  Each person gets their own --user-data-dir and their own --remote-debugging-port, so Pierre's
//  Chrome and Dad's Chrome are separate browsers with separate cookie jars that can run at the
//  same time on the server laptop.
// ============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openCdp, cdpHttp } = require('../cdp-inject');

let log = { info() {}, warn() {}, error() {} };
try { log = require('../logger').scope('browser:cdp'); } catch { /* usable outside the app */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Chrome discovery
// ---------------------------------------------------------------------------
function findChrome() {
  const isWin = process.platform === 'win32';
  const cands = isWin
    ? [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  for (const p of cands) {
    try { if (p && fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

// A stable, per-person profile directory.
//
// NEVER the user's real Chrome profile: an automated browser sharing it would fight them for locks
// and could corrupt their session.
//
// And never a TEMP directory either. These folders hold the LinkedIn and ATS logins that make the
// agent useful — Pierre signs in once and it stays signed in. Windows cleans %TEMP%, so a profile
// kept there would silently sign both people out and there would be nothing in the logs to explain
// why every run suddenly hit a login wall.
let PROFILE_ROOT = path.join(os.homedir(), '.jat', 'chrome-profiles');
function setProfileRoot(dir) { if (dir) PROFILE_ROOT = String(dir); }
function profileRoot() { return PROFILE_ROOT; }

function profileDir(profileId) {
  const safe = String(profileId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(PROFILE_ROOT, `chrome-${safe}`);
}

// Has this person's browser ever been signed in? A Chrome profile that has been used has a
// Default/ subfolder with real state in it; a freshly created directory does not.
function profileIsInitialised(profileId) {
  try {
    const d = path.join(profileDir(profileId), 'Default');
    return fs.existsSync(path.join(d, 'Preferences')) || fs.existsSync(path.join(d, 'Cookies'));
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Launch / attach
// ---------------------------------------------------------------------------
async function waitForCdp(host, port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'timeout';
  while (Date.now() < deadline) {
    try {
      const v = await cdpHttp(host, port, '/json/version');
      if (v && v.webSocketDebuggerUrl) return v;
    } catch (e) { lastErr = e.message; }
    await sleep(200);
  }
  throw new Error(`CDP never came up on ${host}:${port} (${lastErr})`);
}


// WHICH PROFILE IS THE BROWSER ON THIS PORT RUNNING?
//
// Two ways to ask, and the order matters.
//
// Browser.getBrowserCommandLine is the tidy one, but Chrome refuses it unless the browser was
// started with --enable-automation. Adding that flag would make identification easy and make
// CLOUDFLARE WORSE - it is one of the fingerprints bot detection looks for, and getting past
// Cloudflare is the entire reason adoption is worth having. Trading a CAPTCHA for a tidy API call
// is a bad trade, so the flag stays off.
//
// The OS knows anyway. The process listening on the port has the --user-data-dir right there in its
// command line, it costs one local query, and it adds nothing at all to what a website can see.
async function profileDirOnPort(host, port, wsUrl) {
  // 1. free, when the browser happens to allow it
  if (wsUrl) {
    try {
      const cdp = await openCdp(wsUrl);
      try {
        const r = await cdp.send('Browser.getBrowserCommandLine', {});
        const argv = (r && Array.isArray(r.arguments)) ? r.arguments : [];
        const a = argv.find((x) => String(x).startsWith('--user-data-dir='));
        if (a) return String(a).slice('--user-data-dir='.length).replace(/^"|"$/g, '');
      } finally { try { cdp.close(); } catch { /* already closed */ } }
    } catch { /* fall through to the OS */ }
  }
  // 2. ask the operating system, which is always allowed to know
  if (process.platform !== 'win32') return '';
  // execFile, NOT execFileSync. The sync form blocks Node's event loop for as long as PowerShell
  // takes to start, and this runs inside launchChrome on the app's main thread. Measured
  // 2026-09-08: two agent runs sat at step 0 with no browser and no model call for ten minutes
  // apiece, because the whole loop was parked waiting on a subprocess.
  const { execFile } = require('child_process');
  const ps = `$c = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; `
    + 'if ($c) { (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $c.OwningProcess)).CommandLine }';
  const out = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
      (err, stdout) => finish(err ? '' : String(stdout || '')));
    // Belt and braces: if the callback never fires we still return, rather than leaving the
    // caller awaiting a promise that resolves never.
    setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish(''); }, 9000);
  });
  // Two shapes, and they need different rules. Chrome quotes the path when it contains a space and
  // leaves it bare otherwise, and both appear on this machine. A single ("?)([^"]+)\1 pattern reads
  // the bare form greedily and swallows the following argument — it returned
  // `C:\Users\laptop\chrome-default --no-first-run`, which matches no profile and so silently
  // refuses to adopt the very browser it was asked about.
  const m = /--user-data-dir=(?:"([^"\r\n]+)"|(\S+))/.exec(out);
  return m ? String(m[1] || m[2] || '').trim() : '';
}

// A port nobody is listening on. Tried by actually binding it, which is the only honest test.
function portIsFree(host, port) {
  return new Promise((resolve) => {
    const srv = require('net').createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}
async function findFreePort(host, from, span = 40) {
  for (let p = from + 1; p <= from + span; p++) {
    if (p > 65000) break;
    if (await portIsFree(host, p)) return p;
  }
  return null;
}

async function launchChrome(opts = {}) {
  const {
    profileId = 'default',
    port = 9222,
    host = '127.0.0.1',
    headless = false,
    chromePath = findChrome(),
    userDataDir = profileDir(profileId),
    extraArgs = [],
  } = opts;

  if (!chromePath) throw new Error('Chrome not found on this machine');
  fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    // Chrome 111+ refuses --remote-debugging-port on the default profile dir; ours is dedicated,
    // but this also stops a stray "restore pages?" bubble stealing the first click.
    '--hide-crash-restore-bubble',
    ...(headless ? ['--headless=new', '--disable-gpu'] : []),
    ...extraArgs,
    'about:blank',
  ];

  // IS SOMEBODY ELSE ALREADY ON THIS PORT?
  //
  // Ports are a hash of the profile id into 60 slots, so two people collide about 1.7% of the time.
  // But a stale Chrome from a previous run does it just as well, without any collision at all.
  //
  // Either way the failure is silent and bad: spawn starts a Chrome that CANNOT bind the debugging
  // port because it is taken, waitForCdp then succeeds because the OTHER browser answers, and the
  // belt drives somebody else's Chrome. With two people using this, that is an application going
  // out from the wrong person's logged-in accounts.
  //
  // We have not launched yet, so anything answering here is not ours. Refuse loudly. A false
  // refusal is recoverable and visible; a silent wrong-browser attachment is neither.
  // ...BUT "NOT OURS" AND "OURS, LEAKED" ARE DIFFERENT THINGS, and the comment above already named
  // both while treating them the same. Measured 2026-09-08: an agent run finished successfully,
  // left its browser running, and every subsequent run refused here. Reaping the leftover frees the
  // port but throws away the profile's Cloudflare clearance with it, so the next run hits the wall
  // instead - trading one failure for another.
  //
  // So: ask the browser on that port what user-data-dir it is running. Chrome answers over the
  // protocol itself (Browser.getBrowserCommandLine), no OS process spelunking. If it is OUR profile
  // it is our own leak and we ADOPT it, keeping the session and its cookies. Anything else, or any
  // failure to prove identity, still refuses exactly as before - the wrong-browser hazard is real
  // and proof is required to bypass it, never assumption.
  let existing = null;
  try { existing = await waitForCdp(host, port, 1200); } catch { /* free, as expected */ }
  if (existing) {
    const seen = await profileDirOnPort(host, port, existing.webSocketDebuggerUrl);
    const mine = !!seen && path.resolve(seen) === path.resolve(userDataDir);
    if (!seen) log.warn(`could not identify the Chrome on port ${port}`);
    if (mine) {
      // Ours. Adopting is strictly better than killing it: the profile keeps whatever the human did
      // in it, which on Indeed is the difference between a working session and another CAPTCHA wall.
      log.info(`adopting our own leaked chrome profile=${profileId} port=${port}`);
      return { proc: null, adopted: true, port, host, userDataDir, chromePath };
    }
    // NOT PROVABLY OURS: RELOCATE, DO NOT REFUSE. Someone else's Chrome (or one we cannot identify)
    // on the port is no reason to stop the whole lane and raise a human block. Nothing is closed or
    // touched; we simply launch our own browser on the next FREE port and attach to that one. The
    // caller must use the returned handle.port, never the port it asked for.
    const alt = opts.noRelocate ? null : await findFreePort(host, port);
    if (!alt) {
      throw new Error(`port ${port} is already serving a Chrome that is not ours (profile ${profileId}). `
        + (seen ? `It is running ${seen}. ` : 'Its identity could not be proven. ')
        + 'No free automation port was found either. Refusing rather than driving a '
        + 'session that is not ours.');
    }
    log.warn(`port ${port} is held by a Chrome that is not ours; relocating profile=${profileId} to ${alt}`);
    return launchChrome({ ...opts, port: alt, noRelocate: true });
  }

  const proc = spawn(chromePath, args, { stdio: 'ignore', detached: false });
  proc.on('error', (e) => log.error('chrome spawn failed', e.message));

  try {
    await waitForCdp(host, port);
  } catch (e) {
    try { proc.kill(); } catch { /* already gone */ }
    throw e;
  }
  log.info(`chrome up profile=${profileId} port=${port} headless=${headless}`);
  return { proc, port, host, userDataDir, chromePath };
}

async function killChrome(handle) {
  if (!handle) return;
  const { proc, host = '127.0.0.1', port } = handle;
  // NEVER CLOSE A BROWSER WE ADOPTED. We did not open it, and the whole reason adopting beats
  // killing is that the profile carries state a human paid for - a signed-in Indeed session, a
  // Cloudflare clearance cookie. Closing it here would hand back exactly the wall that adoption
  // exists to avoid, and the next run would ask Pierre to solve another CAPTCHA.
  if (handle.adopted) {
    if (log && log.info) log.info(`leaving the adopted chrome on port ${port} running`);
    return;
  }
  // Ask politely first so the profile is flushed cleanly, then make sure.
  try { await cdpHttp(host, port, '/json/close'); } catch { /* not fatal */ }
  try { proc && proc.kill(); } catch { /* already gone */ }
  await sleep(150);
  try { if (proc && !proc.killed) proc.kill('SIGKILL'); } catch { /* fine */ }
}

// ---------------------------------------------------------------------------
// GREENHOUSE EMBEDS
//
// Many companies (Lyft/careerpuck, Stripe, D2L, Samsara, Databricks, Brex, Elastic, Pinterest,
// Coinbase, Asana ...) host the posting on their own page and drop Greenhouse's form in a
// cross-origin <iframe id="grnhse_iframe">. The accessibility tree of the TOP document never lists
// fields inside it, so read_page/find saw nothing to fill and 50+ runs parked. The form is
// addressable if we simply open the iframe's own URL as the top-level page, so do that.
// Pure function so it is testable without a browser.
// ---------------------------------------------------------------------------
function greenhouseEmbedUrl({ href = '', iframes = [], scripts = [] } = {}) {
  let u;
  try { u = new URL(href); } catch { return null; }
  // Already on Greenhouse's own form: nothing to unwrap.
  if (/(^|\.)greenhouse\.io$/i.test(u.hostname)) return null;
  const isJobApp = (x) => /greenhouse\.io\/embed\/job_app/i.test(String(x || ''));
  const direct = iframes.find(isJobApp);
  if (direct) { try { return new URL(direct, href).toString(); } catch { /* fall through */ } }
  const jid = u.searchParams.get('gh_jid') || u.searchParams.get('gh_jid[]');
  let board = null;
  for (const src of [...iframes, ...scripts]) {
    const m = /greenhouse\.io\/[^"'\s]*[?&]for=([A-Za-z0-9_-]+)/i.exec(String(src || ''));
    if (m) { board = m[1]; break; }
  }
  if (jid && board) {
    return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(board)}&token=${encodeURIComponent(jid)}`;
  }
  // careerpuck.com/job-board/<board>/job/<id> is a Greenhouse board wrapper.
  const cp = /^\/job-board\/([A-Za-z0-9_-]+)\/job\/(\d+)/.exec(u.pathname);
  if (/(^|\.)careerpuck\.com$/i.test(u.hostname) && cp) {
    return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(cp[1])}&token=${cp[2]}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Page session
// ---------------------------------------------------------------------------
async function listPages(host, port) {
  const all = await cdpHttp(host, port, '/json/list');
  return (Array.isArray(all) ? all : []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

// Attach to the first page target (or a specific one) and return the verb set.
async function attachPage(opts = {}) {
  const { host = '127.0.0.1', port = 9222, targetId = null, timeoutMs = 15000 } = opts;

  const deadline = Date.now() + timeoutMs;
  let target = null;
  while (Date.now() < deadline && !target) {
    const pages = await listPages(host, port);
    target = targetId ? pages.find((p) => p.id === targetId) : pages[0];
    if (!target) await sleep(150);
  }
  if (!target) throw new Error('no page target to attach to');

  const cdp = await openCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable', {});
  await cdp.send('DOM.enable', {});
  await cdp.send('Runtime.enable', {});
  await cdp.send('Accessibility.enable', {});

  // ref_N -> backendDOMNodeId, rebuilt on every readTree(). Refs are only valid for the tree that
  // produced them: a hydration wipe or a re-render invalidates them, which is exactly the trap
  // that cost three fields on the Greenhouse forms overnight. Callers re-read before acting.
  let refs = new Map();
  let refSeq = 0;
  // null means NO tree has been read on the current document. Empty-array would be
  // indistinguishable from "read it, matched nothing", and find() answering [] to both is how a
  // missing read_page gets misreported to the agent as a missing element.
  let lastTree = null;

  async function evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const r = await cdp.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue, includeCommandLineAPI: false,
    });
    if (r.exceptionDetails) {
      const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval failed';
      throw new Error(String(msg).split('\n')[0]);
    }
    return r.result ? r.result.value : undefined;
  }

  async function readyState() {
    try { return await evaluate('document.readyState'); } catch { return 'unknown'; }
  }

  // If this top-level page merely frames a Greenhouse form, open the form itself. Polls briefly
  // because the embed script injects the iframe after load. Never loops: one hop per document.
  let unwrappedFrom = '';
  async function unwrapEmbed({ waitMs = 4000 } = {}) {
    let href = '';
    try { href = await evaluate('location.href'); } catch { return null; }
    if (!href || href === unwrappedFrom || /^about:|^chrome/i.test(href)) return null;
    const deadline3 = Date.now() + waitMs;
    let target = null;
    for (;;) {
      let info = null;
      try {
        info = await evaluate(`(() => ({
          href: location.href,
          iframes: [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('src') || f.src || ''),
          scripts: [...document.querySelectorAll('script[src]')].map((f) => f.src),
        }))()`);
      } catch { return null; }
      target = greenhouseEmbedUrl(info);
      const mightEmbed = /[?&]gh_jid=/i.test(href) || /careerpuck\.com/i.test(href) || (info && info.iframes.some((x) => /greenhouse/i.test(x)));
      if (target || !mightEmbed || Date.now() > deadline3) break;
      await sleep(400);
    }
    if (waitMs > 0 || target) unwrappedFrom = href;
    if (!target || target === href) return null;
    log.info(`greenhouse embed: opening ${target} directly (was ${href})`);
    const res = await cdp.send('Page.navigate', { url: target });
    if (res.errorText) { log.warn(`greenhouse unwrap failed: ${res.errorText}`); return null; }
    lastTree = null;
    const dl = Date.now() + 20000;
    while (Date.now() < dl) { if (await readyState() === 'complete') break; await sleep(120); }
    await sleep(350);
    unwrappedFrom = await evaluate('location.href').catch(() => target);
    return target;
  }

  async function navigate(url, { waitMs = 20000, settleMs = 350 } = {}) {
    const res = await cdp.send('Page.navigate', { url });
    if (res.errorText) throw new Error(`navigate failed: ${res.errorText}`);
    // The old document is gone, and with it every ref in lastTree. Leaving it set let find()
    // answer from the PREVIOUS page and hand back refs into a destroyed document.
    lastTree = null;
    const deadline2 = Date.now() + waitMs;
    while (Date.now() < deadline2) {
      if (await readyState() === 'complete') break;
      await sleep(120);
    }
    await sleep(settleMs); // let first-paint / framework hydration land before anyone reads
    const unwrapped = await unwrapEmbed().catch(() => null);
    return { url: await evaluate('location.href'), ...(unwrapped ? { unwrappedFrom: url } : {}) };
  }

  // Flatten the accessibility tree into the shape the agent reasons over. This is the direct
  // replacement for the extension's read_page: role, accessible name, value, and a ref to act on.
  async function readTree({ interactiveOnly = false, max = 4000 } = {}) {
    await unwrapEmbed({ waitMs: 0 }).catch(() => null);   // the agent may have clicked into an embed page
    const { nodes = [] } = await cdp.send('Accessibility.getFullAXTree', {});
    refs = new Map();
    refSeq = 0;
    const INTERACTIVE = new Set([
      'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
      'menuitem', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textarea',
    ]);
    const out = [];
    for (const n of nodes) {
      if (out.length >= max) break;
      if (n.ignored) continue;
      const role = n.role?.value || '';
      const name = (n.name?.value || '').trim();
      const value = (n.value?.value ?? '').toString().trim();
      if (!role) continue;
      if (interactiveOnly && !INTERACTIVE.has(role)) continue;
      if (!interactiveOnly && !name && !value && !INTERACTIVE.has(role)) continue;
      const entry = { role, name, value };
      if (n.backendDOMNodeId) {
        const ref = `ref_${++refSeq}`;
        refs.set(ref, n.backendDOMNodeId);
        entry.ref = ref;
      }
      out.push(entry);
    }
    // A COMMITTED react-select READS AS EMPTY.
    //
    // Greenhouse keeps the chosen value in a rendered element and clears the input it searched
    // with, so the accessibility tree shows School, Degree and Discipline as blank AFTER they were
    // set. On a real Ritual run the agent filled all four type-ahead boxes, read the page, saw them
    // empty, and filled all four again, then ran out of budget on the second pass.
    //
    // One DOM query for the whole page, matched back by ref, rather than a call per node.
    try {
      const committed = await evaluate(`(() => {
        const out = {};
        for (const el of document.querySelectorAll('input[role="combobox"], input[aria-autocomplete]')) {
          let shown = null, box = el.parentElement;
          for (let i = 0; i < 4 && box && !shown; i++, box = box.parentElement) {
            shown = box.querySelector('[class*="singleValue"], [class*="single-value"], [class*="multiValue"], [class*="multi-value"]');
          }
          const text = shown && String(shown.textContent || '').trim();
          if (text) out[el.id || el.name || ''] = text;
        }
        return out;
      })()`);
      if (committed && Object.keys(committed).length) {
        for (const entry of out) {
          if (entry.role !== 'combobox' || entry.value) continue;
          const d = await describeRef(entry.ref).catch(() => null);
          const key = d && (d.id || d.name);
          if (key && committed[key]) entry.value = committed[key];
        }
      }
    } catch (e) { log.warn(`combobox value sweep failed: ${e.message}`); }

    lastTree = out;
    return out;
  }

  // Substring match over role + name + value against the most recent readTree(), mirroring the
  // extension's `find`. Returns entries that still carry a usable ref, best matches first.
  function find(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    if (lastTree === null) return null;   // no read_page since the last navigation
    const scored = [];
    for (const n of lastTree) {
      if (!n.ref) continue;
      const name = n.name.toLowerCase();
      const hay = `${n.role} ${name} ${n.value}`.toLowerCase();
      if (!hay.includes(q)) continue;
      // exact accessible name beats a prefix, which beats an incidental substring
      const rank = name === q ? 0 : name.startsWith(q) ? 1 : 2;
      scored.push({ rank, node: n });
    }
    scored.sort((a, b) => a.rank - b.rank);
    return scored.map((s) => s.node);
  }

  // Escape hatch for elements the accessibility tree cannot see. File inputs are the reason this
  // exists: they are almost always `class="hidden"` with `aria-hidden="true"` behind a styled
  // button, so they are absent from the AX tree entirely and `find()` can never reach them. That
  // is what made the Seequent/Cornerstone résumé field unreachable. Returns a ref or null.
  async function queryRef(selector) {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) return null;
    const { node } = await cdp.send('DOM.describeNode', { nodeId });
    if (!node || !node.backendNodeId) return null;
    const ref = `ref_q${++refSeq}`;
    refs.set(ref, node.backendNodeId);
    return ref;
  }

  async function queryRefAll(selector) {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeIds = [] } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
    const out = [];
    for (const nodeId of nodeIds) {
      const { node } = await cdp.send('DOM.describeNode', { nodeId });
      if (!node || !node.backendNodeId) continue;
      const ref = `ref_q${++refSeq}`;
      refs.set(ref, node.backendNodeId);
      out.push(ref);
    }
    return out;
  }

  // What IS this element? Tag, input type and the identifying attributes, straight from the DOM.
  // The accessibility tree deliberately does not tell you an input is type=password (it reports a
  // textbox), so any rule about credentials has to ask the DOM instead of the tree.
  async function describeRef(ref) {
    const backendNodeId = backendIdFor(ref);
    const { node } = await cdp.send('DOM.describeNode', { backendNodeId });
    const attrs = {};
    const a = node.attributes || [];
    for (let i = 0; i < a.length; i += 2) attrs[String(a[i]).toLowerCase()] = a[i + 1];
    return {
      tag: String(node.nodeName || '').toLowerCase(),
      type: String(attrs.type || '').toLowerCase(),
      name: attrs.name || '',
      id: attrs.id || '',
      ariaLabel: attrs['aria-label'] || '',
      autocomplete: String(attrs.autocomplete || '').toLowerCase(),
    };
  }

  // The text a control BELONGS to, not just its own label. A radio in a diversity survey is often
  // labelled only "Male" — harmless on its own, and only recognisable as something the agent must
  // not touch by reading the fieldset or heading above it. Walks up to the nearest container that
  // carries real text and returns it, capped.
  async function labelContext(ref, { max = 600 } = {}) {
    const backendNodeId = backendIdFor(ref);
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
    if (!object || !object.objectId) return '';
    try {
      const r = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration: `function () {
          const bits = [];
          const seen = new Set();
          const push = (t) => {
            const s = String(t || '').replace(/\\s+/g, ' ').trim();
            if (s && !seen.has(s)) { seen.add(s); bits.push(s); }
          };
          if (this.getAttribute) push(this.getAttribute('aria-label'));
          if (this.id) {
            const lab = document.querySelector('label[for="' + CSS.escape(this.id) + '"]');
            if (lab) push(lab.textContent);
          }
          let el = this;
          for (let i = 0; i < 6 && el; i++) {
            el = el.parentElement;
            if (!el) break;
            const legend = el.querySelector && el.querySelector(':scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > label, :scope > p');
            if (legend) push(legend.textContent);
            if (el.tagName === 'FIELDSET' || el.getAttribute('role') === 'group' || el.tagName === 'SECTION') {
              push((el.textContent || '').slice(0, 400));
              break;
            }
          }
          return bits.join(' | ').slice(0, ${Number(max)});
        }`,
      });
      return (r && r.result && r.result.value) || '';
    } finally {
      try { await cdp.send('Runtime.releaseObject', { objectId: object.objectId }); } catch { /* best effort */ }
    }
  }

  // ---------------------------------------------------------------------------
  // <select>
  //
  // `fill` types text. Typing into a <select> does nothing at all, silently, and every real
  // Greenhouse form has several: country, phone country, "how did you hear about us", location
  // preference. The fixture had none, which is why twelve green end-to-end runs never noticed.
  //
  // Setting `.value` alone is also not enough on a React form: the framework tracks its own copy of
  // the state and only updates it on the events a real user would produce. Same lesson as `fill`
  // always blurring, in a different shape.
  // ---------------------------------------------------------------------------
  async function onNode(ref, functionDeclaration, args = []) {
    const backendNodeId = backendIdFor(ref);
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
    if (!object || !object.objectId) throw new Error('that element is gone from the page');
    try {
      const r = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
      });
      if (r && r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'page threw');
      return r && r.result && r.result.value;
    } finally {
      try { await cdp.send('Runtime.releaseObject', { objectId: object.objectId }); } catch { /* best effort */ }
    }
  }

  async function isSelectRef(ref) {
    try { return await onNode(ref, 'function () { return this.tagName === "SELECT"; }') === true; }
    catch { return false; }
  }

  async function listOptions(ref) {
    return (await onNode(ref, `function () {
      if (this.tagName !== 'SELECT') return null;
      return [...this.options].map((o) => String(o.textContent || o.value || '').trim()).filter(Boolean);
    }`)) || null;
  }

  // Matches on the visible option text, then the value, exactly first and then as a substring.
  // Returns the option it chose, or null with the list so the caller can say what IS available.
  async function selectOption(ref, wanted) {
    await scrollIntoView(ref);
    return onNode(ref, `function (want) {
      if (this.tagName !== 'SELECT') return { ok: false, notASelect: true };
      const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const w = norm(want);
      const opts = [...this.options];
      const pick = opts.find((o) => norm(o.textContent) === w || norm(o.value) === w)
        || opts.find((o) => norm(o.textContent).includes(w) && w.length > 1)
        || opts.find((o) => w.includes(norm(o.textContent)) && norm(o.textContent).length > 1);
      if (!pick) return { ok: false, options: opts.map((o) => String(o.textContent || '').trim()).filter(Boolean).slice(0, 40) };
      this.value = pick.value;
      // The events a real user's choice produces. Without them a React form keeps its old state.
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      this.blur();
      return { ok: true, chose: String(pick.textContent || pick.value).trim() };
    }`, [String(wanted)]);
  }

  // ---------------------------------------------------------------------------
  // The combobox
  //
  // Greenhouse renders School, Degree, Discipline and "how did you hear about us" as an <input>
  // with an autocomplete listbox, not a <select>. Typing into one puts text on screen and commits
  // NOTHING: the form only takes a value when an option from the popup is chosen. So `fill`
  // succeeds, the field reads back empty, and the agent tries again.
  //
  // Live on a real Ritual application: eight calls to my_resume, the same field filled twice, and
  // the run burned its whole step budget on a field it could not set.
  // ---------------------------------------------------------------------------
  async function isComboRef(ref) {
    try {
      return await onNode(ref, `function () {
        if (this.tagName !== 'INPUT') return false;
        const r = this.getAttribute('role');
        return r === 'combobox' || this.hasAttribute('aria-autocomplete') || this.hasAttribute('aria-controls')
          || this.getAttribute('autocomplete') === 'off' && !!this.getAttribute('aria-expanded');
      }`) === true;
    } catch { return false; }
  }

  // Type with REAL KEYSTROKES, let the listbox appear, then CHOOSE.
  //
  // Greenhouse's School, Degree and Discipline are react-select, and react-select opens its menu
  // on keydown. `Input.insertText` puts the characters in the box and fires no key events at all,
  // so on the real Ritual form the value read "Toronto Metro", aria-expanded stayed false, and no
  // menu ever appeared. Typed as keystrokes, the same field expanded and offered "University of
  // Toronto" inside a second and a half. Clearing goes the same way: select-all and Backspace,
  // because setting .value on a React-controlled input is invisible to React's own state.
  async function typeKeys(text) {
    for (const ch of String(text)) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
  }

  async function pickSuggestion(ref, text, { waitMs = 1500 } = {}) {
    await scrollIntoView(ref);
    await focus(ref);
    // Select-all + Backspace, so a second attempt does not type "BachelorBachelor".
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await typeKeys(text);
    await new Promise((r) => setTimeout(r, waitMs));

    return onNode(ref, `function (want) {
      const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const w = norm(want);
      const listId = this.getAttribute('aria-controls') || this.getAttribute('aria-owns');
      const scope = (listId && document.getElementById(listId)) || document;
      const seen = [...scope.querySelectorAll('[role="option"]')]
        .filter((o) => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (!seen.length) return { ok: false, noList: true, typed: this.value };
      // A loose match must contain EVERY significant word of what was asked for. Matching on any
      // one substring turned "Metropolitan" into "Inter American University of Puerto Rico -
      // Metropolitan Campus" on the real Ritual form, which would have been a false statement of
      // fact on his application.
      // And a ONE-word query satisfies "every word" trivially: "Metropolitan" still chose the
      // Puerto Rico campus. A single word matches exactly or not at all. Anything looser hands the
      // options back for the agent to name one.
      const words = w.split(' ').filter((t) => t.length > 2);
      const allWords = (o) => { const n = norm(o.textContent); return words.length >= 2 && words.every((t) => n.includes(t)); };
      const pick = seen.find((o) => norm(o.textContent) === w)
        || seen.find(allWords)
        || null;
      const options = seen.slice(0, 12).map((o) => String(o.textContent || '').trim());
      if (!pick) return { ok: false, options, typed: this.value };
      const label = String(pick.textContent || '').trim();
      // react-select commits on mousedown, not on click.
      for (const type of ['mousedown', 'mouseup', 'click']) {
        pick.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return { ok: true, chose: label, options };
    }`, [String(text)]);
  }

  async function isPasswordRef(ref) {
    const d = await describeRef(ref);
    if (d.type === 'password') return true;
    // A site that hides the type still gives itself away in the name, id or autocomplete hint.
    return /(^|[^a-z])(password|passwd|pwd|passcode)([^a-z]|$)/i.test(`${d.name} ${d.id} ${d.ariaLabel}`)
      || /current-password|new-password/.test(d.autocomplete);
  }

  function backendIdFor(ref) {
    const id = refs.get(ref);
    if (!id) throw new Error(`unknown ref ${ref} — re-read the tree before acting`);
    return id;
  }

  // Centre point of an element, in viewport CSS pixels.
  async function boxCenter(ref) {
    const backendNodeId = backendIdFor(ref);
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId });
    const q = model.content; // x1,y1,x2,y2,x3,y3,x4,y4
    return { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2, width: model.width, height: model.height };
  }

  async function scrollIntoView(ref) {
    const backendNodeId = backendIdFor(ref);
    try { await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }); } catch { /* best effort */ }
  }

  // A CONTROL WITH NO BOX IS CLICKED BY ITS LABEL.
  //
  // Ashby and Lever both render consent boxes as a styled control whose real <input> is visually
  // hidden (opacity 0, zero size, or off-screen). Recon on 2026-09-05 found 2 such checkboxes on
  // Ashby and 18 checkboxes plus 11 radios on Lever. click() dispatches a real mouse event at the
  // element's box centre, and a hidden input has no usable box, so the event lands nowhere and the
  // box stays unticked in silence. That is exactly how a required consent gets missed.
  //
  // A person does not click the input either. They click the label. So do that: hand the label
  // back as the thing to click, which the browser then forwards to the control.
  async function labelTargetFor(ref) {
    try {
      const found = await onNode(ref, `function () {
        const r = this.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return null;          // it has a box, click it normally
        const labels = [];
        if (this.id) {
          const l = document.querySelector('label[for="' + CSS.escape(this.id) + '"]');
          if (l) labels.push(l);
        }
        const wrapping = this.closest('label');
        if (wrapping) labels.push(wrapping);
        for (const l of labels) {
          const lr = l.getBoundingClientRect();
          if (lr.width > 0 && lr.height > 0) {
            l.scrollIntoView({ block: 'center' });
            const b = l.getBoundingClientRect();
            return { x: b.left + b.width / 2, y: b.top + b.height / 2, via: l.textContent.trim().slice(0, 40) };
          }
        }
        return { none: true };
      }`);
      return found;
    } catch { return null; }
  }

  async function click(target) {
    let x, y;
    if (typeof target === 'string') {
      const viaLabel = await labelTargetFor(target);
      if (viaLabel && viaLabel.none) {
        throw new Error('that control is not visible and has no clickable label, so it cannot be clicked');
      }
      if (viaLabel && typeof viaLabel.x === 'number') {
        const base2 = { x: viaLabel.x, y: viaLabel.y, button: 'left', clickCount: 1, buttons: 1 };
        await cdp.send('Input.dispatchMouseEvent', { ...base2, type: 'mouseMoved', buttons: 0 });
        await cdp.send('Input.dispatchMouseEvent', { ...base2, type: 'mousePressed' });
        await cdp.send('Input.dispatchMouseEvent', { ...base2, type: 'mouseReleased', buttons: 0 });
        return { x: viaLabel.x, y: viaLabel.y, viaLabel: viaLabel.via };
      }
      await scrollIntoView(target);
      ({ x, y } = await boxCenter(target));
    } else {
      ({ x, y } = target);
    }
    const base = { x, y, button: 'left', clickCount: 1, buttons: 1 };
    await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
    return { x, y };
  }

  async function focus(ref) {
    await cdp.send('DOM.focus', { backendNodeId: backendIdFor(ref) });
  }

  async function pressKey(key) {
    const MAP = {
      Tab: { windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab', text: '\t' },
      Enter: { windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', text: '\r' },
      Escape: { windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' },
      Backspace: { windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' },
    };
    const k = MAP[key];
    if (!k) throw new Error(`unsupported key ${key}`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
  }

  // Focus, insert, then BLUR. The blur is not optional: Ashby keeps form state outside the DOM and
  // only commits on blur, which is why two submits were rejected overnight for a "missing" phone
  // number that was visibly present. Making it part of fill() means it can never be forgotten.
  async function fill(ref, text, { blur = true } = {}) {
    await scrollIntoView(ref);
    await focus(ref);
    await cdp.send('Input.insertText', { text: String(text) });
    if (blur) await pressKey('Tab');
    return true;
  }

  // A REAL file on the input, set at the browser level — not a synthetic change event. This is the
  // distinguishing property: page code can read the bytes back through FileReader.
  async function setFiles(ref, files) {
    const list = (Array.isArray(files) ? files : [files]).map((f) => path.resolve(f));
    for (const f of list) if (!fs.existsSync(f)) throw new Error(`file not found: ${f}`);
    await cdp.send('DOM.setFileInputFiles', { backendNodeId: backendIdFor(ref), files: list });
    return list;
  }

  async function screenshot({ format = 'jpeg', quality = 70, savePath = null } = {}) {
    const params = format === 'jpeg' ? { format, quality } : { format };
    const { data } = await cdp.send('Page.captureScreenshot', params);
    if (savePath) {
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      fs.writeFileSync(savePath, Buffer.from(data, 'base64'));
    }
    return { base64: data, savedTo: savePath, bytes: Buffer.from(data, 'base64').length };
  }

  async function text({ max = 20000 } = {}) {
    const t = await evaluate('(document.body && document.body.innerText) || ""');
    return String(t || '').slice(0, max);
  }

  return {
    targetId: target.id,
    raw: cdp,
    navigate, unwrapEmbed, readTree, find, queryRef, queryRefAll, describeRef, isPasswordRef, labelContext,
    click, focus, fill, pressKey, setFiles,
    screenshot, evaluate, text, boxCenter, scrollIntoView, readyState,
    isSelectRef, listOptions, selectOption, isComboRef, pickSuggestion,
    refCount: () => refs.size,
    close() { cdp.close(); },
  };
}

module.exports = {
  findChrome, profileDir, setProfileRoot, profileRoot, profileIsInitialised,
  launchChrome, killChrome, attachPage, greenhouseEmbedUrl, findFreePort, listPages, waitForCdp,
};
