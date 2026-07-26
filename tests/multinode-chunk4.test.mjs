// Multi-node dashboard — Chunk 4: manage machines from the UI (Settings → Machines).
//
// The registry was API-only; this adds a Settings section to list / add / remove machines so it is
// self-service. Verified live: adding "UI Test Box" via the form took the list 3→4 and it appeared;
// removing it went 4→3 with the three real nodes intact.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appJs = fs.readFileSync(path.join(here, '..', 'extension', 'app', 'app.js'), 'utf8');
const mirror = fs.readFileSync(path.join(here, '..', 'app', 'src', 'app', 'app.js'), 'utf8');

test('the two dashboard copies are still byte-identical', () => {
  assert.equal(appJs, mirror);
});

test('Settings has a Machines section listing nodes with a Remove each', () => {
  assert.match(appJs, /Machines \(multi-node\)/);
  assert.match(appJs, /data-node-rm="\$\{esc\(n\.id\)\}"/);
  assert.match(appJs, /id="node-add"/);
});

test('adding a machine validates and writes settings.nodes on THIS machine', () => {
  const h = appJs.slice(appJs.indexOf("v.querySelector('#node-add')"));
  const body = h.slice(0, 900);
  assert.match(body, /if \(!name \|\| !url\)/, 'name + address required');
  assert.match(body, /if \(!\/\^https\?:\\\/\\\/\/\.test\(url\)\)/, 'address must be a URL');
  assert.match(body, /method: 'PATCH', body: \{ nodes: \[\.\.\.base, \{ id, name, baseUrl: url, token \}\]/);
});

test('removing a machine drops it and, if it was the Auto-Apply target, falls back to This PC', () => {
  const h = appJs.slice(appJs.indexOf('data-node-rm]').match ? 0 : appJs.indexOf("v.querySelectorAll('[data-node-rm]')"));
  const body = h.slice(0, 700);
  assert.match(body, /base\.filter\(\(n\) => n\.id !== rmId\)/);
  assert.match(body, /if \(state\.aaNodeId === rmId\) \{ state\.aaNodeId = 'self'/);
});
