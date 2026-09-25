// AMERICAN POSTINGS DO NOT SAY "UNITED STATES". THEY SAY "ANN ARBOR, MI".
//
// The country clamp in jobFit was built on 2026-08-10 after a run of London roles was applied to,
// and those spell out "United Kingdom". It matched \bunited states\b and ",\s*usa?\b" and nothing
// else American, so every posting written the normal way read as an unknown location and walked
// through the gate that exists to stop exactly that.
//
// Live on 2026-09-06: 357 US-located jobs in the store, 70 of which entered the auto-apply queue,
// and 51 of those finished as done.
//
// He is a Canadian citizen who needs sponsorship for a US role, so those applications are waste at
// best. They are also where the dangerous questions come from: every "are you legally authorized to
// work in the United States" and every H-1B question in his answer bank arrived on one of these
// postings. The two findings are the same finding.
//
// Measured before committing: 136 rejections becomes 470, and ZERO jobs naming anywhere Canadian
// are newly rejected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const server = require(path.join(here, '..', 'app', 'src', 'server.js'));

// Only the country clamp is under test, so nothing else in jobFit may fire: an ordinary title, no
// excludes, no salary floor.
const AA = { country: 'Canada', excludeKeywords: [], excludeCompanies: [], excludeLocations: [] };
const verdict = (location) => server.jobFit({ title: 'Software Developer', location }, AA);

// Every location below is a real row from his store.
test('a US posting written the normal way is now rejected', () => {
  for (const loc of [
    'Ann Arbor, MI',
    'Allen Park, MI',
    'Alpharetta, GA 30004',
    '1201 Wilson Boulevard, Arlington, VA 22209',
    '2790 Mosside Boulevard, Monroeville, PA 15146',
    '3800 Commerce Street SW, Canton, OH 44706',
    'Austin, TX',
    'New York, NY 10001',
    'Seattle, WA',
  ]) {
    const v = verdict(loc);
    assert.equal(v.ok, false, `should be outside Canada: ${loc}`);
    assert.match(v.reason, /outside Canada/);
  }
});

test('the spelled-out forms it always caught still work', () => {
  assert.equal(verdict('London Area, United Kingdom').ok, false);
  assert.equal(verdict('Austin, United States').ok, false);
  assert.equal(verdict('Bangalore, India').ok, false);
});

// ---------------------------------------------------------------------------
// nothing Canadian may be lost, which is the constraint that decided the design
// ---------------------------------------------------------------------------
test('Canadian postings are untouched, including the ones ending in CA', () => {
  for (const loc of [
    'Toronto, ON',
    'Toronto, ON, CA',
    'Mississauga, ON, CA',
    'Ottawa, ON, CA',
    'Edmonton, AB, CA',
    'Hamilton, ON, CA',
    'Montréal, QC',
    'Vancouver, BC',
    'Calgary, AB',
    'Waterloo, Ontario',
    // The ambiguity that makes a city blocklist the wrong tool. London, Ontario must survive.
    'London, ON',
    'London, Ontario, Canada',
  ]) {
    assert.equal(verdict(loc).ok, true, `must survive: ${loc}`);
  }
});

test('an unknown or remote location still passes, because this fails open', () => {
  // Over-rejecting starves the queue, which the original comment calls the worse failure. Unchanged.
  assert.equal(verdict('').ok, true);
  assert.equal(verdict('Remote').ok, true);
  assert.equal(verdict('Remote (Canada)').ok, true);
  assert.equal(verdict(null).ok, true);
});

// ---------------------------------------------------------------------------
// CALIFORNIA, which is the whole reason this is not just "all fifty states"
//
// "CA" is California and also the ISO code for Canada. The store holds 162 locations ending in
// ", CA": 138 are Canadian and already caught by a home marker, the rest split into obvious
// California and the genuinely unresolvable.
// ---------------------------------------------------------------------------
test('California counts only when a US ZIP follows it', () => {
  assert.equal(verdict('Goleta, CA 93117').ok, false, 'a ZIP settles it');
  assert.equal(verdict('Santa Clara, CA 95051').ok, false);
  assert.equal(verdict('Irvine, CA 92697').ok, false);
});

test('and a bare ", CA" is deliberately left alone', () => {
  // "Los Angeles, CA" is California and "Remote, CA" and "BC, CA" are Canadian, with nothing in the
  // string to tell them apart. Rejecting the class would take real Canadian jobs with it, so the
  // fail-open rule wins and these pass. Pinned so it reads as a decision, not an oversight.
  assert.equal(verdict('Remote, CA').ok, true);
  assert.equal(verdict('BC, CA').ok, true);
  assert.equal(verdict('Ottawa, Capital Region, CA').ok, true);
  assert.equal(verdict('Los Angeles, CA').ok, true, 'known miss, and the safe direction');
});

test('a two-letter code that is not a state does not trigger it', () => {
  assert.equal(verdict('Toronto, XX').ok, true);
  assert.equal(verdict('Somewhere, ZZ').ok, true);
});
