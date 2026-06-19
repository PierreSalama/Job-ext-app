// External-ATS adapter contract regression (EXTERNAL-ATS-PLAYBOOK.md).
//
// The per-ATS hint packs in extension/content/sites/ tell the executor how to drive
// (or honestly PARK) each major external Applicant Tracking System. This pins down the
// load-bearing, pure decisions so a selector/flag regression is caught node-side without
// a browser:
//   • host matching (lever / greenhouse / ashby / bamboohr / workday / icims / taleo)
//   • account flags ('required' walls vs 'none' account-less platforms)
//   • submitGate 'captcha' for BambooHR (fill → park for human submit)
//   • isHoneypot: true for BambooHR nickname_* traps, false for a real firstName field
//   • isSubmitHint positive/negative recognition
//   • confirmSignalsMatched: NEW-confirmation-only evidence (never weakens R1)
import test from 'node:test';
import assert from 'node:assert/strict';

import { sitePack } from '../extension/content/sites/index.js';
import lever from '../extension/content/sites/lever.js';
import greenhouse from '../extension/content/sites/greenhouse.js';
import ashby from '../extension/content/sites/ashby.js';
import bamboohr from '../extension/content/sites/bamboohr.js';
import { wallAdapters } from '../extension/content/sites/walls.js';
import { confirmSignalsMatched } from '../extension/content/lib/ats-drive.js';

const byId = (id) => wallAdapters.find((a) => a.id === id);
const workday = byId('workday');
const icims = byId('icims');
const taleo = byId('taleo');

// Minimal element stub: enough for the pure adapter decisions (name / matches / attrs).
function el({ name, type, placeholder, id, selectorMatches = [], text = '' } = {}) {
  return {
    name, type, placeholder, id, textContent: text,
    matches: (sel) => selectorMatches.includes(sel),
    getAttribute: (k) => ({ name, type, placeholder, 'aria-label': '' }[k] ?? null),
  };
}

test('sitePack matches every recon\'d ATS host to its adapter', () => {
  const cases = {
    'jobs.lever.co': 'lever',
    'job-boards.greenhouse.io': 'greenhouse',
    'boards.greenhouse.io': 'greenhouse',
    'jobs.ashbyhq.com': 'ashby',
    'acme.bamboohr.com': 'bamboohr',
    'acme.myworkdayjobs.com': 'workday',
    'acme.myworkdaysite.com': 'workday',
    'careers-acme.icims.com': 'icims',
    'acme.taleo.net': 'taleo',
  };
  for (const [host, expected] of Object.entries(cases)) {
    const pack = sitePack(host);
    assert.ok(pack, `no pack for ${host}`);
    assert.equal(pack.id, expected, `${host} → ${pack.id}, expected ${expected}`);
  }
  // www. prefix is stripped before matching.
  assert.equal(sitePack('www.jobs.lever.co')?.id, 'lever');
  // An unrelated host has no pack (the generic flow + BUG-3 cap handle it).
  assert.equal(sitePack('example.com'), null);
});

test('account flags: walled vs account-less', () => {
  for (const a of [lever, greenhouse, ashby, bamboohr]) {
    assert.equal(a.account, 'none', `${a.id} must be account-less`);
  }
  for (const a of [workday, icims, taleo]) {
    assert.equal(a.account, 'required', `${a.id} must be account-walled`);
    assert.ok(a.parkReason, `${a.id} must carry a human-readable parkReason`);
  }
});

test('walled adapters always park (Workday parks until a signed-in session form is up)', () => {
  assert.equal(icims.shouldPark(), true);
  assert.equal(taleo.shouldPark(), true);
  // Workday with no signed-in session form present (no DOM) → park.
  assert.equal(typeof workday.shouldPark, 'function');
  assert.equal(workday.shouldPark(), true);
});

test('submitGate: BambooHR is CAPTCHA-gated, the others are not', () => {
  assert.equal(bamboohr.submitGate, 'captcha');
  for (const a of [lever, greenhouse, ashby]) {
    assert.equal(a.submitGate, null, `${a.id} must have no submit gate`);
  }
});

