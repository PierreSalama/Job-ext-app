// JAT v11 — bot-challenge / Cloudflare circuit-breaker tests.
//
// Two units under test, both pure and node-importable:
//   (1) detectBotChallenge() — must FIRE on real Cloudflare/Indeed challenge interstitials
//       and CAPTCHA walls, and must NOT fire on a normal Indeed job page or a normal
//       application form that merely contains the word "verify".
//   (2) shouldDispatchHost() / trippedEntry() — the host circuit breaker's cooldown logic:
//       a host trips after a challenge, parks same-host jobs during the cooldown, and
//       resumes once the window elapses.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ch = await import(pathToFileURL(path.join(here, '..', 'extension', 'content', 'lib', 'challenge.js')).href);
const br = await import(pathToFileURL(path.join(here, '..', 'extension', 'lib', 'host-breaker.js')).href);
const { detectBotChallenge, botChallengeLastError } = ch;
const { shouldDispatchHost, trippedEntry, hostOfUrl, HOST_BREAKER_COOLDOWN_MS, backoffMs } = br;

// ---- FIXTURES: real-world challenge interstitials (MUST be blocked) ----

// Cloudflare "Checking your browser" managed-challenge interstitial (the classic wall).
const CF_CHECKING = {
  url: 'https://ca.indeed.com/viewjob?jk=abc123',
  title: 'Just a moment...',
  bodyText: 'Checking your browser before accessing ca.indeed.com. This process is automatic. '
    + 'Your browser will redirect to your requested content shortly. Please enable JavaScript and cookies to continue. '
    + 'DDoS protection by Cloudflare. Ray ID: 8a1f2c3d4e5f6a7b',
  hasRayId: true,
};

// Cloudflare "Attention Required" block page with a Ray ID (403-style).
const CF_ATTENTION = {
  url: 'https://www.indeed.com/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1',
  title: 'Attention Required! | Cloudflare',
  bodyText: 'Attention Required! Please complete the security check to access www.indeed.com. '
    + 'Why do I have to complete a CAPTCHA? Cloudflare Ray ID: 79f0aa2b1c. Performance & security by Cloudflare.',
  hasRayId: true,
};

// Indeed "Additional Verification Required" (verify-you-are-human) interstitial.
const INDEED_VERIFY = {
  url: 'https://ca.indeed.com/m/jobs',
  title: 'Additional Verification Required',
  bodyText: 'Additional Verification Required. To continue, please verify you are a human. '
    + 'We have detected unusual activity from your network. Verify you are human to continue.',
  hasRayId: false,
};

// hCaptcha wall.
const HCAPTCHA = {
  url: 'https://example-ats.com/apply',
  title: 'Verify',
  bodyText: 'Please complete the security check to continue.',
  // The widget marker is the strong signal here.
  hasRayId: false,
  _extra: 'hcaptcha h-captcha checkbox',
};

// ---- FIXTURES: normal pages (MUST NOT be blocked) ----

const NORMAL_INDEED_JOB = {
  url: 'https://ca.indeed.com/viewjob?jk=deadbeef',
  title: 'Software Developer - Acme Corp | Indeed.com',
  bodyText: 'Software Developer at Acme Corp. Apply now. Full job description. '
    + 'Responsibilities: build features, review code. Benefits: health, dental. '
    + 'Easily apply. Report this job. Save this job. Verify your email to get job alerts. '
    + 'Cloudflare is one of our customers — we build CDN tooling. ',
  hasRayId: false,
};

const NORMAL_APPLY_FORM = {
  url: 'https://boards.greenhouse.io/acme/jobs/12345/apply',
  title: 'Apply — Senior Engineer',
  bodyText: 'Application form. First name. Last name. Email. Resume/CV. Cover letter. '
    + 'Please verify your email address after submitting. We are an equal opportunity employer. '
    + 'Are you authorized to work in the country? Submit application.',
  hasRayId: false,
};

test('Cloudflare "checking your browser" interstitial → blocked (cloudflare)', () => {
  const r = detectBotChallenge(CF_CHECKING);
  assert.equal(r.blocked, true);
  assert.equal(r.kind, 'cloudflare');
});

