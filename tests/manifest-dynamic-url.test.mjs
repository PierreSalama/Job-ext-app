// use_dynamic_url MUST NOT be set on web_accessible_resources.
// We tried it (v11.31.0) as anti-detection vs LinkedIn's "BrowserGate" extension-ID
// probing — but it BROKE the engine: the content-script loader's dynamic
// `import(chrome.runtime.getURL('content/detector.js'))` fails to FETCH a
// use_dynamic_url resource ("Failed to fetch dynamically imported module"), so the
// engine never loads and auto-apply is fully dead. Reverted in v11.31.x. Keep it off.
// (The no-hardcoded-static-ID guarantee below is still good hygiene regardless.)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const mf = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

test('web_accessible_resources does NOT set use_dynamic_url (it breaks content-script dynamic import)', () => {
  const war = mf.web_accessible_resources?.[0];
  assert.ok(war, 'a web_accessible_resources entry exists');
  assert.ok(!('use_dynamic_url' in war) || war.use_dynamic_url === false,
    'use_dynamic_url must be absent/false — it breaks import(getURL(...)) of content modules');
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
