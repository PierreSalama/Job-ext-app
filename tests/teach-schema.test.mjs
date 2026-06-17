// T1 (Teach & Correct) — the v10 schema: full-fidelity demonstrations with the real
// locator bundle, the credential rail (keep WHERE it is, never the value/html), and
// prune-keep-N retention. Temp DB.
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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-ts-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('a demonstration records with the full locator bundle', () => {
  const pid = db.ensureDefaultProfileId();
  const d = db.recordDemonstration({
    profileId: pid, ats: 'workday', companyKey: 'rogers', sessionId: 's1', stepIndex: 0,
    action: 'fill', label: 'Years of experience with Java', fieldType: 'number',
    selector: '#yoe', xpath: '//*[@id="yoe"]', attrs: { id: 'yoe', name: 'yoe' },
    html: '<input id="yoe">', value: '4', delayMs: 800, source: 'teach',
  });
  assert.equal(d.selector, '#yoe', 'CSS selector stored');
  assert.equal(d.xpath, '//*[@id="yoe"]', 'XPath stored');
  assert.equal(d.value, '4');
  assert.ok(String(d.attrs).includes('yoe'), 'attribute signature stored');
});

test('credential demonstrations keep the locator but NEVER the value/html', () => {
  const pid = db.ensureDefaultProfileId();
  const d = db.recordDemonstration({
    profileId: pid, ats: 'workday', label: 'Password', action: 'fill',
    selector: '#pw', value: 'hunter2', html: '<input type=password value=hunter2>', source: 'teach',
  });
  assert.equal(d.selector, '#pw', 'locator kept (we still know where it is)');
  assert.equal(d.value, null, 'credential value never stored');
  assert.equal(d.html, null, 'credential html never stored');
});

test('prune keeps the newest N demonstrations per (profile, ats, label)', () => {
  const pid = db.ensureDefaultProfileId();
  for (let i = 0; i < 6; i++) {
    db.recordDemonstration({ profileId: pid, ats: 'greenhouse', label: 'Why this company?', value: 'v' + i, source: 'manual' });
  }
  const forLabel = db.demonstrationsFor(pid, { ats: 'greenhouse' }).filter((r) => /why/i.test(r.label));
  assert.ok(forLabel.length > 0 && forLabel.length <= 3, `kept at most 3 newest (got ${forLabel.length})`);
});

test('the v10 migration is idempotent (re-open is a clean no-op)', () => {
  db.close();
  db.open(dir);
  assert.ok(db.ensureDefaultProfileId(), 'db usable after re-open (migration ran once)');
  // the new tables/columns still queryable
  const pid = db.ensureDefaultProfileId();
  assert.doesNotThrow(() => db.demonstrationsFor(pid, { ats: 'workday' }), 'demonstrations table present after re-open');
});
