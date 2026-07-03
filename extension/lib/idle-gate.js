// ── IDLE GATE (opt-in "only auto-apply while I'm away") ──────────────────────────
// When the user turns on autoApply.idleOnly, the engine should PAUSE the instant the
// user is actually using the computer and RESUME only when they are completely idle
// with nothing playing. This is the pure, deterministic decision behind that toggle so
// it can be unit-tested without Chrome.
//
// "busy" (→ pause new dispatch + discovery) is true when EITHER:
//   • the user gave recent mouse/keyboard input — chrome.idle.queryState(threshold)
//     returned 'active' (input within the threshold window), OR
//   • any browser tab is currently playing audio/video — a non-zero count from
//     chrome.tabs.query({ audible: true }) (covers a YouTube video, music, a call).
//
// A 'locked' or 'idle' state with NO audible tab is NOT busy → that is exactly the
// "away and nothing playing" condition we want to auto-apply in. Native-app audio (a
// desktop video player outside the browser) is not observable from the extension and is
// a known limitation, documented in the settings hint.
//
// Inputs are injected (idleState string, audibleTabCount number) so the rule is pure.
// returns: { busy, activeInput, mediaPlaying, reason, idleState }

/**
 * @param {'active'|'idle'|'locked'|string} idleState  chrome.idle.queryState result
 * @param {number} audibleTabCount  number of tabs currently playing audio
 * @returns {{busy:boolean, activeInput:boolean, mediaPlaying:boolean, reason:string, idleState:string}}
 */
export function computeIdleGate(idleState, audibleTabCount) {
  const activeInput = idleState === 'active';
  const mediaPlaying = Number(audibleTabCount) > 0;
  const busy = activeInput || mediaPlaying;
  let reason = '';
  if (activeInput) reason = "you're using the computer";
  else if (mediaPlaying) reason = 'media is playing';
  return { busy, activeInput, mediaPlaying, reason, idleState: idleState || 'unknown' };
}

/**
 * Clamp a user-supplied idle threshold to a sane range. chrome.idle enforces a 15s floor
 * (values below 15 throw), so we never pass it less than that.
 * @param {*} seconds
 * @returns {number} integer seconds in [15, 3600]
 */
export function clampIdleThreshold(seconds) {
  const n = Math.floor(Number(seconds));
  if (!Number.isFinite(n)) return 60;
  return Math.max(15, Math.min(3600, n));
}
