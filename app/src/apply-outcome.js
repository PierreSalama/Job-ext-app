// WAS THAT A REAL APPLICATION ATTEMPT, OR JUST A PAGE VIEW?
//
// The platform budget is charged the instant a task opens its tab (server.js, on the `running`
// transition) because that is the only honest moment: at that point we cannot yet know whether the
// posting has a form we can drive. A large share of them do not — LinkedIn search results do not
// expose the Easy-Apply badge, so roughly two of every three LinkedIn jobs turn out to be external
// postings. We read the page and leave.
//
// Live on pierre-laptop 2026-08-21: 76 charged dispatches produced 12 applications. The budget was
// being spent on discovering that jobs were not applyable, one job at a time.
//
// This module answers the one question that lets the charge be taken back: given how the task
// ENDED, was an application form ever presented to us? Every pattern below is copied from the
// laptop's own last_error strings — none are invented.
//
// The bias is deliberate and one-directional. Under-refunding costs throughput. Over-refunding
// under-counts the account's real footprint, and under-counting the footprint is exactly what
// caused the 2026-08-10 LinkedIn restriction. So: only a SKIP qualifies, only for these reasons,
// and anything ambiguous stays charged.

// Note the shapes that must NOT match, all of which describe a session that really happened:
//   'no Easy Apply opener and no drivable form appeared (visible tab)'  ← we drove the page
//   'CAPTCHA gate — not auto-solvable by policy'                       ← we hit a wall
//   'host verification wall did not lift within 24h'                   ← ditto
//   'site sign-in gate untouched for 7d'                               ← ditto
//   'smartapply step did not advance — module stuck'                   ← we were inside the form
const NON_ATTEMPT_SKIP_RX = new RegExp([
  // "no Easy Apply on this job/posting" — anchored on "on th" so it cannot swallow
  // "no Easy Apply OPENER and no drivable form appeared", which is a driven page, not a peek.
  'no easy apply on th',
  'external posting',
  'apply on the company site',
  'not auto-applicable',
  'application form is embedded from',
  'needs ~[0-9]+ yrs experience',
  'no reliable easy apply badge',
  '^filtered:',
  '^punished$',
  '^already applied$',
  '^excluded keyword',
  '^job missing or has no url',
].join('|'), 'i');

// state must be the terminal 'skipped'; anything else (parked, failed, done, awaiting_review)
// means a real session and stays charged.
function isNonAttemptSkip(state, lastError) {
  if (String(state || '').toLowerCase() !== 'skipped') return false;
  return NON_ATTEMPT_SKIP_RX.test(String(lastError || ''));
}

module.exports = { NON_ATTEMPT_SKIP_RX, isNonAttemptSkip };
