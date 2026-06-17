// JAT v11 — Apprenticeship Engine: Distiller  [P3]
//
// Programming-by-demonstration, deterministic-first. The distiller turns a COMPLETED
// manual application into transferable recipe steps so the Replayer (P5) can reproduce it
// at volume on any company running the same ATS.
//
// DATA SOURCE (important honesty note): a step-level interaction recorder (per-field
// clicks + real inter-step timing) does NOT exist yet. This distiller works from the
// structured capture that DOES exist today — the job's harvested `answers` object
// ({label: value}, captured by the Observer on a manual apply) plus classifyAts()
// attribution. It SYNTHESIZES one recipe_step per answered field. Fields we cannot observe
// yet (median_delay_ms, advance_text) use sensible DEFAULTS (null) and will be enriched
// when a content-script interaction recorder lands. Each synthesized step carries a modest
// confidence (0.6) for the same reason.
//
// Scope decision (the transfer unit): a field is 'ats' scope if it's a generic,
// cross-company question (location / authorized-to-work / years-of-experience / education /
// relocation / salary / notice-period / start-date / preferred-name / email / phone) — it
// lives on the ATS recipe so ONE Workday apply teaches every Workday company. Anything else
// (company-specific screening, enumerated company options) is 'company' scope, stored on
// the company overlay. Credentials/EEO never become a step (db.isSensitiveKey rail).

const db = require('./db');

// Generic, cross-company questions → 'ats' scope. Deliberately broad-but-targeted so a
// genuinely company-specific screening question ("why do you want to work at X") does NOT
// match and correctly falls to the company overlay.
const GENERIC_RX = new RegExp([
  'authoriz', 'work.?permit', 'eligib(le|ility).?to.?work', 'legally.?(allowed|able)',
  'years?.*experien', 'experien.*years?', '\\byoe\\b', 'years?.*\\b(of|with)\\b',
  'educat', 'degree', 'diploma', 'highest.?(level|degree)',
  'reloc', 'willing.?to.?move', 'commut',
  'salary', 'compensation', 'expected.?pay', 'desired.?(salary|pay)',
  'notice.?period', 'availab', 'start.?date', 'when.?can.?you.?start',
  'preferred.?name', '\\bemail\\b', 'courriel', '\\bphone\\b', 'mobile', 'telephone',
  'location', '\\bcity\\b', 'province', 'state\\b', 'country', 'postal', '\\bzip\\b',
  '\\bremote\\b', 'on.?site', 'hybrid',
  'sponsor', '\\bvisa\\b', 'citizen',
].join('|'), 'i');

function isGenericQuestion(label) {
  return GENERIC_RX.test(String(label || ''));
}

// Field-type inference from the captured VALUE (the only signal we have without an
// interaction recorder): numeric → number, email-shaped → email, else text.
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function inferFieldType(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return 'text';
  if (EMAIL_RX.test(v)) return 'email';
  if (/^[+]?[\d][\d\s().-]{4,}$/.test(v) && /\d{5,}/.test(v.replace(/\D/g, ''))) return 'text'; // phone → text (don't mis-type as number)
  if (/^-?\d+(\.\d+)?$/.test(v)) return 'number';
  return 'text';
}

// Action heuristic: a short, enumerated-looking value (a single token / Yes-No / one of a
// few words) reads as a SELECT (pick an option); free text reads as a FILL. Without the
// real widget type this is a best-effort guess the Replayer's divergence guard can correct.
const ENUM_VALUE_RX = /^(yes|no|oui|non|true|false|n\/?a|prefer not to say|male|female|other)$/i;
function looksEnumerated(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return false;
  if (ENUM_VALUE_RX.test(v)) return true;
  // A short single-or-two-word value with no sentence punctuation is option-like.
  const words = v.split(/\s+/);
  return v.length <= 40 && words.length <= 3 && !/[.!?,;]/.test(v);
}

// Strategy default per (action, field type), mirroring the executor's autofill vocabulary
// (setNativeValue for React-proof text/number injection; matchOption for selects).
function strategyFor(action, fieldType) {
  if (action === 'select') return 'matchOption';
  return 'setNativeValue';
}