test('Cloudflare "Attention Required" block page with Ray ID → blocked (cloudflare)', () => {
  const r = detectBotChallenge(CF_ATTENTION);
  assert.equal(r.blocked, true);
  assert.equal(r.kind, 'cloudflare');
});

test('Indeed "Additional Verification Required" → blocked', () => {
  const r = detectBotChallenge(INDEED_VERIFY);
  assert.equal(r.blocked, true);
  assert.ok(r.kind === 'cloudflare' || r.kind === 'verify', `kind was ${r.kind}`);
});

// --- SELF-CLEARING axis ("have a go"): a Cloudflare interstitial with NO interactive widget
// is self-clearing (the executor waits it out, no interaction); a rendered widget is NOT. ---
test('self-clearing: a Cloudflare interstitial with NO interactive widget is selfClearing', () => {
  const r = detectBotChallenge({ ...CF_CHECKING, hasInteractiveWidget: false });
  assert.equal(r.blocked, true);
  assert.equal(r.kind, 'cloudflare');
  assert.equal(r.selfClearing, true, 'managed/JS Cloudflare wall is safe to wait out');
});

test('self-clearing: a Cloudflare gate WITH a rendered interactive widget is NOT selfClearing', () => {
  const r = detectBotChallenge({ ...CF_CHECKING, hasInteractiveWidget: true });
  assert.equal(r.blocked, true);
  assert.equal(r.kind, 'cloudflare');
  assert.equal(r.selfClearing, false, 'a rendered Turnstile/captcha widget needs a human — never auto-waited-then-resumed');
});

test('self-clearing is NEVER true for an interactive captcha or a verify gate', () => {
  const cap = detectBotChallenge({ ...HCAPTCHA, bodyText: HCAPTCHA.bodyText + ' ' + HCAPTCHA._extra });
  assert.equal(cap.kind, 'captcha');
  assert.equal(cap.selfClearing, false);
  const ver = detectBotChallenge(INDEED_VERIFY);
  if (ver.kind === 'verify') assert.equal(ver.selfClearing, false, 'verify/unusual-traffic gates do not self-clear');
});

test('a captcha marker WITH a rendered interactive widget → blocked (captcha)', () => {
  // A real hCaptcha/reCAPTCHA challenge: the marker AND an actually-rendered widget present.
  const r = detectBotChallenge({ url: 'https://jobs.example.com/apply', title: 'Apply', bodyText: 'hcaptcha h-captcha checkbox', hasInteractiveWidget: true });
  assert.equal(r.blocked, true);
  assert.equal(r.kind, 'captcha');
});

test('FALSE-POSITIVE GUARD: a captcha marker with NO rendered widget is NOT blocked (the invisible-reCAPTCHA badge)', () => {
  // Indeed and most sites embed the "protected by reCAPTCHA" privacy BADGE + an invisible/score-based
  // widget for BACKGROUND form protection — there is NO challenge to solve. Marker present, no
  // interactive widget, no challenge copy → must NOT block. This false positive aborted EVERY Indeed
  // apply as bot_challenge ("captcha widget marker" on a normal smartapply page).
  const r = detectBotChallenge({
    url: 'https://smartapply.indeed.com/beta/indeedapply/form/questions',
    title: 'Apply: Backend Engineer | Indeed',
    bodyText: 'Add your information. Full name. Email address. protected by reCAPTCHA · Privacy · Terms.',
    hasInteractiveWidget: false,
  });
  assert.equal(r.blocked, false, `badge-only must NOT block (got ${r.kind}: ${r.reason})`);
});

test('press-and-hold human-verify wall → blocked (captcha)', () => {
  const r = detectBotChallenge({
    url: 'https://jobs.example.com/apply',
    title: 'Verify',
    bodyText: 'Press and hold to confirm you are a human.',
  });
  assert.equal(r.blocked, true);
  assert.equal(r.kind, 'captcha');
});

test('FALSE-POSITIVE GUARD: a normal Indeed job page is NOT blocked', () => {
  const r = detectBotChallenge(NORMAL_INDEED_JOB);
  assert.equal(r.blocked, false, `should not flag a normal job page (got ${r.kind}: ${r.reason})`);
});

