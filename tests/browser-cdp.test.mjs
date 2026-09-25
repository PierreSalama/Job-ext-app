// AI Apply chunk 1 — the CDP browser harness.
//
// Launches a REAL Chrome on a dedicated profile + port and drives it: navigate, read the
// accessibility tree, find, click, fill (with the mandatory blur), attach a file, screenshot.
//
// The upload test is the one that matters most. It does not just assert a filename landed — it
// reads the FILE BYTES BACK through FileReader inside the page. A synthetic change event cannot
// do that, and that difference is exactly what blocked the Seequent/Cornerstone application.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cdpMod = require(path.join(here, '..', 'app', 'src', 'browser', 'cdp.js'));

const PORT = 9333; // deliberately not 9222 — must not collide with a Chrome a human is using
const chromePath = cdpMod.findChrome();

// ---- pure logic (always runs, no browser needed) --------------------------
test('profileDir isolates per person and never touches the real Chrome profile', () => {
  const a = cdpMod.profileDir('pierre');
  const b = cdpMod.profileDir('dad');
  assert.notEqual(a, b, 'two people must not share a user-data-dir');
  // Asserts the PROPERTY, not a hardcoded path: chunk 10 moved these out of %TEMP% (which Windows
  // cleans, losing the logins) into the app's own data folder. What must stay true is that they
  // live under our configured root and never inside the human's real Chrome profile.
  assert.equal(path.dirname(a), cdpMod.profileRoot(), 'must live under our own directory');
  assert.doesNotMatch(a, /Google[\\/]Chrome[\\/]User Data/i, 'must never be the human profile');
});

test('profileDir sanitizes an unsafe profile id', () => {
  const p = cdpMod.profileDir('../../etc/passwd');
  assert.doesNotMatch(path.basename(p), /[\\/.]{2}/, 'no traversal in the directory name');
});

test('waitForCdp fails fast and honestly on a dead port', async () => {
  await assert.rejects(
    () => cdpMod.waitForCdp('127.0.0.1', 1, 600),
    /CDP never came up/,
  );
});

// ---- real browser -----------------------------------------------------------
const describeBrowser = chromePath ? test : test.skip;