// distillJob(jobOrId, profileId) — fold one completed application's answers into the
// (ats, company) recipes. Returns { recipes, steps } counts. No-op-safe: missing job,
// no answers, or an unknown ATS each return zero without throwing.
function distillJob(jobOrId, profileId) {
  const job = (jobOrId && typeof jobOrId === 'object') ? jobOrId : db.getJob(jobOrId);
  if (!job) return { recipes: 0, steps: 0 };
  const answers = job.answers;
  if (!answers || typeof answers !== 'object' || !Object.keys(answers).length) {
    return { recipes: 0, steps: 0 };
  }

  const cls = db.classifyAts(job.jobUrl);
  const ats = cls && cls.ats ? String(cls.ats).toLowerCase().trim() : '';
  if (!ats) return { recipes: 0, steps: 0 };
  // companyKey: from the URL where the ATS encodes it, else the job's company.
  const companyKey = cls.companyKey || db.normKey(job.company || '').replace(/\s+/g, '') || null;
  const siteDomain = cls.host || null;

  const pid = profileId || db.resolveProfileId(job.source);

  // Partition answers into ats-scope (generic) vs company-scope (specific), dropping
  // sensitive/credential keys at the write boundary (layered with db's own rail).
  const atsFields = [];
  const companyFields = [];
  for (const [label, raw] of Object.entries(answers)) {
    if (!label) continue;
    if (db.isSensitiveKey(label)) continue;   // credentials/EEO never become a step
    const value = Array.isArray(raw) ? raw.join(', ') : raw;
    if (value == null || String(value).trim() === '') continue;
    (isGenericQuestion(label) ? atsFields : companyFields).push({ label, value });
  }
  if (!atsFields.length && !companyFields.length) return { recipes: 0, steps: 0 };

  let recipes = 0, steps = 0;
  const recipeIds = [];

  const writeStep = (recipeId, label, value) => {
    const fieldType = inferFieldType(value);
    const action = looksEnumerated(value) ? 'select' : 'fill';
    const row = db.upsertRecipeStep({
      recipeId,
      action,
      labelPattern: db.normalizeQuestion(label),
      fieldType,
      strategy: strategyFor(action, fieldType),
      options: null,          // enumerated choices unknown without an interaction recorder
      advanceText: null,      // Next/Submit button text unknown yet
      medianDelayMs: null,    // learned human pacing unknown yet
      confidence: 0.6,        // synthesized from answers only — modest until enriched
    });
    if (row) steps++;
  };

  // ATS recipe (always, given any generic field) — the cross-company carrier.
  if (atsFields.length) {
    const atsRecipe = db.upsertRecipe({ profileId: pid, scope: 'ats', ats, companyKey: null, siteDomain });
    if (atsRecipe) {
      recipes++;
      recipeIds.push(atsRecipe.id);
      for (const f of atsFields) writeStep(atsRecipe.id, f.label, f.value);
    }
  }

  // Company overlay (only when we know the company AND there are company-specific fields).
  if (companyKey && companyFields.length) {
    const companyRecipe = db.upsertRecipe({ profileId: pid, scope: 'company', ats, companyKey, siteDomain });
    if (companyRecipe) {
      recipes++;
      recipeIds.push(companyRecipe.id);
      for (const f of companyFields) writeStep(companyRecipe.id, f.label, f.value);
    }
  }

  // A distilled application is, by definition, one that completed → mark mechanical success.
  for (const rid of recipeIds) {
    try { db.markRecipeOutcome(rid, { success: true }); } catch {}
  }

  return { recipes, steps };
}

// median of a numeric array (null when empty). For an even count, the lower-mid is used
// (a delay floor that errs slightly fast is fine; we only need a stable representative).
function medianOf(nums) {
  const xs = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor((xs.length - 1) / 2);
  return xs[mid];
}

