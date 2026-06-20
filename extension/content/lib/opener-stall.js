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
} = {}) {
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

export { shouldFrontOnOpenerStall };