describeBrowser('CDP harness drives a real Chrome end to end', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-cdp-test-'));
  const fixture = path.join(tmp, 'form.html');
  const upload = path.join(tmp, 'resume-sample.txt');
  const uploadBody = 'PIERRE-SALAMA-RESUME-BYTES-9f3a17';
  fs.writeFileSync(upload, uploadBody, 'utf8');

  // A miniature of the forms we actually meet: a labelled text input, a file input, a submit
  // button, and a status line the page itself updates so we can prove the click was real.
  fs.writeFileSync(fixture, `<!doctype html><html><head><meta charset="utf-8"><title>Harness Fixture</title></head>
<body>
  <h1>Application</h1>
  <label for="phone">Phone number</label>
  <input id="phone" type="text" aria-label="Phone number" />
  <label for="cv">Resume</label>
  <input id="cv" type="file" aria-label="Resume" />
  <!-- The Cornerstone shape: a real file input hidden behind a styled button, invisible to a11y. -->
  <input id="cvHidden" type="file" class="hidden" aria-hidden="true" tabindex="-1" style="display:none" />
  <button id="fakeUpload" type="button">Upload r&eacute;sum&eacute;/CV</button>
  <button id="go" type="button" onclick="document.getElementById('status').textContent='SUBMITTED'">Submit Application</button>
  <p id="status">idle</p>
  <script>
    window.__blurCount = 0;
    document.getElementById('phone').addEventListener('blur', () => { window.__blurCount++; });
    window.__readBack = () => new Promise((res) => {
      const f = document.getElementById('cv').files[0];
      if (!f) return res(null);
      const r = new FileReader();
      r.onload = () => res({ name: f.name, size: f.size, text: r.result });
      r.readAsText(f);
    });
  </script>
</body></html>`, 'utf8');

  const handle = await cdpMod.launchChrome({
    profileId: 'test-harness', port: PORT, headless: true,
  });
  let page;
  try {
    page = await cdpMod.attachPage({ port: PORT });

    await t.test('navigates and reports the settled URL', async () => {
      const r = await page.navigate('file:///' + fixture.replace(/\\/g, '/'));
      assert.match(r.url, /form\.html$/);
      assert.equal(await page.readyState(), 'complete');
    });

    await t.test('reads an accessibility tree with usable refs', async () => {
      const tree = await page.readTree();
      assert.ok(tree.length > 0, 'tree must not be empty');
      assert.ok(tree.some((n) => n.ref), 'at least one node must carry a ref');
      assert.ok(
        tree.some((n) => /Submit Application/i.test(n.name)),
        'the submit button must appear by its accessible name',
      );
    });

    await t.test('find ranks an exact accessible-name match first', async () => {
      await page.readTree();
      const hits = page.find('Phone number');
      assert.ok(hits.length > 0, 'must find the phone field');
      assert.equal(hits[0].role, 'textbox');
      assert.equal(hits[0].name, 'Phone number');
    });

    await t.test('find returns nothing for an absent label, rather than guessing', async () => {
      await page.readTree();
      assert.equal(page.find('Social insurance number').length, 0);
    });

    // Found 2026-09-07 doing read-only recon on a live Workable posting. `find` answers from
    // `lastTree`, which only readTree writes and NOTHING used to clear. So after navigating to a
    // new job, find kept answering from the PREVIOUS page and handed back refs into a document
    // that no longer exists — a click on one of those is a click on nothing, or worse on whatever
    // the stale backendNodeId now resolves to. And with no tree read at all it returned an empty
    // array, which the tool layer reported as "no match, the label may differ", sending the agent
    // hunting for a wording problem instead of calling read_page.
    await t.test('navigating invalidates the tree so find cannot answer from the old page', async () => {
      const other = path.join(tmp, 'other.html');
      fs.writeFileSync(other, '<!doctype html><html><head><meta charset="utf-8"><title>Other</title></head>'
        + '<body><button type="button">Totally Different Button</button></body></html>', 'utf8');

      await page.readTree();
      assert.ok(page.find('Submit Application').length > 0, 'precondition: found on the first page');

      await page.navigate('file:///' + other.replace(/\\/g, '/'));
      assert.equal(page.find('Submit Application'), null,
        'after a navigation find must say "nothing read yet", not serve the old page');
      assert.equal(page.find('Totally Different Button'), null,
        'that is true for labels on the NEW page too, until it is read');

      await page.readTree();
      assert.equal(page.find('Submit Application').length, 0,
        'once read, a label that is genuinely gone is an empty array, not null');
      assert.ok(page.find('Totally Different Button').length > 0, 'and the new page is findable');

      await page.navigate('file:///' + fixture.replace(/\\/g, '/'));
      await page.readTree();
    });

    // THE REQUIRED CONSENT BOX. Ashby and Lever hide the real <input> and paint a styled box next
    // to a label; the input has no rect at all, so a click at its centre lands nowhere and reports
    // success. A required consent box that never ticks is an application that silently will not
    // submit. This behaviour was covered only by two regexes over cdp.js — which cannot tell you
    // whether the box actually ends up checked.
    await t.test('a hidden consent box is ticked through its label, and an orphan one is refused', async () => {
      const consent = path.join(tmp, 'consent.html');
      fs.writeFileSync(consent, '<!doctype html><html><head><meta charset="utf-8"><title>Consent</title></head><body>'
        // wrapping label, the Ashby shape
        + '<label><input id="wrapped" type="checkbox" required style="display:none"> I agree to the privacy policy</label>'
        // label[for=...], the Lever shape
        + '<input id="forred" type="checkbox" required style="display:none">'
        + '<label for="forred">I consent to being contacted</label>'
        // no box AND no label: must be refused loudly
        + '<input id="orphan" type="checkbox" style="display:none">'
        // an ordinary visible checkbox must still be clicked directly
        + '<label for="plain">Subscribe</label><input id="plain" type="checkbox">'
        + '</body></html>', 'utf8');
      await page.navigate('file:///' + consent.replace(/\\/g, '/'));

      const checked = (sel) => page.evaluate("document.querySelector('" + sel + "').checked");

      for (const [id, shape] of [['wrapped', 'a wrapping label'], ['forred', 'a label[for]']]) {
        const ref = await page.queryRef('#' + id);
        assert.ok(ref, `precondition: ${id} is reachable by selector`);
        assert.equal(await checked('#' + id), false, 'precondition: it starts unchecked');
        const r = await page.click(ref);
        assert.ok(r && r.viaLabel, `${shape} must be what got clicked, not the invisible input`);
        assert.equal(await checked('#' + id), true,
          `THE POINT: the required consent box must actually end up checked (${shape})`);
      }

      const orphan = await page.queryRef('#orphan');
      await assert.rejects(() => page.click(orphan), /no clickable label/,
        'with no box and no label it must fail loudly, not report a click that did nothing');
      assert.equal(await checked('#orphan'), false);

      // A control that HAS a box is still clicked normally — the label path must not take over.
      const plain = await page.queryRef('#plain');
      const pr = await page.click(plain);
      assert.ok(!pr || !pr.viaLabel, 'a visible checkbox must be clicked directly, not via its label');
      assert.equal(await checked('#plain'), true);

      await page.navigate('file:///' + fixture.replace(/\\/g, '/'));
      await page.readTree();
    });

    await t.test('fill types the value AND blurs, so framework state commits', async () => {
      await page.readTree();
      const ref = page.find('Phone number')[0].ref;
      await page.fill(ref, '+1 647 963 7745');
      assert.equal(await page.evaluate('document.getElementById("phone").value'), '+1 647 963 7745');
      const blurs = await page.evaluate('window.__blurCount');
      assert.ok(blurs >= 1, 'fill() must blur — the Ashby submit rejection came from not blurring');
    });

    await t.test('attaches a REAL file whose bytes the page can read back', async () => {
      await page.readTree();
      const ref = page.find('Resume')[0].ref;
      await page.setFiles(ref, upload);
      const got = await page.evaluate('window.__readBack()');
      assert.ok(got, 'the input must actually hold a file');
      assert.equal(got.name, 'resume-sample.txt');
      assert.equal(got.size, Buffer.byteLength(uploadBody));
      assert.equal(got.text, uploadBody, 'FileReader must return the real bytes, not a stub');
    });

    await t.test('setFiles refuses a path that does not exist', async () => {
      await page.readTree();
      const ref = page.find('Resume')[0].ref;
      await assert.rejects(() => page.setFiles(ref, path.join(tmp, 'nope.pdf')), /file not found/);
    });

    // The Cornerstone case, reproduced. This is the trap that made the Seequent résumé field
    // unreachable overnight: the real input is aria-hidden, so no amount of tree-reading finds it.
    await t.test('the a11y tree genuinely CANNOT see an aria-hidden file input', async () => {
      const tree = await page.readTree();
      const viaTree = tree.filter((n) => /cvHidden/i.test(n.name) || /Upload r/i.test(n.value || ''));
      assert.equal(viaTree.length, 0, 'the hidden input must be absent from the tree');
      assert.equal(page.find('cvHidden').length, 0, 'find() must not reach it either');
    });

    await t.test('queryRef reaches the hidden input and attaches a real file to it', async () => {
      const ref = await page.queryRef('#cvHidden');
      assert.ok(ref, 'queryRef must resolve a CSS selector the tree cannot see');
      await page.setFiles(ref, upload);
      const got = await page.evaluate(
        '(() => { const f = document.getElementById("cvHidden").files[0]; return f ? f.name + ":" + f.size : null; })()',
      );
      assert.equal(got, `resume-sample.txt:${Buffer.byteLength(uploadBody)}`);
    });

    await t.test('queryRef returns null for a selector that matches nothing', async () => {
      assert.equal(await page.queryRef('#definitely-not-here'), null);
    });

    await t.test('queryRefAll finds every file input on the page', async () => {
      const refs = await page.queryRefAll('input[type=file]');
      assert.equal(refs.length, 2, 'both the visible and the hidden input must be reachable');
    });

    await t.test('click actually fires the page handler', async () => {
      await page.readTree();
      const ref = page.find('Submit Application')[0].ref;
      assert.equal(await page.evaluate('document.getElementById("status").textContent'), 'idle');
      await page.click(ref);
      assert.equal(await page.evaluate('document.getElementById("status").textContent'), 'SUBMITTED');
    });

    await t.test('a stale ref is refused loudly instead of clicking the wrong thing', async () => {
      await assert.rejects(() => page.click('ref_99999'), /unknown ref/);
    });

    await t.test('captures a screenshot with real bytes', async () => {
      const shot = path.join(tmp, 'shot.jpg');
      const r = await page.screenshot({ savePath: shot });
      assert.ok(r.bytes > 1000, 'screenshot must not be empty');
      assert.ok(fs.existsSync(shot));
      assert.equal(fs.readFileSync(shot).slice(0, 2).toString('hex'), 'ffd8', 'must be a real JPEG');
    });

    await t.test('reads visible page text', async () => {
      const t2 = await page.text();
      assert.match(t2, /Application/);
      assert.match(t2, /SUBMITTED/);
    });
  } finally {
    try { page && page.close(); } catch { /* closing anyway */ }
    await cdpMod.killChrome(handle);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  }
});

