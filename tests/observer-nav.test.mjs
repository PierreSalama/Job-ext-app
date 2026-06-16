// P2 (Apprenticeship Engine) — the always-on Observer records the human navigation path so
// recipes can attribute every step to an (ats, company) pair and learn board→ATS handoff
// edges. Covers: classifyAts ATS/company extraction, a synthetic Google→LinkedIn→Workday
// trace yielding a 'handoff' edge with correct attribution, and the rolling cap. Temp DB.
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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-nav-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('classifyAts identifies the ATS family and extracts the company key from the URL', () => {
  assert.deepEqual(
    db.classifyAts('https://boards.greenhouse.io/shopify/jobs/123'),
    { ats: 'greenhouse', companyKey: 'shopify', host: 'boards.greenhouse.io' });
  assert.deepEqual(
    db.classifyAts('https://rogers.wd3.myworkdayjobs.com/en-US/careers/job/Toronto/Engineer_R-1'),
    { ats: 'workday', companyKey: 'rogers', host: 'rogers.wd3.myworkdayjobs.com' });
  assert.equal(db.classifyAts('https://jobs.lever.co/figma/abc-def').ats, 'lever');
  assert.equal(db.classifyAts('https://jobs.lever.co/figma/abc-def').companyKey, 'figma');
  assert.equal(db.classifyAts('https://jobs.ashbyhq.com/ramp/role-1').ats, 'ashby');
  assert.equal(db.classifyAts('https://jobs.ashbyhq.com/ramp/role-1').companyKey, 'ramp');
  assert.equal(db.classifyAts('https://careers-tdbank.icims.com/jobs/9/apply').ats, 'icims');
  assert.equal(db.classifyAts('https://careers-tdbank.icims.com/jobs/9/apply').companyKey, 'tdbank');
});

test('classifyAts recognizes boards (company not in host) and falls back to direct', () => {
  assert.equal(db.classifyAts('https://www.linkedin.com/jobs/view/123').ats, 'linkedin');
  assert.equal(db.classifyAts('https://www.linkedin.com/jobs/view/123').companyKey, null);
  assert.equal(db.classifyAts('https://ca.indeed.com/viewjob?jk=abc').ats, 'indeed');
  assert.equal(db.classifyAts('https://careers.examplecorp.com/apply/42').ats, 'direct');
  // Bad / relative URLs never throw — they resolve to the direct fallback shape.
  assert.deepEqual(db.classifyAts('/jobs/apply'), { ats: 'direct', companyKey: null, host: '' });
  assert.deepEqual(db.classifyAts(null), { ats: 'direct', companyKey: null, host: '' });
});

test('a Google→LinkedIn→Workday trace records a handoff edge on the LinkedIn→Workday hop', () => {
  const pid = db.ensureDefaultProfileId();
  const sid = 'sess-trace-1';
  db.recordNavEvent({ profileId: pid, url: 'https://www.google.com/search?q=jobs', sessionId: sid });
  db.recordNavEvent({ profileId: pid, url: 'https://www.linkedin.com/jobs/view/999',
    referrer: 'https://www.google.com/search?q=jobs', sessionId: sid });
  const handoff = db.recordNavEvent({ profileId: pid,
    url: 'https://rogers.wd3.myworkdayjobs.com/en-US/careers/job/Engineer_R-1',
    referrer: 'https://www.linkedin.com/jobs/view/999', sessionId: sid });

  assert.equal(handoff.kind, 'handoff', 'board→ATS transition is a handoff edge');
  assert.equal(handoff.ats, 'workday', 'attributed to the destination ATS');
  assert.equal(handoff.company_key, 'rogers', 'company extracted from the Workday host');

  const rows = db.navEventsForProfile(pid);
  const handoffs = rows.filter((r) => r.kind === 'handoff');
  assert.equal(handoffs.length, 1, 'exactly one handoff in the trace');
  // The google→linkedin hop is a plain visit (board↔board, not board↔ATS).
  const lk = rows.find((r) => r.ats === 'linkedin');
  assert.ok(lk && lk.kind === 'visit', 'google→linkedin is a visit, not a handoff');
});

test('caller-supplied company attributes a board apply that has no company in the URL', () => {
  const pid = db.ensureDefaultProfileId();
  const ev = db.recordNavEvent({ profileId: pid, url: 'https://www.linkedin.com/jobs/view/777', company: 'Acme Corp' });
  assert.equal(ev.ats, 'linkedin');
  assert.equal(ev.company_key, 'acmecorp', 'company normalized from the caller hint');
});

test('the rolling cap holds: row count never exceeds NAV_EVENTS_CAP per profile', () => {
  // Use a fresh, dedicated profile so the earlier traces do not perturb the count.
  const prof = db.saveProfile({ name: 'CapTest' });
  const pid = prof.id;
  const N = 2050;   // > the 2000 cap
  for (let i = 0; i < N; i++) {
    db.recordNavEvent({ profileId: pid, url: `https://careers.example.com/apply/${i}` });
  }
  const rows = db.navEventsForProfile(pid, N);
  assert.ok(rows.length <= 2000, `count ${rows.length} stays within the 2000 cap`);
  assert.equal(rows.length, 2000, 'cap keeps exactly the newest 2000');
});
