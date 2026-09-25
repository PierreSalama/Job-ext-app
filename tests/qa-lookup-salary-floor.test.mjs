// THE THIRD PATH THE SALARY FLOOR DID NOT REACH.
//
// executor.js calls POST /qa/lookup to fill a field directly (content/executor.js:1537 and :2233).
// Whatever comes back is typed onto the page. Both halves of the answer it returns are already
// gated for work authorisation and self-ID, because qaLookup and profileFieldLookup both run
// recallOk. Neither of them knows anything about money.
//
// Live 2026-09-06 against a floor of 90,000: 72 rows in the answer bank sit below it and the shape
// gate would serve 64, among them a flat "85,000." and "CAD 85,000 annually." stored against
// "desired salary?". The agent's fill tool refuses those. The autofill bundle now withholds them.
// This endpoint handed them straight to the executor.
//
// Three paths, one rail, and it reached one of them. That is the shape of every gap found tonight:
// the policy was right and the wiring was short.
//
// This is an HTTP test on purpose. The rule itself is asserted directly in
// salary-floor-both-paths.test.mjs; what can only be checked here is whether the endpoint calls it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const server = require(path.join(here, '..', 'app', 'src', 'server.js'));
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-qafloor-'));
  // startServer does not open the ledger; the app normally has. Open it here or every write in
  // the test throws "database is closed" before the endpoint is ever reached.
  db.open(dir);
  const srv = await server.startServer(0, { userDataDir: dir });
  const port = srv.address ? srv.address().port : srv.port;
  try {
    await fn(`http://127.0.0.1:${port}`, server.getToken());
  } finally {
    try { await server.stopServer(); } catch {}
    try { db.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const lookup = (base, token, question) => fetch(`${base}/qa/lookup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-JAT-Token': token },
  body: JSON.stringify({ question }),
}).then((r) => r.json());

test('BEHAVIOUR: a remembered salary below the floor is not handed to the executor', async () => {
  await withServer(async (base, token) => {
    db.patchSettings({ autoApply: { salaryFloor: 90000 } });
    const pid = db.ensureDefaultProfileId();

    // Real rows from his live bank, both signs of the rule plus a control.
    const BELOW = 'what is your desired annual salary for this role';
    const ABOVE = 'what is your annual salary expectation';
    const OTHER = 'how many years of react experience do you have';
    db.profileFieldUpsert({ profileId: pid, question: BELOW, value: '85000', fromUser: true });
    db.profileFieldUpsert({ profileId: pid, question: ABOVE, value: '$90,000 - $99,000', fromUser: true });
    db.profileFieldUpsert({ profileId: pid, question: OTHER, value: '3', fromUser: true });

    const low = await lookup(base, token, BELOW);
    assert.equal(low.ok, true);
    assert.equal(low.match, null, 'an 85,000 answer must never reach a page against a 90,000 floor');

    const high = await lookup(base, token, ABOVE);
    assert.equal(high.ok, true);
    assert.ok(high.match, 'an answer at or above the floor must still be served');
    assert.match(String(high.match.answer), /90,000/);

    const other = await lookup(base, token, OTHER);
    assert.ok(other.match, 'and a question that is not about money is untouched');
    assert.equal(String(other.match.answer), '3');
  });
});

test('BEHAVIOUR: with no floor configured, nothing is withheld', async () => {
  await withServer(async (base, token) => {
    db.patchSettings({ autoApply: { salaryFloor: 0 } });
    const pid = db.ensureDefaultProfileId();
    const Q = 'what is your desired annual salary for this role';
    db.profileFieldUpsert({ profileId: pid, question: Q, value: '85000', fromUser: true });

    const r = await lookup(base, token, Q);
    assert.ok(r.match, 'the floor is opt-in; unset means the old behaviour exactly');
    assert.equal(String(r.match.answer), '85000');
  });
});

test('BEHAVIOUR: the value carries the rule even when the question does not name money', async () => {
  // "to help us understand your expectations please..." is a real live label that names no money at
  // all. Only its stored VALUE says salary, which is why the shared rule tests both sides.
  await withServer(async (base, token) => {
    db.patchSettings({ autoApply: { salaryFloor: 90000 } });
    const pid = db.ensureDefaultProfileId();
    const Q = 'to help us understand your expectations please share a number';
    db.profileFieldUpsert({ profileId: pid, question: Q, value: 'Desired base salary: CAD 85,000-110,000.', fromUser: true });

    const r = await lookup(base, token, Q);
    assert.equal(r.match, null, 'the value said salary even though the label did not');
  });
});
