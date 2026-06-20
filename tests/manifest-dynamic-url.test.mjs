// FIX 4 (anti-detection): web_accessible_resources must use a rotating per-session UUID.
// LinkedIn's 2026 "BrowserGate" fingerprinting probes chrome-extension://<static-id>/<resource>
// to DETECT installed extensions. Setting use_dynamic_url:true serves WAR resources under a
// rotating UUID, so the static-ID probe 404s. Manifest-only change (no new permission). The
// content loader chain must reference every resource via a RUNTIME chrome.runtime.getURL(...)
// (the UUID rotates per session) — never a hardcoded chrome-extension://<id>/… literal.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const mf = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

test('web_accessible_resources sets use_dynamic_url:true', () => {
  const war = mf.web_accessible_resources?.[0];
  assert.ok(war, 'a web_accessible_resources entry exists');
  assert.equal(war.use_dynamic_url, true);
});

test('the WAR resource list is unchanged in shape (still covers the content chain)', () => {
  const resources = (mf.web_accessible_resources?.[0]?.resources || []).join(' ');
  for (const need of ['content/detector.js', 'content/executor.js', 'content/autofill.js',
    'content/lib/*.js', 'content/signals/*.js', 'content/sites/*.js']) {
    assert.ok(resources.includes(need), 'WAR still lists ' + need);
  }
});

test('no content-chain file hardcodes a chrome-extension://<id>/… literal (UUID must be runtime)', () => {
  const dir = new URL('../extension/content/', import.meta.url);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = new URL(e.name + (e.isDirectory() ? '/' : ''), d);
    return e.isDirectory() ? walk(p) : (e.name.endsWith('.js') ? [p] : []);
  });
  for (const f of walk(dir)) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/chrome-extension:\/\/[a-p]{32}/.test(src), `hardcoded extension-id URL in ${f.pathname}`);
    assert.ok(!/chrome-extension:\/\/\$\{/.test(src), `hardcoded chrome-extension:// template in ${f.pathname}`);
  }
});
