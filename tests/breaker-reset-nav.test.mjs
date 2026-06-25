// EXTERNAL-HANDOFF REGRESSION — the duplicate-page-action breaker must RESET across a real
// navigation. When an external "Apply on company site (opens in new tab)" actually navigates
// IN-TAB to the company ATS, the company landing page commonly has its OWN "Apply"-labelled
// button. The breaker keys on host+path+label, and was armed on the ORIGIN (LinkedIn) page; if
// it isn't cleared across the navigation, the first (legitimate, different-page) click is
// mistaken for a repeat and the run is killed ("same page-level action repeated — stopping…").
//
// These pin the two pure decisions behind the fix (replay.js) and assert the executor wires
// them in (URL tracking + reset on nav + honest external-child diagnostics).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pageActionUrlKey, shouldResetPageActionBreaker, externalTargetFromNav } from '../extension/content/replay.js';

// ---- pageActionUrlKey: host+path identity (query/hash/trailing-slash/www are render noise) ----
test('pageActionUrlKey normalizes www, trailing slash, query, and hash', () => {
  assert.equal(pageActionUrlKey('https://www.linkedin.com/jobs/view/123/'), 'linkedin.com/jobs/view/123');
  assert.equal(pageActionUrlKey('https://linkedin.com/jobs/view/123?refId=abc'), 'linkedin.com/jobs/view/123');
  assert.equal(pageActionUrlKey('https://linkedin.com/jobs/view/123#section'), 'linkedin.com/jobs/view/123');
});

test('pageActionUrlKey: a different host or path yields a different key', () => {
  const li = pageActionUrlKey('https://www.linkedin.com/jobs/view/123');
  assert.notEqual(li, pageActionUrlKey('https://jobs.acme.com/apply/123'));   // host changed
  assert.notEqual(li, pageActionUrlKey('https://www.linkedin.com/jobs/view/999'));  // path changed
});

test('pageActionUrlKey: same page with only query/hash differences compares EQUAL', () => {
  // Within-page protection must survive query-string re-renders (the genuine opener loop).
  assert.equal(
    pageActionUrlKey('https://jobs.acme.com/apply?step=1'),
    pageActionUrlKey('https://jobs.acme.com/apply?step=1&t=999'),
  );
});

test('pageActionUrlKey: non-absolute input degrades to a stable normalized string', () => {
  assert.equal(pageActionUrlKey('about:blank'), pageActionUrlKey('about:blank'));
  assert.equal(pageActionUrlKey(''), '');
});

// ---- shouldResetPageActionBreaker: reset iff armed AND the page identity changed ----
test('RESET when an armed breaker sees the page navigated to a different host (in-tab handoff)', () => {
  // This is the exact failing scenario: opener armed on LinkedIn, page navigated in-tab to the
  // company ATS. The company "Apply" click must NOT be treated as a repeat.
  assert.equal(shouldResetPageActionBreaker({
    lastActionUrl: 'https://www.linkedin.com/jobs/view/123',
    currentUrl: 'https://jobs.acme.com/apply/123',
    hasPending: true,
  }), true);
});

test('NO reset within the same page — the genuine "opener does not transfer" loop is still caught', () => {
  assert.equal(shouldResetPageActionBreaker({
    lastActionUrl: 'https://jobs.acme.com/apply/123',
    currentUrl: 'https://jobs.acme.com/apply/123',
    hasPending: true,
  }), false);
  // …even when only the query string changed (same page re-rendering, not a navigation).
  assert.equal(shouldResetPageActionBreaker({
    lastActionUrl: 'https://jobs.acme.com/apply/123?step=1',
    currentUrl: 'https://jobs.acme.com/apply/123?step=2',
    hasPending: true,
  }), false);
});

test('NO reset when nothing is armed (hasPending=false) — never resets blind', () => {
  assert.equal(shouldResetPageActionBreaker({
    lastActionUrl: 'https://a.com/x', currentUrl: 'https://b.com/y', hasPending: false,
  }), false);
});

test('NO reset when armed without a recorded URL (lastActionUrl null) — never resets blind', () => {
  assert.equal(shouldResetPageActionBreaker({
    lastActionUrl: null, currentUrl: 'https://b.com/y', hasPending: true,
  }), false);
});

