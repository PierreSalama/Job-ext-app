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
  // Ask politely first so the profile is flushed cleanly, then make sure.
  try { await cdpHttp(host, port, '/json/close'); } catch { /* not fatal */ }
  try { proc && proc.kill(); } catch { /* already gone */ }
  await sleep(150);
  try { if (proc && !proc.killed) proc.kill('SIGKILL'); } catch { /* fine */ }
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
  let lastTree = [];

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

  async function navigate(url, { waitMs = 20000, settleMs = 350 } = {}) {
    const res = await cdp.send('Page.navigate', { url });
    if (res.errorText) throw new Error(`navigate failed: ${res.errorText}`);
    const deadline2 = Date.now() + waitMs;
    while (Date.now() < deadline2) {
      if (await readyState() === 'complete') break;
      await sleep(120);
    }
    await sleep(settleMs); // let first-paint / framework hydration land before anyone reads
    return { url: await evaluate('location.href') };
  }

  // Flatten the accessibility tree into the shape the agent reasons over. This is the direct
  // replacement for the extension's read_page: role, accessible name, value, and a ref to act on.
  async function readTree({ interactiveOnly = false, max = 4000 } = {}) {
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
    lastTree = out;
    return out;
  }

  // Substring match over role + name + value against the most recent readTree(), mirroring the
  // extension's `find`. Returns entries that still carry a usable ref, best matches first.
  function find(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
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

  // Type, let the listbox appear, then CHOOSE. Returns what it chose, or the options it saw.
  async function pickSuggestion(ref, text, { waitMs = 700 } = {}) {
    await scrollIntoView(ref);
    await focus(ref);
    // Clear whatever a previous attempt typed, or the query becomes "BachelorBachelor".
    await onNode(ref, `function () {
      this.value = '';
      this.dispatchEvent(new Event('input', { bubbles: true }));
    }`);
    await cdp.send('Input.insertText', { text: String(text) });
    await onNode(ref, `function () { this.dispatchEvent(new Event('input', { bubbles: true })); }`);
    await new Promise((r) => setTimeout(r, waitMs));

    return onNode(ref, `function (want) {
      const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const w = norm(want);
      const listId = this.getAttribute('aria-controls') || this.getAttribute('aria-owns');
      const scope = (listId && document.getElementById(listId)) || document;
      const seen = [...scope.querySelectorAll('[role="option"], li[id], [class*="option"]')]
        .filter((o) => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (!seen.length) return { ok: false, noList: true };
      const pick = seen.find((o) => norm(o.textContent) === w)
        || seen.find((o) => norm(o.textContent).includes(w) && w.length > 1)
        || seen[0];
      const label = String(pick.textContent || '').trim();
      // A real click, because these widgets listen for mousedown and not for a synthetic change.
      for (const type of ['mousedown', 'mouseup', 'click']) {
        pick.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return { ok: true, chose: label, options: seen.slice(0, 12).map((o) => String(o.textContent || '').trim()) };
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

  async function click(target) {
    let x, y;
    if (typeof target === 'string') {
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
    navigate, readTree, find, queryRef, queryRefAll, describeRef, isPasswordRef, labelContext,
    click, focus, fill, pressKey, setFiles,
    screenshot, evaluate, text, boxCenter, scrollIntoView, readyState,
    isSelectRef, listOptions, selectOption, isComboRef, pickSuggestion,
    refCount: () => refs.size,
    close() { cdp.close(); },
  };
}

module.exports = {
  findChrome, profileDir, setProfileRoot, profileRoot, profileIsInitialised,
  launchChrome, killChrome, attachPage, listPages, waitForCdp,
};