test('FALSE-POSITIVE GUARD: a normal application form mentioning "verify your email" is NOT blocked', () => {
  const r = detectBotChallenge(NORMAL_APPLY_FORM);
  assert.equal(r.blocked, false, `should not flag a normal apply form (got ${r.kind}: ${r.reason})`);
});

test('FALSE-POSITIVE GUARD: empty/undefined inputs are NOT blocked', () => {
  assert.equal(detectBotChallenge().blocked, false);
  assert.equal(detectBotChallenge({}).blocked, false);
  assert.equal(detectBotChallenge({ url: '', title: '', bodyText: '' }).blocked, false);
});

test('botChallengeLastError carries the kind and the "needs human" contract phrase', () => {
  const s = botChallengeLastError('cloudflare');
  assert.match(s, /bot challenge \(cloudflare\)/i);
  assert.match(s, /needs human verification/i);
  // Unknown kind degrades gracefully.
  assert.match(botChallengeLastError('weird'), /bot challenge/i);
});

// ---- host circuit breaker cooldown ----

test('hostOfUrl strips www and lowercases; bad URLs → empty', () => {
  assert.equal(hostOfUrl('https://www.Indeed.com/viewjob?jk=1'), 'indeed.com');
  assert.equal(hostOfUrl('https://ca.indeed.com/m/jobs'), 'ca.indeed.com');
  assert.equal(hostOfUrl('not a url'), '');
  assert.equal(hostOfUrl(null), '');
});

test('breaker: a fresh host dispatches; a tripped host is parked until cooldown elapses', () => {
  const state = new Map();
  const host = 'indeed.com';
  const t0 = 1_000_000;

  // Fresh host → dispatch allowed.
  assert.equal(shouldDispatchHost(host, t0, state).dispatch, true);

  // Challenge detected → trip the breaker.
  state.set(host, trippedEntry(state.get(host), 'cloudflare', t0));
  const entry = state.get(host);
  assert.equal(entry.kind, 'cloudflare');
  assert.equal(entry.hits, 1);
  assert.equal(entry.until, t0 + HOST_BREAKER_COOLDOWN_MS);

  // Inside the cooldown → do NOT dispatch (park same-host jobs).
  const mid = shouldDispatchHost(host, t0 + HOST_BREAKER_COOLDOWN_MS - 1, state);
  assert.equal(mid.dispatch, false);
  assert.equal(mid.reason, 'host-cooldown');

  // A DIFFERENT host is unaffected by indeed's wall.
  assert.equal(shouldDispatchHost('linkedin.com', t0 + 5, state).dispatch, true);

  // After the cooldown window → dispatch resumes.
  const after = shouldDispatchHost(host, t0 + HOST_BREAKER_COOLDOWN_MS, state);
  assert.equal(after.dispatch, true);
  assert.equal(after.reason, 'cooled-down');
});

test('breaker: re-tripping extends the window and increments hit count', () => {
  const state = new Map();
  const host = 'ca.indeed.com';
  const t0 = 2_000_000;
  state.set(host, trippedEntry(state.get(host), 'cloudflare', t0));
  // Re-trip 5 min later.
  const t1 = t0 + 5 * 60 * 1000;
  state.set(host, trippedEntry(state.get(host), 'captcha', t1));
  const e = state.get(host);
  assert.equal(e.hits, 2);
  // The window is extended from the NEW trip, and since 2026-08-09 it also BACKS OFF: the second
  // consecutive wall waits twice the base. A host walling us repeatedly was previously re-probed on
  // a constant 20-minute timer forever (live: 8 probes in 3h on one Indeed task, attempts=0).
  // See tests/host-breaker-backoff.test.mjs.
  assert.equal(e.until, t1 + backoffMs(2));
  assert.equal(e.until, t1 + 2 * HOST_BREAKER_COOLDOWN_MS, 'second wall = 2× base');
  assert.equal(e.kind, 'captcha');
});

test('breaker: empty host always dispatches (never blocks an unidentified job)', () => {
  const state = new Map();
  assert.equal(shouldDispatchHost('', Date.now(), state).dispatch, true);
});