test('missing args default to NO reset (never reset blindly)', () => {
  assert.equal(shouldResetPageActionBreaker(), false);
  assert.equal(shouldResetPageActionBreaker({}), false);
});

// ---- externalTargetFromNav (EXT-2): a host-OR-path change is a transfer; query/hash is noise ----
test('externalTargetFromNav: HOST change is a transfer (linkedin → company)', () => {
  assert.equal(externalTargetFromNav({
    initialUrl: 'https://www.linkedin.com/jobs/view/123',
    currentUrl: 'https://jobs.acme.com/apply/123',
  }), true);
});

test('externalTargetFromNav: PATH-only change on the same host is a transfer (slow /jobs → /jobs/apply)', () => {
  assert.equal(externalTargetFromNav({
    initialUrl: 'https://jobs.acme.com/jobs/123',
    currentUrl: 'https://jobs.acme.com/jobs/123/apply',
  }), true);
});

test('externalTargetFromNav: QUERY/HASH-only change is NOT a transfer (render noise, must not capture)', () => {
  assert.equal(externalTargetFromNav({
    initialUrl: 'https://www.linkedin.com/jobs/view/123',
    currentUrl: 'https://www.linkedin.com/jobs/view/123?refId=abc',
  }), false);
  assert.equal(externalTargetFromNav({
    initialUrl: 'https://www.linkedin.com/jobs/view/123',
    currentUrl: 'https://www.linkedin.com/jobs/view/123#apply',
  }), false);
});

test('externalTargetFromNav: identical / missing URLs are NOT a transfer (never capture blind)', () => {
  assert.equal(externalTargetFromNav({ initialUrl: 'https://x/y', currentUrl: 'https://x/y' }), false);
  assert.equal(externalTargetFromNav({ initialUrl: '', currentUrl: 'https://x/y' }), false);
  assert.equal(externalTargetFromNav({ initialUrl: 'https://x/y', currentUrl: '' }), false);
  assert.equal(externalTargetFromNav(), false);
});

test('externalTargetFromNav: malformed URLs never throw and degrade safely', () => {
  assert.doesNotThrow(() => externalTargetFromNav({ initialUrl: 'about:blank', currentUrl: 'chrome://newtab' }));
});

// ---- background wiring: the service worker must use externalTargetFromNav for same-tab detection ----
const BG = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

test('background imports externalTargetFromNav and uses it in waitForExternalTarget', () => {
  assert.match(BG, /import \{ externalTargetFromNav \} from '\.\/content\/replay\.js'/);
  const fnIdx = BG.indexOf('async function waitForExternalTarget');
  const useIdx = BG.indexOf('externalTargetFromNav({ initialUrl: handoff.initialUrl');
  assert.ok(fnIdx > 0 && useIdx > fnIdx, 'externalTargetFromNav is called inside waitForExternalTarget');
});

test('waitForExternalTarget window is at least 25s (slow same-tab redirect headroom)', () => {
  const m = BG.match(/async function waitForExternalTarget\(sourceTabId, token, timeoutMs = (\d+)\)/);
  assert.ok(m, 'waitForExternalTarget signature found');
  assert.ok(Number(m[1]) >= 25000, `timeout should be >=25000, got ${m[1]}`);
});

// ---- executor wiring: the source must use the helpers and arm the URL alongside the breaker ----
const SRC = fs.readFileSync(new URL('../extension/content/executor.js', import.meta.url), 'utf8');

// ---- EXT-1: the same-tab external fallback must CLEAR the breaker + the no-progress counters,
// so the company landing page's own legitimate "Apply" button isn't read as a repeat. ----
test('EXT-1: external in-tab fallback clears the breaker and the external no-progress counters', () => {
  // Anchor on the in-tab fallback log line, then assert the clears happen before the continue.
  const anchor = SRC.indexOf('external target navigated in-tab — continuing to drive it here');
  assert.ok(anchor > 0, 'in-tab fallback branch present');
  const window = SRC.slice(anchor, anchor + 1600);
  assert.match(window, /lastPageAction = ''; lastPageActionUrl = ''/, 'clears the duplicate-opener breaker');
  assert.match(window, /extRepeat = 0; extLastLabel = ''; extLastUrl = ''/, 'resets the external no-progress cap');
  assert.match(window, /noChange = 0/, 'resets the stall counter');
});

