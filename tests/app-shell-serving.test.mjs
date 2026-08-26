// The dashboard at /app served a BLANK PAGE, and the cause was one missing slash.
//
// app.html links its assets RELATIVELY (`<link href="app.css">`, `<script src="app.js">`).
// At `/app/` the browser resolves those against the directory and gets `/app/app.css` — correct.
// At `/app` — no trailing slash — it resolves against the PARENT and asks for `/app.css`, which is
// not the dashboard route at all. That request falls through to the token-gated API and comes back
// 401, for BOTH the stylesheet and the script. The HTML still arrives, so the browser paints an
// unstyled shell with no JavaScript: an empty page with a nav and nothing else.
//
// It survived because every existing bookmark and link had the trailing slash. It is exactly the
// kind of bug that reads as "the app is unstable" — there is no error, no crash, just nothing.
//
// These tests drive the REAL server over a real socket, because the bug lives in URL resolution
// between the browser and the route table, and a unit test of the handler would have passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const server = require(path.join(here, '..', 'app', 'src', 'server.js'));

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-appshell-'));
  const srv = await server.startServer(0, { userDataDir: dir });
  const port = srv.address ? srv.address().port : srv.port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    try { await server.stopServer(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test('GET /app redirects to /app/ so relative assets resolve', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/app`, { redirect: 'manual' });
    assert.equal(r.status, 302, 'a directory URL without its slash must redirect, not serve');
    assert.equal(r.headers.get('location'), '/app/',
      'it must point at the directory form, or the assets break again');
  });
});

test('the redirect carries the query string, which is how the dashboard receives its token', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/app?token=abc123&x=1`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/app/?token=abc123&x=1',
      'dropping the query would silently sign the user out of the dashboard');
  });
});

test('following the redirect lands on real HTML, not an error', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/app`);            // follow, like a browser
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /<title>Job Application Tracker<\/title>/);
    assert.match(html, /app\.css/, 'the shell must still reference its stylesheet');
    assert.match(html, /app\.js/, 'and its script');
  });
});

test('THE BUG: both assets the shell needs are reachable from the redirected page', async () => {
  // This is the assertion that actually encodes the failure. Before the fix these two were 401,
  // and everything above still passed — the HTML was never the broken part.
  await withServer(async (base) => {
    for (const asset of ['/app/app.css', '/app/app.js']) {
      const r = await fetch(`${base}${asset}`);
      assert.equal(r.status, 200, `${asset} must be served without a token — it is the shell itself`);
      const body = await r.text();
      assert.ok(body.length > 1000, `${asset} came back suspiciously small (${body.length} bytes)`);
    }
  });
});

test('the parent-level paths a slash-less /app produced are still NOT public', async () => {
  // The fix must not have made the fall-through case succeed by widening the route. `/app.css` and
  // `/app.js` are meant to be nothing — the point is that nobody is asking for them any more.
  await withServer(async (base) => {
    for (const wrong of ['/app.css', '/app.js']) {
      const r = await fetch(`${base}${wrong}`);
      assert.notEqual(r.status, 200, `${wrong} must not become a public route`);
    }
  });
});

test('/app/ itself is unchanged — the path that always worked still works', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/app/`, { redirect: 'manual' });
    assert.equal(r.status, 200, 'the directory form must serve directly, with no redirect hop');
    assert.match(await r.text(), /Job Application Tracker/);
  });
});

test('a path traversal out of the app directory is still refused', async () => {
  // Guarding the guard: the redirect sits in front of the route that does the containment check,
  // so a test here proves the check is still reached.
  await withServer(async (base) => {
    const r = await fetch(`${base}/app/../../package.json`);
    assert.notEqual(r.status, 200, 'must not serve files outside the app directory');
  });
});
