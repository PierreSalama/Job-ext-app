// AI Apply chunk 4 — the browser tool belt.
//
// Every verb is exercised against a real Chrome: a local fixture shaped like the ATS forms the
// overnight run actually met (hidden file input, password field, hydration-style re-render), plus
// one READ-ONLY pass over a live Greenhouse form so the belt is proven against the real thing.
// Nothing is ever submitted anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const bt = require(path.join(root, 'app', 'src', 'ai', 'tools', 'browser.js'));
const cdpMod = require(path.join(root, 'app', 'src', 'browser', 'cdp.js'));
const loop = require(path.join(root, 'app', 'src', 'ai', 'agent-loop.js'));

const chromePath = cdpMod.findChrome();
const PORT = 9345;

// ---- pure policy (no browser needed) ---------------------------------------
test('navigate refuses anything that is not http(s)', () => {
  assert.equal(bt.assertWebUrl('https://example.com/x'), 'https://example.com/x');
  for (const bad of ['file:///C:/Users/pierr/.ssh/id_rsa', 'data:text/html,<b>hi', 'javascript:alert(1)']) {
    assert.throws(() => bt.assertWebUrl(bad), /refused|not a URL/,
      `${bad} must not be reachable — a posting could otherwise talk the agent into reading the disk`);
  }
});

