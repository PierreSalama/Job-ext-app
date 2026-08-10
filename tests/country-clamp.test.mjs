// The geography leak. `autoApply.country` was only ever a search HINT passed to JobSpy; nothing
// re-checked what came back. Live 2026-08-10: 25 non-Canadian jobs discovered in 30 days and
// 13 APPLIED TO — a run of "London Area, United Kingdom" roles (Ventula, Few&Far, Client Server,
// Prism Digital) that produced nothing but LinkedIn confirmations in Pierre's inbox.
//
// The gate FAILS OPEN by design: reject only when a location positively names somewhere foreign
// and names nothing local. Over-rejecting starves the queue, which is a far worse failure than an
// occasional foreign posting — and "London, Ontario" is why a city blocklist could never work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { jobFit } = require(path.join(here, '..', 'app', 'src', 'server.js'));

// Minimal settings that pass every other gate, so these tests isolate geography.
const aa = { country: 'Canada', seniorityMax: 'any', requireKeywordMatch: false, excludeKeywords: [], excludeCompanies: [], excludeLocations: [] };
const fit = (location) => jobFit({ title: 'Software Developer', company: 'Acme', location }, aa);

test('the exact postings Pierre actually applied to are now rejected', () => {
  for (const loc of ['London Area, United Kingdom', 'London, England, UK', 'Greater London, England, UK']) {
    const r = fit(loc);
    assert.equal(r.ok, false, `${loc} should be rejected`);
    assert.match(r.reason, /outside Canada/);
  }
});

test('LONDON, ONTARIO SURVIVES — the reason this is not a city blocklist', () => {
  for (const loc of ['London, Ontario, Canada', 'London, ON', 'London, ON, CA', 'london ontario']) {
    assert.equal(fit(loc).ok, true, `${loc} is a Canadian city and must pass`);
  }
});

test('ordinary Canadian locations pass in all the shapes the boards emit', () => {
  for (const loc of [
    'Toronto, Ontario, Canada', 'Toronto, ON, CA', 'Montréal, QC, CA', 'Montreal, Quebec, Canada',
    'Vancouver, BC', 'Greater Toronto Area, Canada', 'Ottawa, ON, CA', 'Halifax, NS', 'Calgary, AB, CA',
  ]) {
    assert.equal(fit(loc).ok, true, `${loc} must pass`);
  }
});

test('an unknown or empty location is never rejected — the gate fails OPEN', () => {
  for (const loc of ['', '   ', 'Remote', 'Hybrid', 'Anywhere', undefined, null]) {
    assert.equal(fit(loc).ok, true, `"${loc}" must not be rejected on geography`);
  }
});

test('a remote role that names a foreign country is still foreign', () => {
  assert.equal(fit('Remote, United Kingdom').ok, false);
  assert.equal(fit('Remote - India').ok, false);
});

test('a remote role naming Canada passes', () => {
  assert.equal(fit('Remote, Canada').ok, true);
  assert.equal(fit('Remote (Ontario)').ok, true);
});

test('other foreign markets seen in the store are caught', () => {
  for (const loc of ['Austin, Texas, United States', 'Bengaluru, India', 'Sydney, Australia', 'Dubai, United Arab Emirates']) {
    assert.equal(fit(loc).ok, false, `${loc} should be rejected`);
  }
});

test('a job that is BOTH — "Toronto, Canada; London, United Kingdom" — is kept', () => {
  // A multi-site posting that includes Canada is a job he could take. Local wins on purpose;
  // rejecting it would lose a real opportunity to catch a listing that is only partly foreign.
  assert.equal(fit('Toronto, Canada; London, United Kingdom').ok, true);
});

test('with no country configured the clamp does nothing at all', () => {
  const noCountry = { ...aa, country: '' };
  assert.equal(jobFit({ title: 'Software Developer', location: 'London Area, United Kingdom' }, noCountry).ok, true);
});

test('a country we do not model never rejects anything', () => {
  const other = { ...aa, country: 'Germany' };
  assert.equal(jobFit({ title: 'Software Developer', location: 'London Area, United Kingdom' }, other).ok, true,
    'an unmodelled country must not silently reject every job');
});

test('the clamp runs at DISPATCH too, so the standing queue is purged retroactively', () => {
  // jobFit is re-applied in queueNext, so the ~12 UK jobs already sitting in the queue are dropped
  // the next time the pump looks at them rather than waiting to be applied to.
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(here, '..', 'app', 'src', 'server.js'), 'utf8');
  const dispatch = src.slice(src.indexOf('const fitNow = jobFit(j, s);'));
  assert.match(dispatch.slice(0, 400), /filtered: \$\{fitNow\.reason\}/);
});
