// The salary floor. Pierre earns $60k and wants $80k+; the point is to stop spending applications
// on roles he would decline, not to raise volume.
//
// The property that matters more than any threshold: it rejects ONLY what is demonstrably below
// the line. Most Canadian postings state no salary, so a floor that treated unknown as "reject"
// would silently gut the pipeline — the same failure shape as the dead Gmail sync and the
// classifier's 'other', where something decides nothing is there and nothing records it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sal = require(path.join(here, '..', 'app', 'src', 'salary.js'));

const FLOOR = 80000;
const ok = (raw) => sal.meetsFloor(raw, FLOOR).ok;

// ---- the one-directional rule ------------------------------------------------------------------

test('UNKNOWN SALARY ALWAYS PASSES — the whole design rests on this', () => {
  for (const raw of [null, undefined, '', '   ', 'null', '{}', 'Competitive salary', 'DOE', 'TBD']) {
    assert.equal(ok(raw), true, `${JSON.stringify(raw)} must not be rejected`);
  }
});

test('the {min:0,max:0} sentinel the boards emit is UNKNOWN, not zero', () => {
  // Live in Pierre's store. Read as "0 < 80000" this would reject a large slice of real postings.
  assert.equal(ok('{"min":0,"max":0,"interval":null}'), true);
  assert.equal(sal.parseCompensation('{"min":0,"max":0,"interval":null}').known, false);
});

test('an unparseable or weird value passes rather than being guessed at', () => {
  for (const raw of ['see job description', '???', 'CAD ????', '{bad json']) {
    assert.equal(ok(raw), true, `${raw} must fail open`);
  }
});

// ---- ranges are judged on their TOP -------------------------------------------------------------

test('a range whose top clears the floor PASSES, even if its bottom does not', () => {
  // "$70k–$95k" is negotiable up. Judging on the bottom would reject most of the real market.
  assert.equal(ok('CAD 70000–95000 YEAR'), true);
  assert.equal(ok('CAD 65000–115000 YEAR'), true);
  assert.equal(ok('CAD 50280–83800 YEAR'), true);
});

test('a range entirely below the floor is rejected', () => {
  assert.equal(ok('CAD 55000–75000 YEAR'), false);
  assert.equal(ok('CAD 60000–70000 YEAR'), false);
  const r = sal.meetsFloor('CAD 55000–75000 YEAR', FLOOR);
  assert.match(r.reason, /tops out at ~75,000/, 'the reason must say the actual number');
});

test('a single stated figure is judged on itself', () => {
  assert.equal(ok('CAD 60000 YEAR'), false);
  assert.equal(ok('CAD 95000 YEAR'), true);
});

// ---- hourly / monthly / contract must annualise -------------------------------------------------

test('HOURLY RATES ANNUALISE — a $60/hr contract is ~$125k, not "60"', () => {
  assert.equal(ok('CAD 60 HOUR'), true, '60/hr = 124,800');
  assert.equal(ok('$60/hr'), true);
  assert.equal(ok('CAD 70.81–85.04 HOUR'), true, 'real value from the live store');
  assert.equal(ok('CAD 32–35 HOUR'), false, '35/hr = 72,800 — genuinely below the floor');
});

test('monthly and weekly rates annualise', () => {
  assert.equal(ok('CAD 7000–8000 MONTH'), true, '8000/mo = 96,000');
  assert.equal(ok('CAD 5000 MONTH'), false, '5000/mo = 60,000');
  assert.equal(ok('CAD 2000 WEEK'), true, '2000/wk = 104,000');
});

test('day rates annualise (contract work)', () => {
  assert.equal(ok('CAD 520 DAY'), true, '520/day = 135,200');
  assert.equal(ok('CAD 200 DAY'), false, '200/day = 52,000');
});

test('a bare number with no interval is inferred by magnitude, erring toward keeping', () => {
  assert.equal(sal.inferInterval(60), 'hour');
  assert.equal(sal.inferInterval(7500), 'month');
  assert.equal(sal.inferInterval(95000), 'year');
  assert.equal(ok('60'), true, 'read as hourly — the generous reading');
});

// ---- currency ------------------------------------------------------------------------------------

test('foreign currency is converted rather than compared raw', () => {
  assert.equal(ok('USD 60000 YEAR'), true, '60k USD ≈ 87k CAD');
  assert.equal(ok('USD 50000 YEAR'), false, '50k USD ≈ 72k CAD — still below');
  assert.equal(ok('GBP 50000 YEAR'), true, '50k GBP ≈ 90k CAD');
});

// ---- the JSON shape from the boards ---------------------------------------------------------------

test('the structured shape parses, including k-suffixes and separators', () => {
  assert.equal(ok('{"min":85000,"max":105000,"interval":"YEAR"}'), true);
  assert.equal(ok('{"min":55000,"max":70000,"interval":"YEAR"}'), false);
  assert.equal(ok('{"min":45,"max":55,"interval":"HOUR"}'), true, '55/hr = 114,400');
  assert.equal(ok('80k-100k'), true);
  assert.equal(ok('CAD 135,200–202,800 YEAR'), true);
});

// ---- floor configuration ---------------------------------------------------------------------------

test('a floor of 0 or unset disables the whole thing', () => {
  assert.equal(sal.meetsFloor('CAD 40000 YEAR', 0).ok, true);
  assert.equal(sal.meetsFloor('CAD 40000 YEAR', undefined).ok, true);
});

test('the rejection reason names the number, so a surprise is diagnosable', () => {
  const r = sal.meetsFloor('CAD 32–35 HOUR', FLOOR);
  assert.equal(r.ok, false);
  assert.match(r.reason, /72,800/);
  assert.match(r.reason, /below 80,000/);
});