test('attach_file refuses a path outside the document folders', () => {
  const outside = path.join(os.tmpdir(), `jat-outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, 'x');
  try {
    assert.match(bt.uploadRefusal(outside), /outside the folders/);
    assert.match(bt.uploadRefusal(path.join(os.homedir(), 'nope-does-not-exist.pdf')), /no such file/);
  } finally { fs.rmSync(outside, { force: true }); }
});

test('FOUND BY E2E: whatever the document tools write is uploadable', () => {
  // The third end-to-end run wrote a résumé, filled the form, found the file input, and was then
  // refused for uploading the file it had just created. The two roots must be one source of truth.
  const docs = require(path.join(root, 'app', 'src', 'ai', 'tools', 'documents.js'));
  const roots = bt.allowedUploadRoots();
  assert.ok(roots.includes(path.resolve(docs.APPLICATIONS_ROOT).toLowerCase()),
    'the folder résumés are written to must be a folder they can be attached from');
});

test('an extra upload root can be allowed explicitly, and nothing else is', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-extra-'));
  const f = path.join(scratch, 'cv.pdf');
  fs.writeFileSync(f, 'x');
  try {
    assert.match(bt.uploadRefusal(f), /outside the folders/);
    bt.allowUploadRoot(scratch);
    assert.equal(bt.uploadRefusal(f), null);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('an allowed folder is genuinely allowed', () => {
  const dir = path.join(os.tmpdir(), 'jat-ai-apply');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'ok.txt');
  fs.writeFileSync(f, 'x');
  try { assert.equal(bt.uploadRefusal(f), null); } finally { fs.rmSync(f, { force: true }); }
});

test('observations are clipped so the transcript cannot be flooded', () => {
  const out = bt.clip('x'.repeat(9000));
  assert.ok(out.length < 2100, 'a single tool result must stay small — it is re-sent every turn');
  assert.match(out, /more characters/);
});

// ---- the belt against a real browser ----------------------------------------
test('the tool belt drives a real form', { skip: chromePath ? false : 'no Chrome on this machine', timeout: 180000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-belt-'));
  const upload = path.join(os.tmpdir(), 'jat-ai-apply', 'resume-belt.txt');
  fs.mkdirSync(path.dirname(upload), { recursive: true });
  fs.writeFileSync(upload, 'BELT-RESUME-BYTES');

  const fixture = path.join(tmp, 'form.html');
  fs.writeFileSync(fixture, `<!doctype html><html><head><meta charset="utf-8"><title>Belt Fixture</title></head>
<body>
  <h1>Apply for Software Developer</h1>
  <label for="phone">Phone number</label><input id="phone" aria-label="Phone number" type="text" />
  <label for="pw">Account password</label><input id="pw" aria-label="Account password" type="password" />
  <label for="sneaky">Security answer</label><input id="sneaky" aria-label="Security answer" name="user_passwd" type="text" />
  <input id="cv" type="file" class="hidden" aria-hidden="true" style="display:none" />
  <button id="go" type="button" onclick="document.getElementById('out').textContent='CLICKED'">Continue</button>
  <p id="out">waiting</p>
  <script>window.__blur = 0; document.getElementById('phone').addEventListener('blur', () => window.__blur++);</script>
</body></html>`, 'utf8');

  const belt = bt.makeBrowserTools({ profileId: 'belt-test', port: PORT, headless: true });
  const byName = Object.fromEntries(belt.tools.map((x) => [x.name, x]));
  const call = async (name, args = {}) => {
    const tool = byName[name];
    assert.ok(tool, `no such tool ${name}`);
    if (tool.guard) {
      const refusal = await tool.guard(args, {});
      if (refusal) return { refused: refusal };
    }
    return { result: await tool.run(args, {}) };
  };

  try {
    await t.test('the belt exposes exactly the verbs the agent is told about', () => {
      assert.deepEqual(belt.tools.map((x) => x.name).sort(), [
        'attach_file', 'click', 'fill', 'find', 'navigate',
        'page_text', 'press_key', 'query_ref', 'read_page', 'screenshot',
      ]);
      for (const x of belt.tools) {
        assert.ok(x.description && x.description.length > 10, `${x.name} needs a real description`);
        assert.ok(Array.isArray(x.args), `${x.name} must declare its args`);
      }
    });

    await t.test('chrome is NOT launched until a tool needs it', () => {
      assert.equal(belt.isOpen(), false, 'a run that never browses must not pay for a browser');
    });

    // The refusal is enforced by the TOOL, not just by the exported helper — a posting that talks
    // the agent into "open file:///…/.credentials.json" must fail at the point of use.
    await t.test('the navigate TOOL itself refuses a file:// URL', async () => {
      await assert.rejects(
        () => byName.navigate.run({ url: 'file:///' + fixture.replace(/\\/g, '/') }, {}),
        /only http and https/,
      );
      assert.equal(belt.isOpen(), false, 'and it must not have opened a browser to find that out');
    });

    // Serve the fixture over http so the belt sees it the way it will see a real ATS.
    const http = await import('node:http');
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(fixture));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}/`;

    try {
      await t.test('navigate + read_page give refs for the controls', async () => {
        const nav = await call('navigate', { url: base });
        assert.match(nav.result, /^opened http:\/\/127\.0\.0\.1/);
        assert.equal(belt.isOpen(), true, 'now the browser exists');
        const tree = await call('read_page', { interactive: true });
        assert.match(tree.result, /ref_\d+/);
        assert.match(tree.result, /Phone number/);
      });

      await t.test('find narrows without re-reading the whole page', async () => {
        const r = await call('find', { query: 'Phone number' });
        assert.match(r.result, /textbox\s+Phone number/);
        const miss = await call('find', { query: 'Social insurance number' });
        assert.match(miss.result, /no match/);
      });

      await t.test('fill types and blurs, so a framework commits the value', async () => {
        const hit = belt.page().find('Phone number')[0];
        const r = await call('fill', { ref: hit.ref, text: '+1 647 963 7745' });
        assert.match(r.result, /filled .* blurred/);
        assert.equal(await belt.page().evaluate('document.getElementById("phone").value'), '+1 647 963 7745');
        assert.ok(await belt.page().evaluate('window.__blur') >= 1, 'the blur is what commits on Ashby');
      });

      await t.test('fill REFUSES a real password field', async () => {
        await belt.page().readTree();
        const ref = await belt.page().queryRef('#pw');
        const r = await call('fill', { ref, text: 'hunter2' });
        assert.ok(r.refused, 'the guard must stop this before it runs');
        assert.match(r.refused, /password field/);
        assert.equal(await belt.page().evaluate('document.getElementById("pw").value'), '',
          'nothing may have been typed');
      });

      await t.test('fill also refuses a password field disguised as type=text', async () => {
        const ref = await belt.page().queryRef('#sneaky');
        const r = await call('fill', { ref, text: 'hunter2' });
        assert.ok(r.refused, 'name="user_passwd" is a credential however it is typed');
      });

      await t.test('query_ref reaches the hidden file input, attach_file fills it for real', async () => {
        const q = await call('query_ref', { selector: '#cv' });
        assert.match(q.result, /^ref_q\d+ matches/);
        const ref = q.result.split(' ')[0];
        const r = await call('attach_file', { ref, file: upload });
        assert.match(r.result, /attached resume-belt\.txt/);
        const got = await belt.page().evaluate(
          '(() => { const f = document.getElementById("cv").files[0]; return f ? f.name + ":" + f.size : "none"; })()',
        );
        assert.equal(got, `resume-belt.txt:${fs.statSync(upload).size}`);
      });

      await t.test('attach_file refuses a file outside the allowed folders', async () => {
        const bad = path.join(os.tmpdir(), 'jat-not-allowed.txt');
        fs.writeFileSync(bad, 'x');
        try {
          const ref = await belt.page().queryRef('#cv');
          const r = await call('attach_file', { ref, file: bad });
          assert.ok(r.refused, 'must be refused by path');
          assert.match(r.refused, /outside the folders/);
        } finally { fs.rmSync(bad, { force: true }); }
      });

      await t.test('click actually fires the handler', async () => {
        await belt.page().readTree();
        const ref = belt.page().find('Continue')[0].ref;
        const r = await call('click', { ref });
        assert.match(r.result, /clicked/);
        assert.equal(await belt.page().evaluate('document.getElementById("out").textContent'), 'CLICKED');
      });

      await t.test('press_key, page_text and screenshot all work', async () => {
        assert.match((await call('press_key', { key: 'Tab' })).result, /pressed Tab/);
        const txt = await call('page_text');
        assert.match(txt.result, /Apply for Software Developer/);
        const shot = await call('screenshot');
        assert.match(shot.result, /saved .*\.jpg \(\d+ bytes\)/);
        const file = shot.result.slice('saved '.length).split(' (')[0];
        assert.ok(fs.statSync(file).size > 1000);
        fs.rmSync(file, { force: true });
      });

      await t.test('a stale ref is refused rather than clicking something else', async () => {
        const r = await call('click', { ref: 'ref_999999' }).catch((e) => ({ threw: e.message }));
        assert.match(r.threw || '', /unknown ref/);
      });

      await t.test('the belt plugs into the agent loop registry unchanged', () => {
        const reg = loop.makeRegistry(belt.tools);
        const described = reg.describe();
        assert.match(described, /- navigate\(url\)/);
        assert.match(described, /- attach_file\(ref, file\)/);
      });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  } finally {
    await belt.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
    try { fs.rmSync(upload, { force: true }); } catch { /* temp */ }
  }
});

// ---- one real ATS, read only ------------------------------------------------
// Proves the belt against a page nobody controlled for the test. Read-only: navigate, read, find.
test('the belt reads a live Greenhouse form', {
  skip: chromePath ? false : 'no Chrome on this machine',
  timeout: 120000,
}, async () => {
  const belt = bt.makeBrowserTools({ profileId: 'belt-live', port: PORT + 1, headless: true });
  const byName = Object.fromEntries(belt.tools.map((x) => [x.name, x]));
  try {
    let nav;
    try {
      nav = await byName.navigate.run({ url: 'https://job-boards.greenhouse.io/embed/job_app?for=knak&token=4725427005' });
    } catch (e) {
      console.log(`[browser-tools] live ATS unreachable, skipping: ${e.message}`);
      return;
    }
    assert.match(nav, /^opened https:\/\/job-boards\.greenhouse\.io/);
    const tree = await byName.read_page.run({ interactive: true });
    if (!/ref_\d+/.test(tree)) {
      console.log('[browser-tools] live form returned no controls (posting may have closed) — skipping');
      return;
    }
    const text = await byName.page_text.run({});
    assert.match(text, /Knak/i, 'must actually be on the employer page');
    // The file input on a Greenhouse form is hidden behind a styled button, exactly as on Seequent.
    const q = await byName.query_ref.run({ selector: 'input[type=file]' });
    assert.match(q, /^ref_q\d+ matches|nothing matches/);
  } finally {
    await belt.close();
  }
});