test('account-less packs declare a tight formSelector (never document.body)', () => {
  for (const a of [lever, greenhouse, ashby, bamboohr]) {
    assert.equal(typeof a.formSelector, 'string');
    assert.ok(a.formSelector.length > 0, `${a.id} formSelector missing`);
    assert.ok(!/document\.body|\bbody\b/.test(a.formSelector), `${a.id} formSelector must not target body`);
  }
});

test('BambooHR isHoneypot: true for nickname_* traps, false for a real firstName field', () => {
  assert.equal(bamboohr.isHoneypot(el({ name: 'nickname_8a3f', type: 'text' })), true);
  assert.equal(bamboohr.isHoneypot(el({ name: 'nickname_', type: 'text' })), true);
  // placeholder "leave this field blank" is also a trap.
  assert.equal(bamboohr.isHoneypot(el({ name: 'x', placeholder: 'Please leave this field blank' })), true);
  // a real field is NOT a honeypot.
  assert.equal(bamboohr.isHoneypot(el({ name: 'firstName', type: 'text' })), false);
  assert.equal(bamboohr.isHoneypot(el({ name: 'email', type: 'email' })), false);
  assert.equal(bamboohr.isHoneypot(null), false);
});

test('account-less packs expose an isHoneypot hook (others are no-trap)', () => {
  for (const a of [lever, greenhouse]) {
    assert.equal(typeof a.isHoneypot, 'function');
    assert.equal(a.isHoneypot(el({ name: 'firstName' })), false);
  }
});

test('isSubmitHint: recognises the FINAL submit, rejects non-submit controls', () => {
  // Lever — "Submit application" text or button.template-btn-submit.
  assert.equal(lever.isSubmitHint('Submit application', el({})), true);
  assert.equal(lever.isSubmitHint('', el({ selectorMatches: ['button.template-btn-submit'] })), true);
  assert.equal(lever.isSubmitHint('Next', el({})), false);
  assert.equal(lever.isSubmitHint('Attach Resume/CV', el({})), false);

  // Greenhouse — submit_app id / button[type=submit].btn--pill / "Submit application".
  assert.equal(greenhouse.isSubmitHint('Submit application', el({})), true);
  assert.equal(greenhouse.isSubmitHint('', { id: 'submit_app', matches: () => false }), true);
  assert.equal(greenhouse.isSubmitHint('Attach', el({})), false);

  // Ashby — "Submit Application" / button[class*=_primary].
  assert.equal(ashby.isSubmitHint('Submit Application', el({})), true);
  assert.equal(ashby.isSubmitHint('', el({ selectorMatches: ['button[class*="_primary"]'] })), true);
  assert.equal(ashby.isSubmitHint('Upload File', el({})), false);

  // BambooHR — "Submit Application" OR a submit-typed button whose text says submit.
  assert.equal(bamboohr.isSubmitHint('Submit Application', el({})), true);
  assert.equal(
    bamboohr.isSubmitHint('Submit', el({ type: 'submit', selectorMatches: ['button[type="submit"]'], text: 'Submit' })),
    true,
  );
  assert.equal(bamboohr.isSubmitHint('Cancel', el({})), false);

  // Workday — "Submit" / "Soumettre" exact (FR).
  assert.equal(workday.isSubmitHint('Submit', el({})), true);
  assert.equal(workday.isSubmitHint('Soumettre', el({})), true);
  assert.equal(workday.isSubmitHint('Next', el({})), false);
});

test('confirmSignalsMatched only counts NEW post-submit confirmation (never weakens R1)', () => {
  const sigs = lever.confirmSignals;   // includes /application (received|submitted)/i
  // NEW after submit (absent before) → matches.
  assert.ok(confirmSignalsMatched(sigs, 'Submit application', 'Application received — thank you'));
  // Present BEFORE too (pre-existing static copy) → does NOT count.
  assert.equal(
    confirmSignalsMatched(sigs, 'Application received already', 'Application received already'),
    null,
  );
  // No signals / no after-text → null.
  assert.equal(confirmSignalsMatched([], 'x', 'application received'), null);
  assert.equal(confirmSignalsMatched(sigs, 'x', ''), null);
  // String signals are treated as literal substrings.
  assert.ok(confirmSignalsMatched(['Thank you for applying'], 'form', 'Thank you for applying!'));
});
