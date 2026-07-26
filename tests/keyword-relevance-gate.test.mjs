// The relevance gate must require a POSITIVE keyword match, not just the absence of banned words.
//
// jobFit was negative-only: keywords built the search query, but nothing re-checked the results.
// Anything discovery dragged in that wasn't on an exclude list got applied to. Live 2026-07-25 on
// Ashraf Salama's machine (telecom / structured-cabling project manager, 11 yrs, Rogers + Bell):
// 36 of 42 queued jobs were off-field — "Call center agent-Arabic Speaker", "Brand Ambassador",
// "Emergency Communications Nurse", "Technology Lead - iOS Developer", Stripe payments roles.
// Banning each bad word is whack-a-mole: an 80-entry exclude list still let
// "Payments Performance Strategist, Network Cost" through. Requiring a positive match fixes the
// class, and widening the net becomes "add a keyword" instead of "guess the next junk word".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { jobFit } = require(path.join(here, '..', 'app', 'src', 'server.js'));

// Ashraf's real keyword set (abridged to the shapes that matter).
const AA = {
  requireKeywordMatch: true,
  seniorityMax: 'any',
  excludeKeywords: [],          // deliberately EMPTY: proves the positive gate alone does the work
  keywords: [
    'project delivery manager', 'telecom project manager', 'structured cabling project manager',
    'construction project manager', 'infrastructure project manager', 'project manager',
    'structured cabling', 'telecommunications', 'telecom', 'fibre optic', 'fiber optic',
    'fibre splicing', 'ftth', 'fttx', 'osp', 'outside plant', 'low voltage',
    'civil engineer', 'structural engineer', 'construction manager', 'site supervisor',
  ],
};

// The exact off-field titles that reached his queue.
const OFF_TARGET = [
  'Call center agent-Arabic Speaker',
  'Call Center Agent - Social Media (Remote)',
  'Analista Jr. de Customer Service',
  'Brand Ambassador',
  'B2B Appointment Setter / Inside Sales Development',
  'Technology Lead - IOS Developer',
  'Technology Lead - Android Developer',
  'Emergency Communications Nurse (ECN)',
  'Customer Care Advisor - August 2026',
  'RQ11176 - Senior Middleware Specialist',
  'Payments Performance Strategist, Network Cost',   // slipped past an 80-entry exclude list
  'Partner Development Manager, Global Networks',
  'Software Engineer, Networking (Dataplane)',
  'Logistics Support Analyst',
];

// Titles that are genuinely his field and must NOT be filtered out.
const ON_TARGET = [
  'Structured Cabling Project Manager',
  'Telecom Project Manager',
  'Project Delivery Manager',
  'Fibre Optic Splicing Technician',
  'Civil Engineer - Municipal Infrastructure',
  'Structural Engineer',
  'Construction Manager, FTTH Build',
  'Outside Plant (OSP) Designer',
  'Low Voltage Project Manager',
  'Senior Project Manager',
  'Telecommunications Analyst',
];

test('off-target titles are rejected with NO exclude list at all', () => {
  const leaked = OFF_TARGET.filter((t) => jobFit({ title: t }, AA).ok);
  assert.deepEqual(leaked, [], 'these should not match any of his keywords');
});

test('on-target titles still pass', () => {
  const blocked = ON_TARGET.filter((t) => !jobFit({ title: t }, AA).ok);
  assert.deepEqual(blocked, [], 'real matches must not be filtered out');
});

test('token order does not matter, and partial phrases still match', () => {
  // "Project Manager, Telecom" ↔ keyword "telecom project manager" (same tokens, different order)
  assert.ok(jobFit({ title: 'Project Manager, Telecom Infrastructure' }, AA).ok);
  // A keyword whose full phrase appears verbatim inside a longer title
  assert.ok(jobFit({ title: 'Senior Structured Cabling Project Manager (GTA)' }, AA).ok);
});

test('the gate is OPT-OUT: off means the old negative-only behaviour', () => {
  const off = { ...AA, requireKeywordMatch: false };
  assert.ok(jobFit({ title: 'Brand Ambassador' }, off).ok, 'with the gate off, nothing requires a match');
});

test('no keywords configured → gate does not lock everything out', () => {
  // A user who has not set keywords yet must not end up with a queue that can never dispatch.
  const noKw = { ...AA, keywords: [] };
  assert.ok(jobFit({ title: 'Anything At All' }, noKw).ok);
});

test('exclusions still apply on top of a positive match', () => {
  const withExcl = { ...AA, excludeKeywords: ['intern'] };
  assert.equal(jobFit({ title: 'Telecom Project Manager Intern' }, withExcl).ok, false);
});

// ---- synonym tolerance -------------------------------------------------------------------------
// A strict all-tokens rule read correctly but over-filtered live: with Pierre's keywords, 36 of 75
// queued jobs were dropped — including "Frontend Engineer" (he has "frontend developer") and
// "Web Programmer" (he has "web developer"). Boards use developer/engineer/programmer for the same
// role, and front end / front-end / frontend for the same word.
const DEV = {
  requireKeywordMatch: true,
  seniorityMax: 'any',
  excludeKeywords: [],
  keywords: ['full stack developer', 'frontend developer', 'web developer', 'software developer', 'react developer'],
};

test('developer / engineer / programmer are the same role noun', () => {
  for (const title of ['Frontend Engineer', 'Web Programmer', 'Software Engineer', 'Full Stack Engineer'])
    assert.ok(jobFit({ title }, DEV).ok, `${title} should match a *developer* keyword`);
});

test('front end / front-end / frontend are the same word', () => {
  for (const title of ['Front End Developer', 'Front-End Developer', 'Frontend Developer'])
    assert.ok(jobFit({ title }, DEV).ok, title);
});

test('French postings match their English keyword (Canadian boards)', () => {
  // Real title from the live queue that was being filtered out as off-target.
  assert.ok(jobFit({ title: 'Développeur(euse) Front-End' }, DEV).ok);
  assert.ok(jobFit({ title: 'Développeur Web' }, DEV).ok);
  // And for Ashraf's French-language equivalents.
  assert.ok(jobFit({ title: 'Chef de projet télécommunications' }, AA).ok);
});

test('synonyms do NOT open the floodgates', () => {
  // engineer→developer must not make unrelated engineering/trade roles match a software keyword.
  for (const title of ['CNC Machinist', 'Electrical Project Engineer', 'PLC Programmer', 'Product Designer'])
    assert.equal(jobFit({ title }, DEV).ok, false, `${title} must stay filtered`);
  // ...and Ashraf's civil-engineering keywords must not swallow software roles.
  assert.equal(jobFit({ title: 'Software Engineer, Networking' }, AA).ok, false);
});
