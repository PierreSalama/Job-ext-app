// A signed-out browser must be DETECTED and must HALT LinkedIn dispatch.
//
// The worst outage this project has had: 2026-08-06 → 08-07 the applier sat signed out of LinkedIn
// for 31 hours while every dashboard read healthy. Each dispatch loaded a job page, hit the sign-in
// wall, waited 30s for a control that could never appear, and reported the generic "no advance
// button found — will retry". The next worker then tried again. Nothing anywhere named the real
// cause, so it produced ZERO applications while making hundreds of automated requests from a
// signed-out session — the pattern that earns an account an automated-access warning.
//
// Two halves, both required:
//   1. the executor RECOGNISES the sign-in wall instead of timing out on it;
//   2. the app LATCHES it, so one report stops LinkedIn dispatch for every worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const executor = read('extension', 'content', 'executor.js');
const db = read('app', 'src', 'db.js');
const server = read('app', 'src', 'server.js');

// ---- 1. detection -----------------------------------------------------------------------------

// Reproduce the detector's decision so the intent is pinned independently of the source text.
function signedOut({ host, hasPassword, text }) {
  if (!/(^|\.)linkedin\.com$/i.test(host)) return false;
  if (!hasPassword) return false;
  if (!/\bsign in\b/i.test(text)) return false;
  return /\bjoin now\b/i.test(text) || /sign in with email/i.test(text) || /new to linkedin/i.test(text);
}

test('the live signed-out page is recognised', () => {
  // Verbatim from the transcript of the 31-hour outage.
  const live = 'Skip to main content LinkedIn Java Full stack Developer in North York, ON Expand search '
    + 'Join now Sign in Java Full stack Developer Aptino, Inc. Toronto, Ontario, Canada';
  assert.equal(signedOut({ host: 'www.linkedin.com', hasPassword: true, text: live }), true);
});

test('a signed-IN job page is never mistaken for signed-out', () => {
  // Also verbatim — the logged-in nav, captured after Pierre signed back in.
  const ok = '0 notifications Skip to search Skip to main content Home 52 My Network Jobs 22 Messaging';
  assert.equal(signedOut({ host: 'www.linkedin.com', hasPassword: false, text: ok }), false);
});

test('BOTH signals are required — neither alone may halt a working node', () => {
  const wall = 'Join now Sign in';
  assert.equal(signedOut({ host: 'www.linkedin.com', hasPassword: false, text: wall }), false,
    'sign-in copy alone (e.g. a footer link) must not trip it');
  assert.equal(signedOut({ host: 'www.linkedin.com', hasPassword: true, text: 'Application form' }), false,
    'a password field alone must not trip it');
});

test('non-LinkedIn hosts are out of scope', () => {
  const wall = 'Join now Sign in';
  assert.equal(signedOut({ host: 'boards.greenhouse.io', hasPassword: true, text: wall }), false);
});

test('the executor checks BEFORE the 30s hydrate wait, not after', () => {
  assert.match(executor, /function linkedInSignedOut\(\)/, 'detector must exist');
  const iCheck = executor.indexOf('if (linkedInSignedOut())');
  const iWait = executor.indexOf("'no advance button — waiting for the page (or you)'");
  assert.ok(iCheck > -1 && iWait > -1, 'both the check and the wait are present');
  assert.ok(iCheck < iWait,
    'checking after the wait would still burn 30s per job — the whole cost of the outage');
});

// ---- 2. the latch -----------------------------------------------------------------------------

test('db exposes a latch that survives across workers', () => {
  for (const fn of ['setSignedOut', 'clearSignedOut', 'isSignedOut', 'signedOutStatus', 'signedOutEligible']) {
    assert.ok(db.includes(`function ${fn}`), `${fn} must exist`);
    assert.match(db, new RegExp(`\\b${fn}\\b`), `${fn} must be exported`);
  }
});

test('the latch holds LinkedIn work but lets other sources keep running', () => {
  // Mirrors signedOutEligible: going fully idle would be a worse outcome than the bug.
  const eligible = (latched, source) => !latched || String(source).toLowerCase() !== 'linkedin';
  assert.equal(eligible(true, 'linkedin'), false, 'LinkedIn work is held');
  assert.equal(eligible(true, 'greenhouse'), true, 'Greenhouse keeps going');
  assert.equal(eligible(true, 'indeed'), true, 'Indeed keeps going');
  assert.equal(eligible(false, 'linkedin'), true, 'not latched → everything flows');
});

test('one report latches for everyone, and dispatch reports a NAMED reason', () => {
  assert.match(server, /parkReason === 'signed_out'/, 'the executor report must set the latch');
  assert.match(server, /db\.setSignedOut\(/, 'latch is set server-side, not per-worker');
  assert.match(server, /reason: 'signed-out'/, "queueNext must idle with a NAMED reason, not 'empty'");
  assert.match(server, /signedOutDeferred/, 'the held-back case must be tracked distinctly');
});

test('a successful LinkedIn apply clears the latch automatically', () => {
  assert.match(server, /db\.clearSignedOut\(\)/, 'must self-clear');
  const clear = server.slice(server.indexOf('...and clear it the moment'));
  assert.match(clear.slice(0, 600), /'done', 'awaiting_review'/,
    'a real success is the proof the session is back — no manual reset button');
});

test('the latch state is queryable, so a monitor can name the fault', () => {
  assert.match(server, /pathname === '\/auto-apply\/signed-out'/,
    'inferring this from a pile of generic failures is what cost 31 hours');
});
