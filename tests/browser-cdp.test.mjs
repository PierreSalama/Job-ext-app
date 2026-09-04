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
