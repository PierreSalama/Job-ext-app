// LinkedIn restricting the account must stop EVERYTHING, immediately and permanently.
//
// Live 2026-08-10 02:28. LinkedIn served a full-page checkpoint:
//
//   "Your account has been temporarily restricted"
//   "We restricted your account because we detected that over time, it has accessed an unusually
//    high volume of LinkedIn profile data."
//   "Your restriction will be lifted on August 10, 2026 12:27 AM PDT."
//
// JAT did not notice. It kept dispatching into a sanctioned account until Pierre happened to look at
// the screen. Nothing in the system could distinguish "this page failed" from "the platform has
// sanctioned this account".
//
// Deliberately NOT the signed-out latch, which holds only LinkedIn work and CLEARS ITSELF on the
// next successful apply. Both behaviours are wrong for a sanction: every further request is evidence
// against the account, and auto-resuming is how a temporary restriction becomes a permanent ban.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const executor = read('extension', 'content', 'executor.js');
const server = read('app', 'src', 'server.js');
const main = read('app', 'src', 'main.js');

// Mirror the detector.
function restricted({ host, pathname = '/jobs/view/1', text }) {
  if (!/(^|\.)linkedin\.com$/i.test(host)) return false;
  if (/your account has been (temporarily )?restricted/i.test(text)) return true;
  if (/we (have )?restricted your account/i.test(text)) return true;
  if (/unusually high volume of linkedin/i.test(text)) return true;
  return /\/checkpoint\//i.test(pathname) && /restrict/i.test(text);
}

// Verbatim from the page Pierre was shown.
const LIVE = 'LinkedIn Sign in Join now Your account has been temporarily restricted '
  + 'We restricted your account because we detected that over time, it has accessed an unusually '
  + 'high volume of LinkedIn profile data. Your restriction will be lifted on August 10, 2026 12:27 AM PDT.';

test('the live restriction page is detected', () => {
  assert.equal(restricted({ host: 'www.linkedin.com', pathname: '/checkpoint/challenge/AgHqPEnWn21', text: LIVE }), true);
});

test('each restriction phrasing is caught on its own', () => {
  assert.equal(restricted({ host: 'www.linkedin.com', text: 'Your account has been restricted' }), true);
  assert.equal(restricted({ host: 'www.linkedin.com', text: 'We restricted your account because…' }), true);
  assert.equal(restricted({ host: 'www.linkedin.com', text: 'an unusually high volume of LinkedIn profile data' }), true);
});

test('ordinary pages are never mistaken for a restriction', () => {
  const job = '0 notifications Home My Network Jobs Messaging — Backend Developer at Acme. Easy Apply';
  assert.equal(restricted({ host: 'www.linkedin.com', text: job }), false);
  const signedOutJob = 'Skip to main content LinkedIn Join now Sign in Backend Developer Curiosity Learning';
  assert.equal(restricted({ host: 'www.linkedin.com', text: signedOutJob }), false,
    'merely being signed out is a different, far less serious condition');
});

test('a benign checkpoint (2FA/verification) does not trip it', () => {
  assert.equal(restricted({ host: 'www.linkedin.com', pathname: '/checkpoint/challenge/x', text: 'Enter the code we sent to your email' }), false,
    'checkpoint URLs are also used for ordinary verification — the URL alone must not be enough');
});

test('non-LinkedIn hosts are out of scope', () => {
  assert.equal(restricted({ host: 'boards.greenhouse.io', text: LIVE }), false);
});

// ---- ordering: restriction must win over signed-out -------------------------------------------
test('the restriction page ALSO looks signed-out, so it must be checked first', () => {
  // The interstitial renders "Sign in" and "Join now" in its header, so the signed-out detector
  // fires on it too. Checking signed-out first would report the wrong, much milder cause.
  const iRestrict = executor.indexOf("reportIfRestricted('before the hydrate wait')");
  const iSigned = executor.indexOf("reportIfSignedOut('before the hydrate wait')");
  assert.ok(iRestrict > -1 && iSigned > -1, 'both checks present');
  assert.ok(iRestrict < iSigned, 'restriction must be evaluated before signed-out');

  const iRestrict2 = executor.indexOf("reportIfRestricted('terminal no-advance')");
  const iSigned2 = executor.indexOf("reportIfSignedOut('terminal no-advance')");
  assert.ok(iRestrict2 > -1 && iRestrict2 < iSigned2, 'same ordering on the terminal path');
});

// ---- the response is a HARD stop ---------------------------------------------------------------
test('it stops the ENGINE, not just LinkedIn work', () => {
  const block = server.slice(server.indexOf("if (body.parkReason === 'account_restricted'"));
  const body = block.slice(0, block.indexOf('// SIGNED-OUT LATCH'));
  assert.match(body, /autoApply: \{ enabled: false/, 'auto-apply must be turned off outright');
  assert.match(body, /discovery: \{ enabled: false \}/,
    'discovery scrapes LinkedIn search even when not applying — it is the volume they measured');
  assert.match(body, /startedAt: ''/, 'the running-for timer must not keep counting');
});

test('it does NOT self-clear the way the signed-out latch does', () => {
  const block = server.slice(server.indexOf("if (body.parkReason === 'account_restricted'"));
  const body = block.slice(0, block.indexOf('// SIGNED-OUT LATCH'));
  assert.doesNotMatch(body, /clearSignedOut|clearRestricted/,
    'auto-resuming after a sanction is how a temporary restriction becomes a permanent ban');
});

test('the restriction is recorded so it survives a restart', () => {
  const block = server.slice(server.indexOf("if (body.parkReason === 'account_restricted'"));
  const body = block.slice(0, block.indexOf('// SIGNED-OUT LATCH'));
  assert.match(body, /linkedInRestrictedAt/, 'when it happened');
  assert.match(body, /linkedInRestrictedReason/, 'and why');
});

test('Pierre is alerted once, loudly, on both channels', () => {
  const block = server.slice(server.indexOf("if (body.parkReason === 'account_restricted'"));
  const body = block.slice(0, block.indexOf('// SIGNED-OUT LATCH'));
  assert.match(body, /if \(!wasRestricted && opts\.notify\)/, 'once per restriction, not once per task');

  const m = main.slice(main.indexOf("if (type === 'accountRestricted')"));
  const alert = m.slice(0, m.indexOf("if (type === 'signedOut')"));
  assert.match(alert, /nativeNotify\(/, 'native OS popup — he found the last one by looking at a screen');
  assert.match(alert, /will not resume on their own/i, 'the message must say it stays stopped');
});