test('two profiles get two separate browsers on two ports', { skip: !chromePath }, async () => {
  const a = await cdpMod.launchChrome({ profileId: 'pierre', port: 9334, headless: true });
  const b = await cdpMod.launchChrome({ profileId: 'dad', port: 9335, headless: true });
  try {
    assert.notEqual(a.userDataDir, b.userDataDir);
    const pa = await cdpMod.listPages('127.0.0.1', 9334);
    const pb = await cdpMod.listPages('127.0.0.1', 9335);
    assert.ok(pa.length > 0 && pb.length > 0, 'both browsers must expose a page target');
  } finally {
    await cdpMod.killChrome(a);
    await cdpMod.killChrome(b);
  }
});

test('a browser we cannot prove is ours on our port is left alone and we relocate to a free port', async () => {
  // Old behaviour refused and raised a human block ("Chrome already running on the automation port").
  // Now nothing is killed or driven: we launch our own Chrome on the next free port and report it.
  const http = await import('node:http');
  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'Content-Type': 'application/json' });
    r.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:9297/devtools/browser/x' }));
  });
  await new Promise((r) => srv.listen(9297, '127.0.0.1', r));
  let h;
  try {
    h = await cdpMod.launchChrome({ profileId: 'guard-test', port: 9297, headless: true });
    assert.notEqual(h.port, 9297, 'must not drive or share the foreign port');
    assert.ok(h.port > 9297, 'relocated to a higher free port');
    assert.ok(!h.adopted);
    const pages = await cdpMod.listPages('127.0.0.1', h.port);
    assert.ok(pages.length > 0, 'our own browser answers on the new port');
  } finally {
    if (h) await cdpMod.killChrome(h);
    await new Promise((r) => srv.close(r));
  }
  // With relocation disabled the old refusal still holds.
  const srv2 = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:9297/x' })); });
  await new Promise((r) => srv2.listen(9297, '127.0.0.1', r));
  try {
    await assert.rejects(
      () => cdpMod.launchChrome({ profileId: 'guard-test', port: 9297, headless: true, noRelocate: true }),
      /already serving a Chrome that is not ours/);
  } finally { await new Promise((r) => srv2.close(r)); }
});

test('the staleness probe uses a SHORT timeout, not the launch one', () => {
  // waitForCdp takes a number, not an options object. Passing { timeoutMs: 1200 } makes the
  // deadline NaN, the loop never runs, the probe always reports "free", and the guard silently
  // never fires while looking exactly like it works. That was the first version of this.
  const src = fs.readFileSync(new URL('../app/src/browser/cdp.js', import.meta.url), 'utf8');
  assert.match(src, /await waitForCdp\(host, port, 1200\)/);
  assert.doesNotMatch(src, /waitForCdp\([^)]*\{\s*timeoutMs/, 'never pass an options object here');
});

test('two profiles get separate Chrome user-data directories', () => {
  // Separate ledgers are useless if both people share one logged-in browser.
  const a = cdpMod.profileDir('prof_aaaa1111-2222-3333-4444-555566667777');
  const b = cdpMod.profileDir('prof_bbbb1111-2222-3333-4444-555566667777');
  assert.notEqual(a, b);
  assert.match(a, /chrome-prof_aaaa1111/);
});
