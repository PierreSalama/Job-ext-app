// JAT v11 — Easy-Apply OPENER-STALL decision (pure, node-testable core).
//
// F2 REGRESSION FIX (keystone). When the executor clicks the Easy-Apply OPENER but the modal
// does NOT mount (the page doesn't change and no apply form appears), the old code fed that
// straight into the duplicate-opener breaker: the next loop re-detected the same opener,
// recomputed the same page-action fingerprint, matched lastPageAction, and FAILED the task
// ("repeated page-level action … Easy Apply") — without ever bringing the apply window to the
// FRONT. On the regressed build the apply window is created un-focused (occluded ⇒ Chrome
// throttles its JS ⇒ the modal can't mount), so this was the dominant failure (43/177).
//
// The fix: on an opener click that produced NO mount, FIRST request the apply window be
// fronted (un-throttle it) and WAIT/RETRY for hydration; only AFTER a genuine fronted retry
// still yields no modal do we let it count toward the breaker / fail.
//
// This module is the PURE decision so it can be unit-tested without a browser. The executor
// supplies the live signals; this returns whether to front+retry vs. let the breaker proceed.

// ============================================================
// CLOSED POSTING — the stall that is not a bug.
// ============================================================
// LIVE DATA (2026-08-25): every LinkedIn failure in three days was the same shape — the opener
// was found and clicked, the modal never mounted, the fronted retry spent, and the task failed
// as "repeated page-level action did not transfer". Fetching six of those postings showed two
// were simply CLOSED: LinkedIn leaves the Easy Apply button on the page after a posting stops
// accepting applications, and clicking it does nothing at all.
//
// A closed posting is not a hydration problem, so fronting the window cannot help and the
// duplicate-opener breaker's verdict ("needs inspection") is wrong and misleading. Detect it and
// terminal-SKIP with the true reason, so the pool stops re-burning it and the number Pierre reads
// stops counting dead postings as failures.
//
// Pure and node-testable: the executor passes document text, this decides.
const POSTING_CLOSED_RX = /no longer accepting applications|this job is no longer available|applications are closed|position (?:has been|is) (?:filled|closed)/i;

// Does this page say, in LinkedIn's own words, that it has stopped accepting applications?
// Text only — never a selector, so a markup change cannot silently turn this off.
function isPostingClosed(pageText) {
  return POSTING_CLOSED_RX.test(String(pageText == null ? '' : pageText));
}

// Should we front the apply window and retry, instead of failing on a repeated opener?
//
// Front+retry exactly when ALL hold:
//   • we're at the OPENER stage (no apply form open yet) — haveForm === false
//   • this is the LinkedIn/in-page Easy-Apply opener path (not an external/company CTA, which
//     has its own handoff + no-progress cap) — isExternalClick === false
//   • the click did NOT change the page AND no apply form/modal mounted — changed === false &&
//     modalMounted === false
//   • we have NOT already done a fronted retry for this stall (one fronted retry, then defer to
//     the breaker so a genuinely dead opener still fails) — alreadyFronted === false
//
// Returns { front: boolean, reason: string }.
function shouldFrontOnOpenerStall({
  haveForm,
  isExternalClick,
  changed,
  modalMounted,
  alreadyFronted,
  postingClosed,
} = {}) {
  // A closed posting is checked FIRST: it explains the stall completely, and every branch below
  // would otherwise waste a fronted retry on a button that can never work.
  if (postingClosed) return { front: false, reason: 'posting-closed', terminal: true };
  if (haveForm) return { front: false, reason: 'form-already-open' };
  if (isExternalClick) return { front: false, reason: 'external-route-has-own-cap' };
  if (changed) return { front: false, reason: 'page-changed' };
  if (modalMounted) return { front: false, reason: 'modal-mounted' };
  if (alreadyFronted) return { front: false, reason: 'already-fronted-retry-spent' };
  // Default-deny: only front when the caller AFFIRMATIVELY reports the opener-stall case
  // (no change AND no mount). Missing/unknown signals must never front blindly.
  if (changed !== false || modalMounted !== false) {
    return { front: false, reason: 'insufficient-signal' };
  }
  return { front: true, reason: 'opener-clicked-no-mount-front-and-retry' };
}

// ============================================================
// OPENING vs MID-FLOW routing for the "page did not change after click" path.
// ============================================================
// LIVE BUG (Open Systems): on a mid-flow "Review" click that didn't advance (a form was
// already open this run, haveForm/everHadForm true), the OPENER-STALL front path
// (shouldFrontOnOpenerStall → requestFrontUntilHydrated) was evaluated FIRST and consumed
// the one fronted retry, then the duplicate-opener breaker failed the task ("duplicate
// opener blocked") — BEFORE the advance-blocked answer-rescan (re-scan current page for
// unanswered required fields → answer → retry → park) could run. The two behaviors are
// both correct, they were just mis-ordered.
//
// classifyNoChangeRoute is the PURE decision: given the live opening-vs-mid-flow signals,
// return which handler the no-change path should take. The executor routes on it so:
//   • OPENING (the Easy-Apply opener was clicked, no form has opened yet) → 'opener-stall'
//     (front-until-hydrate the un-mounted modal, then the duplicate-opener breaker).
//   • MID-FLOW (a form has already opened this run — a Next/Review/Submit advance click) →
//     'answer-rescan' (re-scan THIS page for unanswered required fields, answer, retry,
//     park). NEVER the opener-stall/duplicate-opener path.
//   • EXTERNAL click → 'external' (its own handoff + no-progress cap own that path).
//
// "Mid-flow" is keyed on everHadForm (the form has appeared at least once this run), not
// only the instantaneous haveForm — so a brief React transition that momentarily drops the
// dialog after a Review click can't mis-route the click as a fresh opener.
//
// Returns { route: 'opener-stall' | 'answer-rescan' | 'external', reason }.
function classifyNoChangeRoute({
  haveForm,
  everHadForm,
  isExternalClick,
} = {}) {
  if (isExternalClick) return { route: 'external', reason: 'external-click-has-own-cap' };
  // Mid-flow: a form is open now OR has opened at least once this run → this was an in-form
  // advance (Next/Review/Submit) that didn't move. Re-scan + answer required fields; never
  // treat it as an opener stall.
  if (haveForm || everHadForm) return { route: 'answer-rescan', reason: 'mid-flow-advance' };
  // Opening: no form has ever opened this run → the click was the Easy-Apply opener.
  return { route: 'opener-stall', reason: 'opening-click' };
}

export { shouldFrontOnOpenerStall, classifyNoChangeRoute, isPostingClosed };
