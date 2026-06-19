// SUCCESS-TRUTH quarantine — historical `done` rows minted from the old static
// success-signal evidence (or with no evidence) must be downgraded to
// awaiting_review so they are re-verified, never silently trusted. Trustworthy
// rows (the new `verified` type, a real `confirmation`) must survive untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));
let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-quarantine-')); db.open(dir); });
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function doneTask(n, evidence) {
  const job = db.upsertJob({ externalId: String(n), title: 'Dev ' + n, company: 'Acme', source: 'linkedin', status: 'started', jobUrl: `https://x/${n}` }).job;
  const t = db.queueAdd(job.id, { mode: 'auto' });
  // queuePatch will keep state=done only when evidence is PRESENT (the existing guard
  // downgrades evidence-less done → awaiting_review). To seed a legacy evidence-less
  // `done`, pass undefined so the guard leaves whatever is stored... so for that case
  // we seed a non-empty evidence and then null it via a direct patch path below.
  return db.queuePatch(t.id, { state: 'done', submissionEvidence: evidence });
}

test('legacy static success-signal done → quarantined to awaiting_review', () => {
  const legacy = doneTask(1, { type: 'success-signal', detail: 'confirmation text', url: 'https://x/1' });
  assert.equal(legacy.state, 'done');             // the old code path let this through
  const n = db.quarantineUntrustworthyDone();
  assert.ok(n >= 1);
  const after = db.queueList().find((t) => t.id === legacy.id);
  assert.equal(after.state, 'awaiting_review');
  assert.match(after.lastError, /not trustworthy/);
});

test('trustworthy verified done survives quarantine', () => {
  const good = doneTask(2, { type: 'verified', reason: 'new-confirmation-node', url: 'https://x/2/confirmation' });
  assert.equal(good.state, 'done');
  db.quarantineUntrustworthyDone();
  const after = db.queueList().find((t) => t.id === good.id);
  assert.equal(after.state, 'done');
});

test('real confirmation (modal-close) done survives quarantine', () => {
  const good = doneTask(3, { type: 'confirmation', url: 'https://x/3/thank-you' });
  assert.equal(good.state, 'done');
  db.quarantineUntrustworthyDone();
  const after = db.queueList().find((t) => t.id === good.id);
  assert.equal(after.state, 'done');
});

test('quarantine is idempotent', () => {
  doneTask(4, { type: 'success-signal', detail: 'confirmation URL', url: 'https://x/4' });
  const first = db.quarantineUntrustworthyDone();
  assert.ok(first >= 1);
  const second = db.quarantineUntrustworthyDone();
  assert.equal(second, 0);
});
