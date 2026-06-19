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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-terminal-')); db.open(dir); });
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function task(n) {
  const job = db.upsertJob({ externalId: String(n), title: 'Dev ' + n, company: 'Acme', source: 'linkedin', status: 'started', jobUrl: `https://x/${n}` }).job;
  return db.queueAdd(job.id, { mode: 'auto' });
}

test('failed and skipped tasks always retain diagnostics', () => {
  const failed = db.queuePatch(task(1).id, { state: 'failed' });
  const skipped = db.queuePatch(task(2).id, { state: 'skipped' });
  assert.match(failed.lastError, /without a diagnostic/);
  assert.match(skipped.lastError, /without a diagnostic/);
});

test('empty user-wait states become failures', () => {
  const result = db.queuePatch(task(3).id, { state: 'awaiting_input', parkReason: 'missing information' });
  assert.equal(result.state, 'failed');
  assert.match(result.lastError, /missing information/);
});

test('done requires confirmation evidence', () => {
  const unproven = db.queuePatch(task(4).id, { state: 'done' });
  assert.equal(unproven.state, 'awaiting_review');
  const proven = db.queuePatch(task(5).id, { state: 'done', submissionEvidence: { type: 'confirmation', url: 'https://x/thank-you' } });
  assert.equal(proven.state, 'done');
  assert.equal(proven.submissionEvidence.type, 'confirmation');
});