// ---- CAPTCHA human-assist: front the window + wait for the USER to solve, NEVER auto-solve. ----
test('CAPTCHA human-assist: executor fronts the window and waits for the user, never auto-solves', () => {
  assert.match(SRC, /async function waitForCaptchaCleared/, 'has the bounded wait-for-user helper');
  // on a CAPTCHA it fronts the apply window so the user can solve it…
  const i = SRC.indexOf('CAPTCHA — bringing the window to the front');
  assert.ok(i > 0, 'fronts the window on a CAPTCHA');
  const w = SRC.slice(i, i + 600);
  assert.match(w, /jat11\.nudge-apply-window/, 'sends the front-window message');
  assert.match(w, /waitForCaptchaCleared\(/, 'waits for the user to clear it');
  assert.match(SRC, /CAPTCHA cleared by you — continuing the application/, 'continues only after the USER clears it');
  // the never-auto-solve invariant: no code that clicks/checks a captcha widget to bypass it.
  assert.ok(!/solveCaptcha|bypassCaptcha|clickCaptcha/i.test(SRC), 'no auto-solve/bypass path exists');
});

// ---- "Have a go": self-clearing Cloudflare interstitials are waited out (no touch), only for
// the cloudflare+selfClearing case, and the wait re-probes each tick. NEVER touches the widget. ----
test('self-clearing Cloudflare: executor waits it out (no interaction), gated + re-probed', () => {
  assert.match(SRC, /challenge\.kind === 'cloudflare' && challenge\.selfClearing/, 'auto-wait gated on cloudflare+selfClearing only (interactive captcha/verify never enter)');
  const i = SRC.indexOf('waiting for it to clear itself');
  assert.ok(i > 0, 'logs the no-touch wait');
  const w = SRC.slice(i, i + 700);
  assert.match(w, /detectBotChallengeOnPage\(\)/, 're-probes the live page each tick');
  assert.match(w, /if \(!c2\.selfClearing\) break/, 'bails to park the instant a real interactive widget renders');
  assert.match(w, /cleared on its own — continuing/, 'resumes only when the interstitial actually clears');
  // hard line: the self-clearing path adds NO widget interaction (presence-only detection).
  assert.ok(!/solveCaptcha|bypassCaptcha|clickCaptcha/i.test(SRC), 'self-clearing wait never touches a widget');
});

// ---- EXT-4: the AI rescue must DEDUP on an unchanged page within a window (token moderation). ----
test('EXT-4: AI rescue dedups on a stable page signature within 60s', () => {
  assert.match(SRC, /const rescueSig = \[/, 'computes a rescue page signature');
  assert.match(SRC, /rescueSig === lastRescueSig && \(Date\.now\(\) - lastRescueAt\) < 60000/, 'skips a duplicate call within 60s on the same signature');
});

test('executor imports and calls shouldResetPageActionBreaker before the duplicate-action check', () => {
  assert.match(SRC, /shouldResetPageActionBreaker/);
  const resetIdx = SRC.indexOf('shouldResetPageActionBreaker({ lastActionUrl: lastPageActionUrl');
  const breakerIdx = SRC.indexOf('pageAction === lastPageAction');
  assert.ok(resetIdx > 0, 'breaker-reset call present');
  assert.ok(breakerIdx > 0, 'duplicate-action breaker present');
  assert.ok(resetIdx < breakerIdx, 'reset must run BEFORE the duplicate-action comparison');
});

test('executor records lastPageActionUrl whenever it arms lastPageAction', () => {
  // The breaker and its URL must be set together, or the reset has no anchor to compare against.
  assert.match(SRC, /lastPageAction = pageAction; lastPageActionUrl = location\.href/);
});

test('external-child terminal states carry an honest diagnostic (never silent / never "without a diagnostic")', () => {
  // No external terminal path may emit the literal synthetic phrase…
  assert.ok(!/external executor failed without a diagnostic/.test(SRC),
    'the synthetic "…without a diagnostic" string must not appear on the external-child path');
  // …and the failed/skipped child states must set a concrete needs-you reason at the source.
  assert.match(SRC, /handoff failed\) — needs you/);
  assert.match(SRC, /handoff returned skipped\) — needs you/);
});
