// JAT v11 — bot-challenge / anti-automation interstitial detector (pure, DOM-free, testable).
//
// Why this exists: Indeed and similar boards serve a Cloudflare "Additional Verification
// Required" / "Checking your browser" / Ray-ID interstitial (or an hCaptcha/reCAPTCHA wall)
// when they think the session is automated. The executor previously had ZERO challenge
// detection: a hidden/throttled apply tab that landed on such a wall looked exactly like an
// OCCLUSION miss (form never hydrated), so it kept fronting the window and burning retry
// attempts, and the diagnostic blamed our own flow ("occlusion") instead of the truth
// (a site bot-gate that needs a human).
//
// This module decides, from a plain description of the page (url/title/bodyText + a couple
// of cheap structural hints), whether the current page is such a challenge. It is
// intentionally DOM-free so the executor can build the description from the live page and
// this stays node-testable against real Cloudflare/Indeed challenge HTML.
//
// CONSERVATISM CONTRACT: only fire on STRONG signals. A normal application form that merely
// contains the word "verify" (e.g. "verify your email"), or a normal Indeed job page, must
// NOT be flagged. False positives here would mis-park drivable jobs and trip the host
// breaker, so every signature below is anchored to phrasing/markers that a real site gate
// uses and a normal page does not.

// --- Cloudflare interstitial: the "Checking your browser" / managed-challenge wall. ---
// Cloudflare's own copy + the challenge plumbing markers (script ids, challenge path,
// cookie/param names). "attention required" + "ray id" is Cloudflare's block page.
const CF_TEXT_RX = /\b(checking your browser before accessing|checking if the site connection is secure|enable javascript and cookies to continue|verifying you are human|verify you are human|this process is automatic|additional verification required|attention required)\b/i;
const CF_RAYID_RX = /\bray id\b|\bray[-_ ]?id:?\s*[0-9a-f]{8,}/i;
// NOTE: deliberately does NOT match the bare brand word "cloudflare" — a normal job page
// can legitimately mention Cloudflare (a customer/employer). Only the challenge plumbing
// (cf_chl token, challenge path, turnstile widget) or the block-page phrasing counts.
const CF_MARKER_RX = /cf-chl|cf_chl|__cf_chl|cf-challenge|\/cdn-cgi\/challenge|challenge-platform|cf-turnstile|class="cf-turnstile"|(?:performance|security|protection)\s*(?:&|and|&amp;)?\s*security\s+by\s+cloudflare|(?:ddos\s+protection|protection)\s+by\s+cloudflare|cloudflare\s+ray\s+id/i;

// --- Generic CAPTCHA walls (hCaptcha / reCAPTCHA / press-and-hold). ---
const CAPTCHA_TEXT_RX = /\b(press (?:and|&) hold|are you a robot|please verify you are (?:a )?human|complete the (?:security )?(?:check|captcha) to continue|select all (?:images|squares))\b/i;
const CAPTCHA_MARKER_RX = /hcaptcha|h-captcha|recaptcha|g-recaptcha|grecaptcha|px-captcha|funcaptcha|arkoselabs/i;

// --- Generic "verify you are human / unusual traffic" gate (Indeed/Google style). ---
const VERIFY_TEXT_RX = /\b(unusual (?:traffic|activity) from your (?:computer|network|device)|we['’\s]?ve detected unusual activity|to continue,? (?:please )?(?:verify|confirm) you are (?:a )?human|help us keep .* secure by verifying|verify you['’\s]?re (?:a )?human)\b/i;

// A short page (challenge interstitials are tiny) reinforces a challenge verdict but is
// never sufficient on its own — a strong textual/marker signal is always required.
const SHORT_PAGE_CHARS = 1500;

function asText(v) { return String(v == null ? '' : v); }

// detectBotChallenge({ url, title, bodyText, hasRayId, statusHint }) →
//   { blocked:boolean, kind:'cloudflare'|'captcha'|'verify'|null, reason:string }
//
// Inputs (all optional, built by the executor from the live page):
//   url        : location.href
//   title      : document.title
//   bodyText   : document.body innerText (the executor slices it; we re-cap defensively)
//   hasRayId   : boolean — best-effort structural hint (a cf ray-id element/marker present)
//   statusHint : number  — best-effort HTTP status if known (403/429/503 reinforce CF)
export function detectBotChallenge({ url, title, bodyText, hasRayId, statusHint } = {}) {
  const u = asText(url);
  const t = asText(title);
  const body = asText(bodyText).slice(0, 20000);
  const hay = `${t}\n${body}`;
  const blob = `${u}\n${hay}`;
  const status = Number(statusHint) || 0;
  const cfStatus = status === 403 || status === 429 || status === 503;

  const no = { blocked: false, kind: null, reason: 'no-challenge' };

  // --- CLOUDFLARE ---
  // Markers in the URL/scripts are the strongest signal (the challenge path / cf_chl param
  // / turnstile widget only appear on a real Cloudflare challenge, never on a job page).
  const cfMarker = CF_MARKER_RX.test(blob);
  const cfText = CF_TEXT_RX.test(hay);
  const cfRay = hasRayId === true || CF_RAYID_RX.test(hay);
  // Fire when: a hard challenge marker present, OR Cloudflare challenge copy present,
  // OR (ray-id + a reinforcing signal: CF status, a short page, or "attention required").
  if (cfMarker || cfText || (cfRay && (cfStatus || body.length < SHORT_PAGE_CHARS || /attention required/i.test(hay)))) {
    const why = cfMarker ? 'cloudflare challenge marker'
      : cfText ? 'cloudflare interstitial copy'
        : 'cloudflare ray-id block page';
    return { blocked: true, kind: 'cloudflare', reason: why };
  }

  // --- CAPTCHA ---
  if (CAPTCHA_MARKER_RX.test(blob) || CAPTCHA_TEXT_RX.test(hay)) {
    const why = CAPTCHA_MARKER_RX.test(blob) ? 'captcha widget marker' : 'captcha challenge copy';
    return { blocked: true, kind: 'captcha', reason: why };
  }

  // --- GENERIC VERIFY / UNUSUAL-TRAFFIC ---
  if (VERIFY_TEXT_RX.test(hay)) {
    return { blocked: true, kind: 'verify', reason: 'verify-you-are-human gate' };
  }

  return no;
}

// Stable, human-honest diagnostic string for a detected challenge. The db failure
// classifier matches the "bot challenge" prefix → a distinct `bot_challenge` category,
// so this is the contract between the executor outcome and the metrics breakdown.
export function botChallengeLastError(kind) {
  const k = kind === 'cloudflare' || kind === 'captcha' || kind === 'verify' ? kind : 'site gate';
  return `bot challenge (${k}) — needs human verification`;
}

export {
  CF_TEXT_RX, CF_RAYID_RX, CF_MARKER_RX,
  CAPTCHA_TEXT_RX, CAPTCHA_MARKER_RX, VERIFY_TEXT_RX,
};
