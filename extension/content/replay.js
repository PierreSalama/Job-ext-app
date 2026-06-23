// JAT v11 — Recipe Replayer decision module  [Apprenticeship Engine P5]
//
// PURE, NODE-TESTABLE logic for the gated replay path. This module has NO DOM /
// chrome / browser-global access at import time (so it imports cleanly under
// `node --test`); all the DOM work — scanning fields, filling, clicking, pacing
// the real timers — stays in executor.js, which wires its real sources into the
// `ctx` getters and `opts` here.
//
// The replay path is STRICTLY ADDITIVE + GATED + safe-by-construction:
//   • planReplay() decides AUTO only when a high-coverage, high-confidence recipe
//     covers EVERY required field on the live page; otherwise it returns FALLBACK
//     so the executor runs today's discover-every-step flow unchanged.
//   • resolveStepAnswer() walks the same answer ladder the executor already uses,
//     and NEVER emits a URL for a quantity/"how many years" question (the bug that
//     filled a GitHub URL into a years field). On no grounded value → null (park,
//     never fabricate).
//   • classifyDivergence() names WHY replay must stop, so the executor can
//     downgrade to review + record a correction instead of blind-submitting.
//   • paceDelay() jitters the learned human cadence into the replay's real sleeps.

// --- normalized token-overlap matcher (mirrors the qa fuzzy matcher in db.js) ---
// Labels are already normalized (db.normalizeQuestion → sorted, deduped,
// filler-stripped tokens). tokenOverlap measures how much of `a` is covered by
// `b`, with a symmetric fallback — the same shape qaLookup uses (≥0.6 = a match).
export function tokenOverlap(a, b) {
  const ta = new Set(String(a || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const tb = new Set(String(b || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  const coverage = hit / ta.size;
  const symmetric = hit / Math.max(ta.size, tb.size);
  // A short label fully contained in a wordier one is a match (coverage), but
  // require ≥2 shared tokens so a single common word isn't a coincidence; else
  // fall back to symmetric overlap. Identical to qaLookup's scoring intent.
  return (hit >= 2 && coverage >= 0.75) ? coverage : symmetric;
}

// A label asks for a quantity / number of years → its answer must be a NUMBER, never
// a URL/handle that merely mentions the same technology ("years of experience with
// GitHub" must not become the GitHub profile URL). Mirrors autofill.profileFieldFor's
// `wantsQuantity` guard.
const QUANTITY_RX = /\b(how many|how long|years?|yrs?|number of|combien|nombre d|niveau|level)\b/i;
// Anything that looks like a URL / web address — disqualified for a quantity label.
const URL_RX = /^https?:|\bwww\.|\.com\b|\.io\b|\.org\b|\.net\b/i;

function looksLikeQuantity(label) {
  return QUANTITY_RX.test(String(label || ''));
}
function looksLikeUrl(value) {
  return URL_RX.test(String(value == null ? '' : value));
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// ============================================================
// planReplay(recipe, requiredLabels, opts)
// ============================================================
// Decide whether the resolved recipe is safe to AUTO-replay against the live page.
//
// AUTO is granted ONLY when ALL of:
//   • the recipe exists and has ≥1 step,
//   • recipe.confidence >= opts.theta        (default 0.6),
//   • recipe.coverage   >= opts.minCoverage  (default 0.5), and
//   • EVERY required label on the live page has a matching step (token-overlap
//     ≥ opts.matchThreshold, default 0.6, against some step.labelPattern).
//
// Otherwise → { mode: 'fallback', missing, reason } so the executor runs the
// existing discover-every-step flow. This is the safety gate: no gaps → no
// fabrication; low confidence/coverage → never trust the recipe.
export function planReplay(recipe, requiredLabels, opts = {}) {
  const theta = opts.theta ?? 0.6;
  const minCoverage = opts.minCoverage ?? 0.5;
  const matchThreshold = opts.matchThreshold ?? 0.6;
  const required = Array.isArray(requiredLabels) ? requiredLabels.filter((l) => l != null && String(l).trim()) : [];

  if (!recipe || !(recipe.steps && recipe.steps.length)) {
    return { mode: 'fallback', missing: required.slice(), reason: 'no recipe steps' };
  }
  const confidence = Number(recipe.confidence) || 0;
  if (confidence < theta) {
    return { mode: 'fallback', missing: required.slice(), reason: `confidence ${confidence.toFixed(2)} < theta ${theta}` };
  }
  const coverage = Number(recipe.coverage) || 0;
  if (coverage < minCoverage) {
    return { mode: 'fallback', missing: required.slice(), reason: `coverage ${coverage.toFixed(2)} < min ${minCoverage}` };
  }

  // Every required field must be covered by a step (token-overlap). Any gap is a
  // potential fabrication site → fall back rather than blind-fill/blind-submit.
  const patterns = recipe.steps.map((s) => s && s.labelPattern).filter(Boolean);
  const missing = [];
  for (const label of required) {
    const covered = patterns.some((p) => tokenOverlap(label, p) >= matchThreshold);
    if (!covered) missing.push(label);
  }
  if (missing.length) {
    return { mode: 'fallback', missing, reason: `${missing.length} required field(s) not covered by the recipe` };
  }
  return { mode: 'auto', missing: [], reason: 'recipe covers all required fields' };
}

// ============================================================
// resolveStepAnswer(step, ctx)
// ============================================================
// The value to fill for a recipe step, walking the executor's answer ladder:
//   profile → qa → recipe default → AI → deterministic → null
// ctx provides each rung as a function (sync or pre-resolved value), so this is
// testable with stubs; the browser executor wires them to the real sources.
//
// HARD GUARD: for a quantity/"how many years" label, any candidate that looks like
// a URL is SKIPPED (the ladder continues to the next rung) — we never emit a URL
// for a number question. On no grounded value → null (the executor parks; never
// fabricates).
export function resolveStepAnswer(step, ctx = {}) {
  const label = (step && (step.labelPattern || step.label)) || '';
  const quantity = looksLikeQuantity(label);

  const consider = (raw) => {
    if (raw == null) return undefined;
    const v = typeof raw === 'string' ? raw : (raw.answer != null ? raw.answer : raw.value);
    if (v == null || String(v).trim() === '') return undefined;
    // Quantity question + URL candidate → reject this rung, keep walking the ladder.
    if (quantity && looksLikeUrl(v)) return undefined;
    return String(v);
  };

  const callRung = (fn) => {
    if (typeof fn !== 'function') return undefined;
    let out;
    try { out = fn(label, step); } catch { return undefined; }
    return consider(out);
  };

  // 1. profile
  let v = callRung(ctx.profileGet);
  if (v !== undefined) return v;
  // 2. learned qa store
  v = callRung(ctx.qaGet);
  if (v !== undefined) return v;
  // 3. recipe's own recorded default (no enumerated options here — a stored default value)
  v = consider(step && (step.defaultValue != null ? step.defaultValue : step.value));
  if (v !== undefined) return v;
  // 4. AI (confidence-gated upstream; here we just take what it returns)
  v = callRung(ctx.aiGet);
  if (v !== undefined) return v;
  // 5. deterministic no-model floor
  v = callRung(ctx.deterministicGet);
  if (v !== undefined) return v;
  // No grounded answer → null (park, never fabricate).
  return null;
}

// ============================================================
// paceDelay(medianMs, rand, opts)
// ============================================================
// A jittered human-pacing delay (ms). Base = the learned median for this step (or a
// default ~700ms when none is known). Jitter the base over [0.6, 1.6) using rand()
// ∈ [0,1), then clamp to [150, 6000]ms so a corrupt/extreme median can't stall the
// replay or fire instantly (an obvious bot tell). `rand` is injectable for
// deterministic tests; defaults to Math.random.
export function paceDelay(medianMs, rand = Math.random, opts = {}) {
  const defaultBase = opts.defaultBaseMs ?? 700;
  const minMs = opts.minMs ?? 150;
  const maxMs = opts.maxMs ?? 6000;
  const base = (Number(medianMs) > 0) ? Number(medianMs) : defaultBase;
  let r = 0;
  try { r = Number(rand()); } catch { r = 0; }
  if (!Number.isFinite(r)) r = 0;
  r = clamp(r, 0, 0.999999);          // rand() is [0,1); guard a stray 1.0/NaN
  const factor = 0.6 + r * (1.6 - 0.6);  // [0.6, 1.6)
  return Math.round(clamp(base * factor, minMs, maxMs));
}

// ============================================================
// resolveLocator(step)  [T3 — selector-first replay]
// ============================================================
// PURE precedence for HOW to find a step's target element on the live page:
//   1. step.selector  → { by: 'selector', value }  (a CSS selector — most precise)
//   2. step.xpath     → { by: 'xpath',    value }  (robust structural locator)
//   3. otherwise      → { by: 'label',    value }  (today's label_pattern token-match)
// The executor uses (1)/(2) first and FALLS BACK to (3) when the locator is absent,
// not found, or invisible. A blank string is treated as absent.
export function resolveLocator(step = {}) {
  const sel = step && step.selector != null ? String(step.selector).trim() : '';
  if (sel) return { by: 'selector', value: sel };
  const xp = step && step.xpath != null ? String(step.xpath).trim() : '';
  if (xp) return { by: 'xpath', value: xp };
  const lbl = (step && (step.labelPattern || step.label)) || '';
  return { by: 'label', value: lbl };
}

// ============================================================
// pickRunMode(recipe, opts)  [T4 — Live Teach & Correct]
// ============================================================
// PURE default-mode picker for a SUPERVISED "Watch & Teach" run:
//   • 'step' — pause before EACH action for the user's OK. Chosen when the recipe is
//     NEW / untrusted: no steps, or confidence < (opts.trust ?? 0.7). The first time
//     Pierre teaches a new ATS he watches every action.
//   • 'run'  — go at pace, honoring a "Wrong" interrupt. Chosen once the recipe is
//     TRUSTED: it has ≥1 step AND confidence ≥ trust.
// The overlay still offers a manual Step/Run toggle; this only sets the default.
export function pickRunMode(recipe, opts = {}) {
  const trust = opts.trust ?? 0.7;
  const steps = recipe && Array.isArray(recipe.steps) ? recipe.steps : [];
  const confidence = Number(recipe && recipe.confidence) || 0;
  if (!steps.length || confidence < trust) return 'step';
  return 'run';
}

// ============================================================
// classifyDivergence({ unexpectedRequiredField, validationError, noChangeCount })
// ============================================================
// Name WHY a replay must stop, so the executor downgrades to review + records a
// correction instead of pressing on. Priority: an unexpected required field (the
// recipe has a gap → fabrication risk) > an inline validation error > a stall
// (≥3 no-change advances). Returns null when nothing has diverged.
export function classifyDivergence({ unexpectedRequiredField, validationError, noChangeCount } = {}) {
  if (unexpectedRequiredField) return 'unexpected_field';
  if (validationError) return 'validation_error';
  if (Number(noChangeCount) >= 3) return 'stalled';
  return null;
}

// Stable recovery identity. Deliberately excludes query strings, DOM size, tracking ids,
// and other render noise: two attempts at the same job/action/stage must compare equal so
// the healer can stop repeating a functionally identical failure.
export function recoveryFingerprint({ hostname, pathname, label, stage } = {}) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  const path = String(pathname || '/').toLowerCase()
    .replace(/\/apply\/?$/, '/apply')
    .replace(/\/+$/, '') || '/';
  const action = String(label || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const phase = String(stage || '').toLowerCase().replace(/\s+/g, '-').trim();
  return [host, path, action, phase].join('|');
}

// Page identity for the duplicate-page-action breaker. We compare host+pathname (query
// strings are render noise) so the breaker keys to "the same page", not the same full
// URL. Used by shouldResetPageActionBreaker below.
export function pageActionUrlKey(url) {
  try {
    const u = new URL(String(url || ''));
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = (u.pathname || '/').toLowerCase().replace(/\/+$/, '') || '/';
    return `${host}${path}`;
  } catch {
    // Non-absolute / opaque input: fall back to a normalized raw string so two identical
    // inputs still compare equal (within-page protection preserved) and any difference
    // still trips the reset.
    return String(url || '').toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

// Should the duplicate-page-action breaker be reset because the page NAVIGATED?
// The breaker (executor.js lastPageAction) keys on host+path+label+stage. When an
// external "Apply (opens in new tab)" actually navigates IN-TAB to the company ATS, the
// company landing page often has its OWN "Apply"-labelled button; without resetting the
// breaker across the navigation, that first (legitimate, different-page) click is mistaken
// for a repeat and the run is killed. Reset iff a lastPageAction is armed AND the current
// page identity differs from where it was armed. Same page (same host+path) → NO reset, so
// the genuine "opener doesn't transfer" loop is still caught WITHIN a single page.
export function shouldResetPageActionBreaker({ lastActionUrl, currentUrl, hasPending } = {}) {
  if (!hasPending) return false;            // nothing armed → nothing to reset
  if (lastActionUrl == null) return false;  // armed without a recorded URL → don't reset blind
  return pageActionUrlKey(lastActionUrl) !== pageActionUrlKey(currentUrl);
}

// EXT-2: did an armed external handoff actually TRANSFER the source tab? The service worker
// polls the source tab's URL after the external "Apply" click. The obvious transfer is a HOST
// change (linkedin.com → company.com), but some company ATSes redirect via a PATH-only change
// on the same host (a slow /jobs → /jobs/apply, an SSO bounce that keeps the host), and a few
// openers route through a same-host interstitial before bouncing off-site. We treat any host-OR-
// path change as a transfer (waitTabComplete settles further redirects before we drive it), but
// a QUERY/HASH-only change is render noise, NOT a navigation — so we must not capture it as the
// target. pageActionUrlKey already collapses query/hash and keeps host+path, so a key change is
// exactly the host-or-path transfer we want. Malformed URLs never throw (pageActionUrlKey guards).
export function externalTargetFromNav({ initialUrl, currentUrl } = {}) {
  if (!initialUrl || !currentUrl) return false;
  if (currentUrl === initialUrl) return false;
  return pageActionUrlKey(initialUrl) !== pageActionUrlKey(currentUrl);
}
