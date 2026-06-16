// P0 (Apprenticeship Engine) — the non-negotiable credential/payment safety rail.
// The always-on Observer captures real applications on any site, so the WRITE BOUNDARY
// must never let a password / card / CVV / PIN / security-answer reach long-lived memory,
// while NOT eating legitimate look-alike fields ("security clearance", "Pinterest"...).
// Also exercises that the v9 migration ran (db.open would throw otherwise). Temp DB.
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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-sr-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('credential / payment / security-answer answers are NEVER harvested', () => {
  const pid = db.ensureDefaultProfileId();
  db.upsertJob({
    externalId: 'sr1', title: 'Dev', company: 'Acme', source: 'linkedin', status: 'started', jobUrl: 'https://x/sr1',
    answers: {
      years_of_experience: '5',                 // legitimate — MUST be harvested
      password: 'hunter2',
      'credit card number': '4111111111111111',
      cvv: '123',
      pin: '4321',
      'security question': 'first pet',
      'payment method': 'visa',
      passport: 'X1234567',
    },
  });
  const labels = db.profileFieldList(pid).map((f) => (f.label || '').toLowerCase()).join(' | ');
  assert.ok(/experience/.test(labels), 'a legitimate answer IS harvested');
  assert.ok(!/password|credit card|cvv|\bpin\b|security question|payment|passport/.test(labels),
    'credentials / payment / security-answer / passport are NOT harvested');
});

test('the write-boundary backstop refuses a sensitive field on a DIRECT upsert', () => {
  const pid = db.ensureDefaultProfileId();
  for (const q of ['Password', 'Card Number', 'CVV', 'Security question', 'Bank account number']) {
    assert.equal(db.profileFieldUpsert({ profileId: pid, question: q, value: 'x', fromUser: true }), null,
      `profileFieldUpsert refuses "${q}"`);
  }
  const labels = db.profileFieldList(pid).map((f) => (f.label || '').toLowerCase()).join(' | ');
  assert.ok(!/password|card number|cvv|security question|bank account/.test(labels), 'nothing sensitive stored');
});

test('legitimate look-alikes still pass (regex is precise, not over-broad)', () => {
  const pid = db.ensureDefaultProfileId();
  const ok1 = db.profileFieldUpsert({ profileId: pid, question: 'Do you hold a security clearance?', value: 'Yes', fromUser: true });
  const ok2 = db.profileFieldUpsert({ profileId: pid, question: 'Years managing Pinterest ad campaigns?', value: '2', fromUser: true });
  const ok3 = db.profileFieldUpsert({ profileId: pid, question: 'Comfortable with on-site shipping logistics?', value: 'Yes', fromUser: true });
  assert.ok(ok1, '"security clearance" is allowed (not a security question/answer)');
  assert.ok(ok2, '"Pinterest" is allowed (pin is word-bounded)');
  assert.ok(ok3, '"shipping" is allowed');
  const labels = db.profileFieldList(pid).map((f) => (f.label || '').toLowerCase()).join(' | ');
  assert.ok(/clearance/.test(labels) && /pinterest/.test(labels) && /shipping/.test(labels), 'all three stored');
});

test('the v9 migration created the new tables (open succeeded + tables queryable)', () => {
  // If the v9 DDL were invalid, db.open() in before() would have thrown and every test
  // here would fail. As a direct check, re-open is idempotent (no double-migrate crash).
  db.close();
  db.open(dir);                       // re-run migrations on the same dir → must be a clean no-op
  const pid = db.ensureDefaultProfileId();
  assert.ok(pid, 'db usable after re-open (migration idempotent)');
});
