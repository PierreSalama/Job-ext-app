// The manifest must NOT declare chrome.system.display — it segfaults headless Chrome.
//
// The applier on the laptop runs Chrome for Testing in HEADLESS mode. Declaring the
// `system.display` permission crashes that browser on startup/use. The deployed extension had the
// permission hand-removed weeks ago, but the REPO manifest still carried it — so the moment the repo
// copy was synced onto the node (2026-08-10 03:15) Chrome began crash-looping:
//
//   03:21:35  [chrome-exit] code=2147483651   ← first crash, 6 min after the sync
//   …39 identical crashes in ~90 minutes, one every ~2 minutes…
//   04:42:55  GET /queue/next     ← claims a task
//   04:42:58  browser disconnected → chrome-exit → launch #40
//
// Every crash landed seconds after a claim, which is what stranded the claim and produced the
// "timed out / interrupted" pile (279 tasks). The fix belongs in the repo, not in a hand-edit on one
// machine, or the next sync reintroduces it.
//
// Removing the permission is safe: the only caller is guarded (`chrome.system?.display?.getInfo`)
// and falls back to window bounds, which is exactly what production has run for weeks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const manifest = JSON.parse(read('extension', 'manifest.json'));
const bg = read('extension', 'background.js');

test('system.display is NOT requested', () => {
  assert.equal((manifest.permissions || []).includes('system.display'), false,
    'regression: this permission crash-loops headless Chrome (exit 2147483651) — 39 crashes in 90 min live');
});

test('the permissions the applier actually needs are still there', () => {
  for (const p of ['storage', 'tabs', 'scripting', 'alarms', 'webNavigation', 'downloads', 'idle']) {
    assert.equal((manifest.permissions || []).includes(p), true, `${p} must remain`);
  }
});

test('the only caller is guarded, so dropping the permission cannot throw', () => {
  assert.match(bg, /chrome\.system\?\.display\?\.getInfo/,
    'the call must stay optional-chained — without the permission the API is simply absent');
});

test('window placement degrades to bounds rather than failing', () => {
  const place = read('extension', 'lib', 'window-place.js');
  assert.match(place, /fall back to bounds/i,
    'no displays available must mean slightly worse placement, never a crash or a thrown error');
});
