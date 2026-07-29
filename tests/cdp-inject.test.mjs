// Chunk A1c — CDP cookie injection. Launches REAL headless Chrome, injects a LinkedIn
// session via CDP, and re-reads the store to prove li_at actually landed. Also covers the
// pure normalization + the "CDP unreachable" fail-safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cdp = require(path.join(here, '..', 'app', 'src', 'cdp-inject.js'));

function findChrome() {
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  ];
  return cands.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pure-logic tests (always run) ----
test('normalizes cookies to CDP params; forces Secure on SameSite=None', () => {
  const p = cdp.toCdpCookieParam({ name: 'li_at', value: 'X', domain: '.www.linkedin.com', path: '/', secure: false, httpOnly: true, sameSite: 'None', expires: 123 });
  assert.equal(p.sameSite, 'None');
  assert.equal(p.secure, true, 'SameSite=None must be forced Secure or Chrome drops it');
  assert.equal(p.httpOnly, true);
  assert.equal(p.expires, 123);
});

test('injectLinkedInCookies fails safe when CDP is unreachable', async () => {
  const r = await cdp.injectLinkedInCookies({ port: 1, cookies: [{ name: 'li_at', value: 'x', domain: '.linkedin.com' }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /unreachable|CDP/i);
});

test('rejects empty cookie set', async () => {
  assert.equal((await cdp.injectLinkedInCookies({ port: 9222, cookies: [] })).ok, false);
});

// ---- real Chrome integration ----
test('injects a LinkedIn session into real headless Chrome and verifies li_at landed', async (t) => {
  const chrome = findChrome();
  if (!chrome) { t.skip('Chrome not installed'); return; }

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-cdp-chrome-'));
  const proc = spawn(chrome, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    // Chrome writes the chosen port to DevToolsActivePort (line 1) once the endpoint is up.
    const portFile = path.join(userDir, 'DevToolsActivePort');
    let port = null;
    for (let i = 0; i < 60 && port == null; i++) {
      await sleep(250);
      try { port = parseInt(String(fs.readFileSync(portFile, 'utf8')).split('\n')[0].trim(), 10) || null; } catch {}
    }
    assert.ok(port, 'Chrome exposed a CDP port');

    const cookies = [
      { name: 'li_at', value: 'AQEDAT_REAL_TOKEN', domain: '.www.linkedin.com', path: '/', secure: true, httpOnly: true, sameSite: 'None', expires: 1900000000 },
      { name: 'JSESSIONID', value: 'ajax:42', domain: '.www.linkedin.com', path: '/', secure: true, sameSite: 'Lax' },
      { name: 'bcookie', value: 'v=2&z', domain: '.linkedin.com', path: '/', secure: true, sameSite: 'Strict' },
    ];
    const r = await cdp.injectLinkedInCookies({ port, cookies });
    assert.equal(r.ok, true, 'li_at verified present after injection');
    assert.equal(r.injected, 3);
    assert.ok(r.linkedInCookies.includes('li_at') && r.linkedInCookies.includes('JSESSIONID'));
    assert.equal(r.hasLiAt, true);
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(300);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
  }
});
