// EVERY WORK-AUTHORISATION FIELD HE ACTUALLY FILLED IN.
//
// parseAuthorization() read sponsorshipRequired, workAuthorization and citizenship, and nothing
// else. His live profile holds none of the first and last. It holds five other work-authorisation
// fields the floor never looked at, all filled and all unambiguous:
//
//     authorizedToWork 'Yes'   authorizedToWorkInCanada 'Yes'   needSponsorship 'No'
//     requireSponsorship 'No'  visaSponsorship 'No'
//
// So the whole thing rested on one free-text sentence in workAuthorization. Verified 2026-09-05 by
// deleting that single field: every work-authorisation question then returned null, though four
// fields on the same profile answer it plainly. The failure was safe, since it parks rather than
// misstating, but a reworded profile would silently park the most-asked question class in his search.
//
// These field names are Canada-specific by construction. That is fine, because
// namesForeignJurisdiction turns a US or UK question away before either branch reaches this.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const det = require(path.join(here, '..', 'app', 'src', 'ai', 'deterministic.js'));

const BASE = { firstName: 'Pierre', city: 'Toronto', region: 'Ontario', country: 'Canada' };
const ask = (data, q) => {
  const r = det.answer(q, { profile: { data }, resume: '' });
  return r && r.answer != null ? String(r.answer) : null;
};
const AUTH = 'Are you legally authorized to work in Canada?';
const SPONSOR = 'Do you require sponsorship to work in Canada?';

test('the free-text workAuthorization sentence still drives it, unchanged', () => {
  const d = { ...BASE, workAuthorization: 'Authorized to work in Canada (no sponsorship required)' };
  assert.equal(ask(d, AUTH), 'Yes');
  assert.equal(ask(d, SPONSOR), 'No');
});

test('and with that field gone, the other four still answer', () => {
  // This is the exact profile shape minus workAuthorization. Before, both of these were null.
  const d = {
    ...BASE,
    authorizedToWork: 'Yes', authorizedToWorkInCanada: 'Yes',
    needSponsorship: 'No', requireSponsorship: 'No', visaSponsorship: 'No',
  };
  assert.equal(ask(d, AUTH), 'Yes');
  assert.equal(ask(d, SPONSOR), 'No');
});

test('each sponsorship field carries it on its own', () => {
  for (const key of ['sponsorshipRequired', 'needSponsorship', 'requireSponsorship', 'visaSponsorship']) {
    assert.equal(ask({ ...BASE, [key]: 'No' }, SPONSOR), 'No', `${key} alone should answer`);
    assert.equal(ask({ ...BASE, [key]: 'Yes' }, SPONSOR), 'Yes', `${key} alone should answer, both signs`);
  }
});

// ---------------------------------------------------------------------------
// THE "N/A" TRAP
//
// The old test was /^\s*(?:no|non|false|n)\b/i. The bare "n" alternative matches the "N" of "N/A",
// and the word boundary is satisfied by the slash, so a field reading N/A parsed as a confident No.
// On the sponsorship side that was already live before today. On the authorisation side it would
// have meant answering "no, I am not authorized to work in Canada", which is the worst answer the
// floor can give. Found while widening the fields above, and fixed on both sides.
// ---------------------------------------------------------------------------
test('"N/A" is not an answer, on either side', () => {
  const d = { ...BASE, authorizedToWorkInCanada: 'N/A', needSponsorship: 'N/A' };
  assert.equal(ask(d, AUTH), null, 'N/A must never read as "not authorized"');
  assert.equal(ask(d, SPONSOR), null);
});

test('nor is "none", which starts with the same two letters as "no"', () => {
  const d = { ...BASE, authorizedToWorkInCanada: 'none', needSponsorship: 'none' };
  assert.equal(ask(d, AUTH), null);
  assert.equal(ask(d, SPONSOR), null);
});

test('but a real single letter still counts, and so does a leading word', () => {
  assert.equal(ask({ ...BASE, authorizedToWorkInCanada: 'n' }, AUTH), 'No');
  assert.equal(ask({ ...BASE, authorizedToWorkInCanada: 'y' }, AUTH), 'Yes');
  assert.equal(ask({ ...BASE, needSponsorship: 'No, I do not require it' }, SPONSOR), 'No');
  assert.equal(ask({ ...BASE, needSponsorship: 'Yes, I will need sponsorship' }, SPONSOR), 'Yes');
});

test('an empty profile still parks rather than guessing', () => {
  assert.equal(ask({ ...BASE }, AUTH), null);
  assert.equal(ask({ ...BASE }, SPONSOR), null);
});

test('none of this reaches a foreign question', () => {
  // The jurisdiction gate runs first. Reading Canada-specific fields is only safe because of it.
  const d = {
    ...BASE,
    authorizedToWork: 'Yes', authorizedToWorkInCanada: 'Yes', needSponsorship: 'No',
  };
  assert.equal(ask(d, 'Are you legally authorized to work in the United States?'), null);
  assert.equal(ask(d, 'Do you require sponsorship to work in the United States?'), null);
});