// distillDemonstrations(profileId, { sessionId, jobId }) — T3 enrichment. Fold the RAW
// high-fidelity demonstrations captured by the recorder (real elements + timing) into the
// (ats, company) recipes, carrying the FULL locator bundle (selector/xpath/attrs/html/
// screenshot/median_delay_ms) + a learned default_value when invariant. Stronger signal
// than distillJob's answer-only synthesis, so confidence is higher (~0.7).
//
// Grouping: by (ats, company_key, label_norm). Per group we pick the FRESHEST non-null
// locator field (selector/xpath/attrs/html/screenshot/field_type), the median delay across
// the demos, and a default_value ONLY if every demo's value agrees (invariant) — else null,
// so a per-application value (a cover letter, a name) never becomes a constant. Credentials
// already arrive value-less from the rail, so they never carry a default_value.
//
// Scope (ats vs company): same GENERIC_RX rule as distillJob. No-op-safe: no demos, no ATS,
// or all-sensitive → zero without throwing.
function distillDemonstrations(profileId, { sessionId, jobId } = {}) {
  const pid = profileId || db.ensureDefaultProfileId();
  // Pull the session/job's demonstrations, ordered for stable freshness reasoning.
  let rows = [];
  try {
    rows = (db.demonstrationsForSession
      ? db.demonstrationsForSession(pid, { sessionId, jobId })
      : null);
  } catch { rows = null; }
  if (!rows) {
    // Fallback: scan the profile's demonstrations and filter by session/job in JS (keeps
    // this resilient if a session-scoped query isn't present).
    try {
      const all = db.demonstrationsFor(pid, {}) || [];
      rows = all.filter((r) =>
        (sessionId == null || r.session_id === sessionId) &&
        (jobId == null || r.job_id === jobId));
    } catch { rows = []; }
  }
  if (!rows || !rows.length) return { recipes: 0, steps: 0 };

  // Group by (ats, company_key, label_norm). Skip rows with no usable label or no ATS.
  const groups = new Map();
  for (const r of rows) {
    const ats = r.ats ? String(r.ats).toLowerCase().trim() : '';
    if (!ats) continue;
    const label = r.label || '';
    if (!label || db.isSensitiveKey(label)) {
      // Credentials never become a recipe step (defense-in-depth with the recorder rail).
      if (db.isSensitiveKey(label)) continue;
    }
    const labelNorm = r.label_norm || db.normalizeQuestion(label);
    if (!labelNorm) continue;
    const key = `${ats} ${r.company_key || ''} ${labelNorm}`;
    if (!groups.has(key)) groups.set(key, { ats, companyKey: r.company_key || null, label, labelNorm, rows: [] });
    groups.get(key).rows.push(r);
  }
  if (!groups.size) return { recipes: 0, steps: 0 };

  // Per (ats, company_key), batch the field steps so we open each recipe once.
  let recipes = 0, steps = 0;
  const recipeKey = (g) => `${g.ats} ${g.companyKey || ''}`;
  const recipeCache = new Map();   // recipeKey → { id, scope } (lazily upserted)
  const seenRecipeIds = new Set();
  const siteDomainFor = (g) => (g.rows.find((r) => r.html || r.selector) ? null : null); // host not on demos; recipe keeps prior

  for (const g of groups.values()) {
    // Freshest-first within the group (the recorder writes ts ascending; resolve newest).
    const demos = g.rows.slice().sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    const freshest = (pick) => { for (const d of demos) { const v = pick(d); if (v != null && String(v) !== '') return v; } return null; };

    const selector = freshest((d) => d.selector);
    const xpath = freshest((d) => d.xpath);
    const attrs = freshest((d) => d.attrs);
    const html = freshest((d) => d.html);
    const screenshotId = freshest((d) => d.screenshot_id);
    const fieldType = freshest((d) => d.field_type) || inferFieldType(freshest((d) => d.value));
    const medianDelayMs = medianOf(demos.map((d) => Number(d.delay_ms)));

    // default_value: invariant value across ALL demos that carried one (and at least one
    // did). Rail-nulled credential demos have value==null, so they never set a default.
    const vals = demos.map((d) => (d.value == null ? null : String(d.value)))
      .filter((v) => v != null && v.trim() !== '');
    const invariant = vals.length && vals.every((v) => v === vals[0]);
    const defaultValue = invariant ? vals[0] : null;

    const action = freshest((d) => d.action) || (looksEnumerated(defaultValue) ? 'select' : 'fill');
    const scope = isGenericQuestion(g.label) ? 'ats' : 'company';
    // A company-scoped field with no known company falls back to ATS scope (can't key it).
    const effScope = (scope === 'company' && !g.companyKey) ? 'ats' : scope;

    const rkey = `${g.ats} ${effScope} ${effScope === 'company' ? (g.companyKey || '') : ''}`;
    let rec = recipeCache.get(rkey);
    if (!rec) {
      const upserted = db.upsertRecipe({
        profileId: pid, scope: effScope, ats: g.ats,
        companyKey: effScope === 'company' ? g.companyKey : null, siteDomain: siteDomainFor(g),
      });
      if (!upserted) continue;
      rec = { id: upserted.id };
      recipeCache.set(rkey, rec);
      if (!seenRecipeIds.has(upserted.id)) { recipes++; seenRecipeIds.add(upserted.id); }
    }

    const source = freshest((d) => d.source) || 'teach';
    const row = db.upsertRecipeStep({
      recipeId: rec.id,
      action,
      labelPattern: g.labelNorm,
      fieldType,
      strategy: strategyFor(action, fieldType),
      medianDelayMs,
      confidence: 0.7,            // a real demonstrated step > an answer-only guess (0.6)
      selector, xpath, attrs, html, screenshotId,
      source: source === 'manual' ? 'manual' : (source === 'correction' ? 'correction' : 'teach'),
      defaultValue,
    });
    if (row) steps++;
  }

  // A completed teach/apply demonstration session is, by definition, a success.
  for (const id of seenRecipeIds) { try { db.markRecipeOutcome(id, { success: true }); } catch {} }

  return { recipes, steps };
}

module.exports = { distillJob, distillDemonstrations };
