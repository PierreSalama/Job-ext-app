// autoUpdate.mode 'pinned' — the Dad's-laptop freeze. DB-level contract:
//   default stays 'auto'; a PATCH to 'pinned' persists and round-trips; other autoUpdate
//   knobs survive the merge. (The updater gates in main.js check this exact value:
//   maybeCheck() and manualCheckForUpdates() both no-op on 'pinned' — Electron-bound,
//   verified live via the dashboard in the chunk report.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));

test('autoUpdate.mode: default auto → pinned persists → other knobs survive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-upd-'));
  await db.open(dir);
  try {
    assert.equal(db.getSettings().autoUpdate.mode, 'auto');
    db.patchSettings({ autoUpdate: { mode: 'pinned' } });
    const s = db.getSettings().autoUpdate;
    assert.equal(s.mode, 'pinned');
    assert.equal(s.checkEveryMinutes, 30);   // sibling defaults untouched by the merge
    assert.equal(s.checkOnFocus, true);
    db.patchSettings({ autoUpdate: { mode: 'auto' } });
    assert.equal(db.getSettings().autoUpdate.mode, 'auto');
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
