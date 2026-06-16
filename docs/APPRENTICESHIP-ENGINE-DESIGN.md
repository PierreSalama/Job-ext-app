# The Apprenticeship Engine — Definitive Architecture & Phased Build Plan (JAT v11.18+)

The Apprenticeship Engine turns JAT v11 from an assistive auto-apply tool into a **self-improving apprentice**: it watches every manual job application the user does on any site, distills those sessions into transferable "recipes" keyed by both the ATS (Workday/Greenhouse/Lever/iCIMS/…) and the company, replays them at high volume with the user's own learned human pacing as a stealth floor, and closes a learning loop on the single signal that actually matters — **interview replies in Gmail**. Positive replies boost the answers, recipes, and companies that produced them; rejections apply only a mild fit penalty; a human-in-the-loop (star ratings, "punish company/job/job-type", and one-click "confirm this email↔application link") both heals the data and trains the matcher. AI is local-first via bundled Gemma with a fully deterministic fallback so it works on a brand-new offline Windows box and on Dad's GPU-less Firefox laptop, and the whole thing is per-profile-scoped so it could become a real product without a rewrite.

> **Synthesis note (honesty rail).** This document is the merge of three candidate architectures, corrected against the *actual* v11 code at `F:\GITHUB\Perosnal\extensions\job-application-tracker\v11`. Where a candidate claimed a feature "builds on an existing seam" that does **not** exist in code, this document re-labels it **greenfield** and sequences it accordingly. The three load-bearing corrections, all verified during synthesis:
> 1. **The lenient matcher already exists — but in `app/src/email.js`, not `gmail.js`.** `matchEmailToJob()` (email.js:144) already does company-hint + fuzzy-title + time-window scoring and already emits the `auto | suggested` lifecycle. **`gmail.js` does NOT populate the `emails` table** (it writes status via `recordEvent`/`patchJob`). The reward loop therefore needs net-new wiring to route Gmail through the same `emailUpsert`/`matchEmailToJob` path the IMAP `email.js` uses — it is not free.
> 2. **The local AI runtime is 100% Ollama.** `localsetup.js` downloads `OllamaSetup.exe` and pulls via `/api/pull` on `:11434`; `hardware.js` `TIERS` recommend **Qwen/Llama**, not Gemma; there is **no `extraResources`** block in `app/package.json`. Bundling embedded llama.cpp + Gemma GGUF is a **new parallel subsystem**, not a graft — so this document offers a lower-risk default (**bundle models *for Ollama*, keep the runtime**) and an optional embedded-llama.cpp track.
> 3. **The Recipe Replayer is fully greenfield.** `grep recipe|replay executor.js` returns zero hits. Recipe resolution, divergence guard, and pacing replay are all new code; they are gated behind the existing executor seams (answer ladder, stall detection, transcript reporting) but are not "an extension point that exists."

---

## Goals & non-goals

### Goals (charter priority order — do not reorder)

1. **Maximize interview responses (north star).** Gmail reply-matching is the reward signal. Link inbound mail to the application it answers *leniently* (company + sender-domain + fuzzy title + time window); when unsure, ask the user to confirm — confirmation both heals the link **and** trains the matcher. Every other subsystem is ultimately ranked by "does this produce interview replies."
2. **Maximize volume.** Push throughput hard (user explicitly chose max volume), bounded only by the existing per-window throttle, daily/hourly caps, and account-safety rails.
3. **Truthful, strict, high-quality matching.** Never fabricate answers (already enforced via `refuse=true`). Down-rank "mid"/irrelevant jobs. Let the user **punish** a single job, a job-type pattern, or an **entire company** so it is never queued or discovered again (with optional decay).
4. **Minimize manual effort — with a light human-in-the-loop.** Star ratings, structured review, occasional manual applies, and link-confirmation are the *only* asks, and each one feeds the system. The confirm-prompt volume is itself a metric to minimize (Goal 4 ⊥ Goal 1's leniency — see Risks).

### Non-goals (explicit, to keep the one-shot build bounded)

- **No cloud sync / multi-device** in this build. Data model is product-ready (per-profile FK isolation, export/import) but the network-sync server is out of scope.
- **No CAPTCHA / login solving, ever.** Those route to `awaiting_input` (already the behavior). Anti-detection is about *rhythm*, not *bypassing challenges*.
- **No storing of passwords, payment, SSN, or credential fields** — non-negotiable hard rail (Goal-independent; it is a precondition of "always-on" being acceptable at all).
- **No reverse-engineering of any ATS bot-detection**; we make replay *look human* by replaying real human traces, not by defeating a specific detector.
- **Mac/Linux installers stay optional.** `release.yml` already treats them as optional; Windows is the must-pass platform and the only one that ships weights.
- **No fabricated EEO/demographic answers** and no EEO capture (already enforced at extraction; reinforced).

---

## System overview — the Observer → Distiller → Replayer → Reward closed loop

The engine is a closed control loop. The **Observer** records human applications (answers + navigation) on *any* site. The **Distiller** turns raw recorded sessions into generalized, transferable **recipes** (keyed by ATS and company) plus structured answer memory. The **Replayer** executes those recipes at volume with human pacing. The **Reward Engine** observes outcomes (Gmail replies, user ratings, punishments), assigns credit back to the exact answers/recipe-steps/(ats,company) that produced them, and re-ranks what gets discovered and applied to next — feeding the next cycle.

```
                         THE APPRENTICESHIP ENGINE — closed loop
                         (Windows Electron app  +  Chrome MV3 / Firefox extension)

  ┌──────────────────────────────────── EXTENSION (content + SW) ─────────────────────────────────────┐
  │                                                                                                    │
  │   OBSERVER  (always-on, 100%, any site)                 REPLAYER  (executor.js extension)           │
  │   ┌───────────────────────────────────┐                ┌───────────────────────────────────────┐   │
  │   │ observer.js  (NEW content module)  │                │ replayRecipe()  (NEW path in executor) │   │
  │   │ • nav recorder → webNavigation     │                │ • resolveRecipe(ats,company,profile)   │   │
  │   │ • interaction recorder (clicks,    │                │ • answer ladder: profile→qa→recipe→AI  │   │
  │   │   step-advance, field types,       │                │ • human pacing from median_delay_ms    │   │
  │   │   uploads, board→ATS handoff)      │                │ • DIVERGENCE GUARD → park + correction  │   │
  │   │ • snapshotAnswers() (reused)       │                │ • never fabricate / never blind-submit │   │
  │   │ • HARD RAIL: drop pw/pay/ssn/cred  │                └──────────────┬────────────────────────┘   │
  │   └───────────────┬───────────────────┘                               │ replay / fall back          │
  │                   │ POST /observe/nav, /observe/step                   │ to discover-every-step      │
  └───────────────────┼──────────────────────────────────────────────────┼─────────────────────────────┘
                      │  (token REST/SSE 127.0.0.1:7744)                   │
  ┌───────────────────▼──────────────────────── ELECTRON APP (SQLite) ────▼─────────────────────────────┐
  │                                                                                                      │
  │   DISTILLER                         RECIPE STORE + TRANSFER            REWARD ENGINE (north star)      │
  │   ┌────────────────────────┐        ┌───────────────────────┐         ┌──────────────────────────┐    │
  │   │ distiller.js (NEW)     │  feeds │ ats_recipes           │  ranks  │ Gmail → emails table     │    │
  │   │ • fold nav+answers into│ ─────▶ │ recipe_steps          │ ◀────── │ matchEmailToJob() LENIENT │    │
  │   │   abstract steps       │        │ resolveRecipe()        │         │   (company+domain+title+ │    │
  │   │ • generalize labels    │        │   ATS recipe ⊕ company │         │    time window)          │    │
  │   │ • Gemma-assist OR       │        │   overlay (precedence) │         │ confirm-link inbox       │    │
  │   │   deterministic distill │        │ recipe coverage score  │         │   suggested→manual+TRAIN │    │
  │   └────────────────────────┘        └───────────┬───────────┘         │ application_outcomes     │    │
  │                                                 │                      │   ledger + credit assign │    │
  │   LOCAL AI LAYER                                 │                      │ punishments (decay)      │    │
  │   ┌────────────────────────────────────┐        │                      └───────────┬──────────────┘    │
  │   │ provider chain [claude,chatgpt,local]│       │  rankJob(job,profile)            │ reward fans to    │
  │   │ local = Ollama(bundled Gemma) │       │  = fit ⊕ reward ⊖ punish ⊖ stale  │ qa / steps /(ats, │    │
  │   │   ↳ deterministic.js  (no model)    │ ◀──────┘                                 │ company)          │    │
  │   │   ↳ hardware.js tier → 1B/3B/4B     │                                          ▼                   │
  │   └────────────────────────────────────┘            DISCOVERY + queueNext ◀── ranked candidates        │
  │                                                                                                      │
  └──────────────────────────────────────────────────────────────────────────────────────────────────┘
                                          │ v11.* tag → GitHub Actions → electron-builder
                                          ▼ PierreSalama/Job-ext-app  (Windows NSIS + weights sidecar)
```

**Loop legend:** `⊕` = additive blend, `⊖` = penalty. The single most important edge is the dashed one from **emails → ats_recipes / qa**: an interview reply is the only thing that turns "we applied" into "this *worked*," and credit assignment is what makes the apprentice actually learn rather than just memorize.

---

## Components

Each component lists **responsibility**, **builds-on-existing vs new** (honestly labeled), and **key files/modules**.

### 1. Observer — always-on learn-from-everything
- **Responsibility.** On every page (independent of the auto-apply queue), silently record manual applications: the user's **answers** and their **navigation** — step-advances, field types (char limits, pick-options, custom dropdowns/typeaheads, uploads), board→external-ATS handoffs, and direct applies on company career sites. Emit nav + interaction events; never write password/payment/SSN/credential keys.
- **Builds-on (real).** `forms.js snapshotAnswers()` / `detectApplyForm()` (form recognition + EEO/sensitive exclusion already present); `autofill.js captureCurrentAnswers()`; `detector.js` lifecycle (`detected→started→progressing→submitted`); the `upsertJob → harvestAnswersToProfile` harvest path (db.js); `sites/index.js` ATS classification; `webNavigation.onCompleted/onHistoryStateUpdated` listeners **already wired in `background.js`** for SPA reboot (we tap them).
- **New.** `extension/content/observer.js` — a passive interaction recorder that runs in **OBSERVE mode** regardless of queue state; ATS classifier extended to iCIMS/SuccessFactors/Taleo/BambooHR/Ashby/direct; `POST /observe/nav` + `POST /observe/step` server routes; the hard-rail extension to `SENSITIVE_RX` covering password/payment/credential keys at the *write* boundary.
- **Key files.** `extension/content/observer.js` (NEW), `extension/background.js` (tap nav listeners), `app/src/server.js` (+ `/observe/*`), `app/src/db.js` (+ `nav_events`, recipe writes), `forms.js` (reused).

### 2. Distiller — session → generalized recipe
- **Responsibility.** Turn raw recorded sessions (answers + ordered nav/interaction events) into **abstract, transferable recipe steps**: `locate-field-by-label-pattern → field_type → strategy → advance`, plus learned median pacing. Generalize concrete labels into normalized patterns (reusing `normalizeQuestion`), cluster question rephrasings, and derive ATS-level vs company-level scope.
- **Builds-on (real).** `db.js normalizeQuestion()` (EN+FR canonicalization), `qa` fuzzy match (≥0.6 token overlap) for label clustering, `profile_fields` field_type/confidence/seen_count conventions.
- **New (greenfield).** `app/src/distiller.js` — deterministic-first step extraction; optional Gemma assist to name/cluster ambiguous labels and infer field semantics; writes `ats_recipes` + `recipe_steps`.
- **Key files.** `app/src/distiller.js` (NEW), `app/src/db.js` (recipe tables), `app/src/ai/provider.js` (optional assist).

### 3. Recipe Store + Transfer Engine
- **Responsibility.** Store recipes as ordered abstract steps keyed **independently by ATS and by company**, equally weighted. ATS recipes transfer furthest (apply at Rogers/Workday once → know every Workday company); company overlays carry specifics (custom screening questions). `resolveRecipe(ats, company, profileId)` blends ATS-level + company-level steps with confidence + outcome weighting; company overlay wins on conflict. Expose a **recipe-coverage score** to discovery so the engine prefers ATSes it already knows.
- **Builds-on (real).** The grounding's named "ATS recipe database" extension point (intended to replace hardcoded `sites/*.js`); per-profile FK scoping; the v6/v7/v8 migration precedent for FK-cascade tables.
- **New.** `ats_recipes` + `recipe_steps` tables; `resolveRecipe()`; coverage score surfaced to discovery + `rankJob`.
- **Key files.** `app/src/db.js` (tables + `resolveRecipe`), `app/src/server.js` (recipe read routes for the dashboard).

### 4. Recipe Replayer (executor extension) — **greenfield**
- **Responsibility.** In AUTO mode, when a confident recipe exists for the page's `(ats, company)`, replay the known-good sequence — bypass blind field re-discovery, fill from the resolved answer ladder, advance with recorded human pacing. **Divergence guard:** any unexpected field / validation error / stall → downgrade to review, park, and record a *correction event* that retrains the recipe. Never fabricate; never blind-submit on divergence.
- **Builds-on (real).** `executor.js` already does multi-step automation, answer ladder (profile→qa→AI), React-proof injection (`setNativeValue`), combobox fill, resume upload, stall detection (3 no-change advances → diagnose+park), and transcript reporting to `PATCH /queue/:id`. These are the *seams* the new path hooks; the replay engine itself is new.
- **New.** `replayRecipe()` path inside `executor.js`; divergence guard; pacing jitter from `recipe_steps.median_delay_ms`.
- **Key files.** `extension/content/executor.js` (replay path), `extension/content/autofill.js` (strategy reuse), `extension/content/replayer.js` (NEW helper, web-accessible).

### 5. Reward Engine (north-star loop)
- **Responsibility.** Convert outcomes into learning signal. (1) Gmail reply-match is the primary reward; a matched interview/recruiter/offer email boosts the answers, recipe, and company that produced the application; a rejection applies a **mild negative on FIT only**. (2) Star ratings + "punish job/job-type/company" apply explicit signal. (3) Credit assignment fans reward to the specific `qa` answers (via `answer_lineage`), `recipe_steps`, and `(ats, company)` used. (4) Borderline email↔app links surface for one-click confirmation, which trains the matcher.
- **Builds-on (real, with correction).** `app/src/email.js matchEmailToJob()` **already** does company-hint + time-window + fuzzy-title scoring and emits `auto | suggested` (verified email.js:144–171); `emails` table already has `matched_job_id`, `match_confidence`, `match_source` ('auto'|'suggested'|'manual'|'dismissed'), `category`; `STATUS_ORDER` is forward-only; `classify()` orders rejection-first buckets; `fit.js` gives a deterministic FIT baseline. **Correction:** `gmail.js` does NOT currently write to the `emails` table — the reward loop must route Gmail through the same `emailUpsert`/`matchEmailToJob` primitives that IMAP `email.js` uses.
- **New.** `application_outcomes` ledger; credit-assignment pass; confirm-link inbox UI (turns `suggested→manual` + stores a labeled training example that tunes match thresholds); `sender_domain` added as an explicit distinct signal to `matchEmailToJob`; `punishments` table + `rankJob`.
- **Key files.** `app/src/gmail.js` (route to emails table), `app/src/email.js` (`matchEmailToJob` + sender-domain), `app/src/db.js` (`application_outcomes`, `punishments`, credit pass), `app/src/server.js` (confirm-link route), dashboard inbox view (mirror gate).

### 6. Strict Relevance + Punishment Gate
- **Responsibility.** Enforce Goal 3. Never fabricate (already true). Down-rank mid/irrelevant jobs. Let the user punish a job, job-type, or entire company (never queued/discovered again; optional decay). Blend deterministic fit, AI fit, reward history, and punishments into a single `rankJob` used by discovery + `queueNext`.
- **Builds-on (real).** `server.js jobFit()/jobLevel()/SENIORITY_CAP/ACADEMIC_RE` + `excludeKeywords` already gate the queue; `fit.js` + `/ai/fit-score`; refuse-not-fabricate prompts.
- **New.** `punishments` table; unified `rankJob(job, profileId)`; "punish company" button cascading to all that company's queued tasks.
- **Key files.** `app/src/db.js` (`rankJob`, `punishments`), `app/src/server.js` (`queueNext`, discovery filter), `app/src/fit.js` (reused).

### 7. Bundled Local AI Runtime (Gemma + deterministic fallback)
- **Responsibility.** Make AI work on a brand-new offline Windows box and a weak laptop; pick model size by hardware; deterministic fallback when AI is weak/absent.
- **Builds-on (real).** `ai/provider.js` ordered fallback + `ai_log` meter; `hardware.js` RAM/VRAM/GPU probe + tier recommend; `localsetup.js` streaming-download-with-progress + ENOENT-safe spawn; `ollama.js` `/api/chat` + JSON-schema `format` contract. **Correction:** the runtime is Ollama, tiers recommend Qwen/Llama, and there is no `extraResources` — so "bundle Gemma" is a model-and-packaging change, and "embedded llama.cpp" is a *separate, optional* runtime swap.
- **New.** Bundled Gemma GGUF weights as a **sidecar release asset** (not inline in the NSIS installer); `hardware.js` TIERS remapped to gemma 1b/3b/4b thresholds; `ai/deterministic.js` (no-model answer floor); first-run model provisioning reusing `localsetup.js`. *Optional track:* `ai/gemma.js` embedded-llama.cpp provider (same `generate()` contract).
- **Key files.** `app/src/hardware.js`, `app/src/localsetup.js`, `app/src/ai/deterministic.js` (NEW), `app/src/ai/gemma.js` (NEW, optional), `app/package.json` (packaging), `.github/workflows/release.yml`.

### 8. Cross-Browser Parity Shim
- **Responsibility.** Keep Chrome MV3 and Firefox (Dad) at parity for Observer + Replayer: no `tabGroups`, `storage.session → storage.local`, gecko id present.
- **Builds-on (real).** `background.js` already guards every `chrome.tabGroups?.*` call and keeps the apply-tab registry/concurrency/window-id in `storage.local`; `manifest.json` carries `browser_specific_settings.gecko` (id + `strict_min_version 121`); `validate-extension.mjs` in CI keeps both honest.
- **New.** Apply the same guards to Observer/Replayer state; a tiny browser-caps probe so the Replayer never assumes `tabGroups`.
- **Key files.** `extension/background.js`, `extension/manifest.json` (web_accessible_resources for new modules), `tools/validate-extension.mjs`.

---

## Data model

All additions follow v11's proven migration pattern: **versioned via `PRAGMA user_version`, an ordered `MIGRATIONS[]` array, with `backupNow('pre-vN')` before each step.** New tables use FK-cascade per-profile scoping (precedent: v6); column adds are additive `ALTER`s (precedent: v7/v8). All SQL uses positional `?` params (wasm driver requirement).

### New tables

```sql
-- Recipes: keyed independently by ATS and by company (equal weight).
CREATE TABLE ats_recipes (
  id            INTEGER PRIMARY KEY,
  profile_id    INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL,            -- 'ats' | 'company'
  ats           TEXT NOT NULL,            -- workday|greenhouse|lever|icims|successfactors|taleo|bamboo|ashby|direct
  company_key   TEXT,                     -- normKey(company); NULL for scope='ats'
  site_domain   TEXT,
  confidence    REAL    DEFAULT 0.5,
  reward_score  REAL    DEFAULT 0,        -- updated by credit assignment
  success_count INTEGER DEFAULT 0,        -- mechanical completion
  fail_count    INTEGER DEFAULT 0,
  seen_count    INTEGER DEFAULT 1,
  created_at    TEXT,
  updated_at    TEXT,
  UNIQUE(profile_id, scope, ats, company_key)
);

-- Ordered abstract steps for a recipe (the replay program).
CREATE TABLE recipe_steps (
  id                 INTEGER PRIMARY KEY,
  recipe_id          INTEGER NOT NULL REFERENCES ats_recipes(id) ON DELETE CASCADE,
  step_index         INTEGER NOT NULL,
  action             TEXT NOT NULL,       -- fill|select|combobox|upload|advance|wait|handoff
  label_pattern      TEXT,                -- normalized (normalizeQuestion)
  field_type         TEXT,                -- text|textarea|select|radio|number|email|date|combobox|file
  strategy           TEXT,                -- e.g. fillCombobox, setNativeValue, radioBestMatch
  options            TEXT,                -- JSON: enumerated choices seen
  validation_pattern TEXT,
  advance_text       TEXT,                -- the Next/Submit button text observed (EN+FR)
  median_delay_ms    INTEGER,            -- learned human pacing (anti-detection floor)
  confidence         REAL,
  updated_at         TEXT
);

-- Human navigation path: powers handoff-edge learning + board pattern analysis.
CREATE TABLE nav_events (
  id           INTEGER PRIMARY KEY,
  profile_id   INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  session_id   TEXT,
  url_norm     TEXT,
  host         TEXT,
  ats          TEXT,
  company_key  TEXT,
  referrer_norm TEXT,
  kind         TEXT,                       -- visit|apply_click|step_advance|handoff|submit
  ts           TEXT
);
CREATE INDEX idx_nav_events_profile_ts ON nav_events(profile_id, ts);
-- ROLLING CAP enforced in code: keep newest N per (profile_id); prune on insert.

-- The reward ledger: every outcome that earns/loses credit.
CREATE TABLE application_outcomes (
  id          INTEGER PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  recipe_id   INTEGER REFERENCES ats_recipes(id) ON DELETE SET NULL,
  ats         TEXT,
  company_key TEXT,
  reward      REAL NOT NULL,              -- +interview/offer, mild-neg rejection, star delta, punish
  reward_kind TEXT NOT NULL,              -- email_reply|rejection|star|punish|submitted
  email_id    INTEGER REFERENCES emails(id) ON DELETE SET NULL,
  credited    TEXT,                       -- JSON: {qa_ids:[...], step_indices:[...]}
  ts          TEXT
);
CREATE INDEX idx_outcomes_job ON application_outcomes(job_id);

-- User-driven negative signal: punish a job, a job-type pattern, or a whole company.
CREATE TABLE punishments (
  id          INTEGER PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,              -- job | job_type | company
  pattern     TEXT NOT NULL,              -- company_key | title regex | job_id
  weight      REAL DEFAULT 1.0,
  decay_at    TEXT,                       -- NULL = permanent
  created_at  TEXT
);
CREATE INDEX idx_punish_profile ON punishments(profile_id, kind);
```

### Changed tables (additive `ALTER`)

```sql
-- qa: add per-answer lineage + reward so credit assignment can boost/deprioritize.
ALTER TABLE qa ADD COLUMN answer_lineage TEXT;     -- JSON [{source,matched_label,field_type,ts}]
ALTER TABLE qa ADD COLUMN reward_score   REAL DEFAULT 0;

-- profile_fields: add reward + light staleness flag.
ALTER TABLE profile_fields ADD COLUMN reward_score      REAL DEFAULT 0;
ALTER TABLE profile_fields ADD COLUMN last_validated_at TEXT;

-- auto_apply_tasks: analytics-only link to the recipe used (nullable; transcript already exists).
ALTER TABLE auto_apply_tasks ADD COLUMN recipe_id INTEGER;  -- nullable; no FK to avoid lock churn
```

### Reused as-is (no schema change)
- **`emails`** — already has `matched_job_id`, `match_confidence`, `match_source`, `category`. The reward engine reads these directly; `match_source='suggested'` rows drive the confirm-link UI and the matcher-training labels. **(Gmail must be wired to *write* here — see Phase P6.)**
- **`auto_apply_tasks`** — `apply_route`, `park_reason`, `pending_questions`, `transcript` already exist; the Replayer writes recipe id + divergence notes into `transcript`.
- **`profiles` / `sourceAssignments`** — per-profile isolation is the product-ready spine; every new table FK-cascades to `profiles`.

**Recipe key model (the transfer unit).** A target page resolves to `(ats, company_key)`. `resolveRecipe` fetches the `scope='ats'` recipe (transfers furthest) and the `scope='company'` overlay (specifics), then merges step-by-step: **company overlay wins on label-pattern conflict; ATS recipe fills the rest.** Both carry independent `confidence` + `reward_score`, so a hot ATS recipe and a cold company overlay compose correctly.

---

## The always-on cross-browser Observer

**What it captures (and only this).**
- **Answers** — via the existing `snapshotAnswers()` on real application forms (gated by `detectApplyForm()` scoring + `JUNK_KEY_RX`, so noisy non-application pages don't pollute). Each answer is stamped with `answer_lineage` source `'manual'`.
- **Navigation** — `nav_events`: page visits, apply-clicks, step-advances, board→ATS **handoff edges** (e.g., LinkedIn→Workday), submits. Sourced from `webNavigation.onCompleted/onHistoryStateUpdated` (already wired in `background.js`) — present in **both** Chrome and Firefox.
- **Interaction metadata** — field types (char limits, enumerated pick-options, custom dropdown/typeahead, file upload), the advance-button text, and **inter-step timing** (feeds `median_delay_ms`).
- **Attribution** — every event tagged with `(ats, company_key)` via the extended classifier (LinkedIn/Indeed/Workday/Greenhouse/Lever **+** iCIMS/SuccessFactors/Taleo/Bamboo/Ashby/direct).

**Element-signature scheme (so recipes generalize, not memorize a DOM).** Each interacted element is reduced to a stable, ATS-portable signature rather than a brittle CSS path:
```
signature = {
  label_pattern : normalizeQuestion(<label|aria-label|placeholder|name|id>),   // EN+FR canonical
  field_type    : detected input semantics,
  role_hints    : [aria-role, ATS-class family e.g. 'workday-combobox'],
  scope         : 'ats' (label-only) | 'company' (label + company-specific options),
  anchor        : nearest stable structural anchor (section heading / step label),
}
```
Replay matches by `label_pattern` + `field_type` (reusing the `qa` ≥0.6 token-overlap matcher), not by recorded selector — so a Workday recipe learned at Rogers resolves Bell's Workday even though the DOM differs.

**The hard privacy rail (non-negotiable).** Before *any* write — at both the Observer write path and the legacy harvest path — `SENSITIVE_RX` is extended to drop **password, payment/card/CVV/PIN, SSN, and any credential/security-answer key**. This is layered, not single-point: `autofill.js` already blocks `password/cvv/cardnumber`, `detector.js` has `AUTOFILL_SKIP_RX`, `forms.js` skips SSN/DOB. The new rail is the *write-boundary* backstop, tested adversarially (Phase P0) with explicit positive/negative cases (`'security clearance'` must pass; `'security question'` must drop) so a too-broad regex can't silently eat legitimate fields.

**Cross-browser.** Observer state lives in `storage.local` only (Firefox has no `storage.session`); never assumes `tabGroups`; new content modules registered in `web_accessible_resources` the same way existing ones are. No new permission needed — `<all_urls>`, `webNavigation`, `storage`, `tabs`, `alarms`, `downloads` are already granted, and `<all_urls>` is exactly what "learn from everything" requires.

---

## Programming-by-demonstration: distillation + generalization + replay

The engine is **deterministic-first, Gemma-assisted, verified-before-replay.**

**1. Distillation (recorded session → recipe).** `distiller.js` folds an ordered Observer session into `recipe_steps`:
- Group `nav_events` + interaction events by `session_id`; order by `ts`.
- For each interacted field: emit a step with `action`, `label_pattern` (normalized), `field_type`, `strategy` (the autofill strategy that worked for that type), `options`, `advance_text`, and `median_delay_ms` (the observed delay before the *next* action).
- Determine scope: a field whose answer is invariant across companies on the same ATS (location format, "years of experience" widget) → `scope='ats'`; a field with company-specific options or screening text → `scope='company'`.
- **Deterministic by default.** Step extraction is pure rule-based; **no model is required to build a recipe.**

**2. Generalization (so one apply teaches many).**
- Label clustering via `normalizeQuestion` + `qa` fuzzy match collapses rephrasings ("Years of experience" / "How many years" / "YoE") into one canonical `label_pattern`.
- **Gemma assist (optional, confidence-gated):** when a label is ambiguous or a field's semantics are unclear, the local model proposes a canonical label / field role under JSON schema; the proposal only raises confidence, never invents an answer.
- ATS recipes are stored once per ATS; the first Workday apply seeds the Workday recipe that every other Workday company inherits.

**3. Verification before replay (the safety gate).** A recipe is only eligible for **AUTO** replay when:
- `confidence ≥ θ_replay` (tunable; starts conservative) **and** `success_count ≥ 1` (it mechanically completed at least once), **and**
- `resolveRecipe` produced a step for **every required field** the live page exposes (no gaps → no fabrication).
Otherwise the executor falls back to the existing discover-every-step path.

**4. Replay with divergence guard.** `replayRecipe()` walks `recipe_steps`, filling via the resolved answer ladder (**profile → qa → recipe-default → AI → deterministic**), advancing with paced human timing. On **any** divergence — an unexpected required field, a validation error (reusing stall-detection's inline-error harvest), or 3 no-change advances — it **downgrades to review mode, parks the job, and writes a correction event** that retrains the recipe (bumps the divergent step's pattern, decays confidence). It **never blind-submits on divergence and never fabricates.**

This makes PbD safe: deterministic where it can be, model-assisted only to *raise* confidence, and verified field-by-field before a single automated submit.

---

## Local AI layer

**Goal.** Working AI on a **brand-new offline Windows box** and on **Dad's GPU-less laptop**, hardware-adaptive, with a no-model deterministic floor — packaged through the *existing* electron-builder + GitHub-Actions pipeline. **The multi-GB-installer + USB reality is addressed head-on below.**

**Runtime decision (de-risked).** The candidate that proposed *embedded llama.cpp + Gemma* scored lowest on `localModelOffline` and `feasibility` precisely because it's a **runtime swap** from the Ollama stack that exists today (`localsetup.js` → `OllamaSetup.exe` + `/api/pull`; `ollama.js` → `/api/chat`; `hardware.js` recommends Qwen/Llama). This synthesis chooses the **lower-risk default and keeps the embedded runtime as an optional track:**

- **Default (Track A — keep Ollama, bundle Gemma models).** Reuse the entire working local stack; change only (a) the models pulled/loaded to the **Gemma family** and (b) where the weights come from on first run. This preserves `localsetup.js`'s streaming-download-with-progress + ENOENT-safe spawn (the documented "Dad-no-Ollama" crash fix), `ollama.js`'s liveness-check-before-call + JSON-schema `format` contract, and `provider.js`'s ordered fallback + `ai_log` meter — **zero executor/prompt changes.**
- **Optional (Track B — `ai/gemma.js` embedded llama.cpp).** A new provider implementing the identical `generate({prompt,system,schema}) → {text,json}` contract, slotting into `provider.js`'s `local` branch. Built and tested only if Track A's "user must install a runtime" friction proves unacceptable for Dad. **Track B is explicitly out of the critical path of the one-shot build** (it's a stretch deliverable in Phase P4) so the build cannot stall on a research-grade runtime port.

**Hardware-adaptive selection.** `hardware.js` already probes RAM (`os.totalmem`), VRAM (`nvidia-smi`), and GPU name and returns a recommended tier. Remap `TIERS` to Gemma:
| Tier | Trigger (VRAM/RAM) | Model | Notes |
|---|---|---|---|
| `xl`/`lg` | ≥10GB VRAM or ≥32GB RAM | `gemma-3-4b-it` | Pierre's 3080 box |
| `md` | ≥6GB VRAM or ≥16GB RAM | `gemma-2-2b` / `~3b` | mid laptop |
| `sm` | anything (no GPU) | `gemma-3-1b-it` | **Dad's laptop** |
User-overridable in Settings exactly as today.

**Deterministic fallback (works with NO model at all).** `ai/deterministic.js` mirrors the prompt's own "ANSWER THESE COMMON QUESTIONS WITH HIGH CONFIDENCE" rules with pure regex/profile-derivation: location/residency, which-location, preferred language, relocation/remote, years-of-experience-from-resume, education level — plus `fit.js` for scoring and `qa` fuzzy-lookup for repeats. So even with **no model installed**, the engine still applies to known forms (it only loses free-text generation like cover letters). This is the highest-confidence single claim in the design because every dependency (`fit.js`, `jobLevel`, `qa` lookup) already runs with zero model.

**Packaging — the multi-GB reality, addressed three ways.**
1. **Weights ship as a SEPARATE GitHub Release asset, not inside the NSIS installer.** `app/package.json` has **no `extraResources`** today and 4B-class GGUF + middle tiers exceed **GitHub Releases' 2 GB-per-asset limit** and bloat free-runner CI. So: the installer stays lean (app + `node-sqlite3-wasm` asarUnpack as today), and weights are published as **per-tier release assets** (`gemma-1b.gguf`, `gemma-3b.gguf`, `gemma-4b.gguf`) each under the 2 GB cap.
2. **First-run, hardware-targeted download** of *only the tier this machine needs* (Dad's laptop pulls ~1 GB, not 9 GB), reusing `localsetup.js`'s exact streaming-download-with-progress + verify-after pattern, just pointed at the GGUF release URL instead of `/api/pull`. Content-addressed + **checksum-verified** on first launch, so a partial/stripped copy self-heals.
3. **USB / true-offline path.** For a box that will never have network (the "brand-new offline Windows box"), ship an **optional all-tiers weights bundle** as a downloadable sidecar the user can carry on USB; first-run setup checks a `models/` sidecar directory next to the installer **before** attempting any network fetch. This is the honest answer to "bundle-all": the *capability* is offline-complete, but we don't force every installer to be 9 GB — Windows-only inline-or-sidecar weights + tier-targeted first-run download is the shippable shape on the existing pipeline.

**Provider order.** Stays `['claude','chatgpt','local']` for Pierre (he has API keys); Dad runs `local-only` on bundled Gemma; deterministic.js is the floor under `local`. Every attempt is metered in `ai_log` for the usage panel.

---

## Reward & self-improvement loop

North star = **interview responses via Gmail.** Four stages:

**(1) Lenient match.** Route Gmail through the same `emailUpsert` + `matchEmailToJob` path the IMAP `email.js` already uses (this is the net-new wiring; `gmail.js` currently writes status via `recordEvent`/`patchJob` and does **not** populate `emails`). Extend `matchEmailToJob` to score on **(a) company hint ↔ company, (b) sender-domain ↔ company-domain** (new explicit signal), **(c) fuzzy job title** in subject/body, **(d) time window** (email arrived after `submitted_at`, decaying over ~120 days — the existing scorer's shape). High-confidence + a clear single winner → `match_source='auto'`; borderline → `'suggested'` (NOT applied).

**(2) Confirm + train.** `'suggested'` rows surface in a one-click **confirm-this-link inbox**. Confirming sets `match_source='manual'`, applies the forward-only `STATUS_ORDER` elevation, **and stores `(email-features → job)` as a labeled example** that tunes the matcher's thresholds — so a single click both heals the link and makes the matcher more lenient-but-accurate next time. (Dismiss → `'dismissed'`, a negative training example.)

**(3) Reward + credit assignment.** When a linked email classifies as `interview_1/offer/contacted`, write an `application_outcomes` row with **positive reward**; a credit pass fans it to:
- the `qa` answers used in that application (located via `answer_lineage`) → bump `reward_score`,
- the `recipe_steps` that filled them → bump step + recipe confidence,
- the `(ats, company)` recipe → bump `reward_score`.
A `rejected` email writes a **mild-negative** outcome that touches **only fit/relevance ranking** — the recipe and answers keep their mechanical-success credit (the app *worked*); the nudge points discovery toward companies/roles that reply positively, exactly per the charter ("rejection = mild negative on FIT").

**(4) Human signal & re-ranking.** Star ratings and "punish job/job-type/company" write `application_outcomes` + `punishments` rows. **`rankJob(job, profileId)`** blends: deterministic `fit.js` ⊕ AI fit ⊕ `reward_score` history ⊖ `punishments` (with `decay_at`) ⊖ staleness. Discovery + `queueNext` consume this single rank. **Net effect:** companies and answer-patterns that produce interviews float up; mid/irrelevant/punished ones sink; the matcher gets more accurate as the user confirms links.

**Credit-assignment guardrail (addresses the "poisoned reward" risk).** Because lenient matching at max volume can mis-link, credit is **fractional and confidence-weighted**, not all-or-nothing: a `match_source='auto'` reward is applied at full weight only above a high confidence floor; `'suggested'` rewards are *held* until user-confirmed; reward magnitudes are clipped so one mislabel can't dominate. This keeps the loop from learning from its own noise.

---

## External + direct-company-site applying

The executor today **detects** external applies and bails (terminal skip). The engine makes this a first-class flow:
- **LinkedIn/Indeed → external ATS handoff.** The Observer records the handoff edge (`kind='handoff'` in `nav_events`); the existing handoff logic already persists job identity (title/company/jobUrl) across domains for 10 min. The Replayer follows the recorded edge: it navigates to the external ATS, resolves that ATS's recipe, applies, and returns to the board's tracking tab.
- **Direct company career sites.** A direct apply (no board) is attributed `ats='direct'` or the detected ATS if the career site runs Workday/Greenhouse/etc. behind a custom domain — so a direct apply at `careers.rogers.com` still feeds the **Workday** ATS recipe.
- **Per-ATS transfer is the whole point.** Because recipes key on ATS, one external/direct apply on a given ATS improves replay for **every** company on that ATS, regardless of how the user got there (board handoff or direct).

---

## Anti-detection for max volume

**Stealth floor = the user's own recorded human rhythm.** The Observer records real inter-step timing, scroll pauses, and click cadence into `recipe_steps.median_delay_ms`. The Replayer plays them back with **jitter** (randomized delays around the learned median, `mousedown → pause → mouseup` instead of synthetic instant clicks, occasional scroll-into-view pauses) — replacing the current fixed `sleep(600ms)`. Crucially, because recipes encode the human's **real DOM journey** (including board→external handoff), a replayed application follows the same path a person took, not a synthetic shortcut.

**Honesty rail (from the adversarial review).** Replaying recorded pacing is a *stealth floor, not a guarantee* — convincingly evading modern bot-detection across arbitrary ATS DOMs is an adversarial, unsolved problem. The design treats it as **harm-reduction layered on hard safety controls**, not a silver bullet:
- **Volume paced by the existing throttle** — `queueNext`'s `minGap/maxGap ÷ concurrency`, daily/hourly caps, `withinWindow`.
- **Concurrency capped at 3 windows**, one active un-throttled tab each (already enforced) — parallelism never spikes into obvious-bot territory.
- **Never bypass CAPTCHA/login** — those route to `awaiting_input` (already the behavior).
- **Account safety:** per-domain caps and back-off on repeated failure/error pages; the punishment/decay machinery doubles as a circuit breaker (a company that throws errors gets de-prioritized).

---

## Geo / remote expansion (gated by work authorization)

"Remote" expands apply scope broadly (e.g., US / worldwide-remote), **gated by the user's stated work authorization** stored in `profile_fields` (a locked, user-edited field). Discovery's geo filter:
- If a job is remote **and** the user is authorized for that region → in-scope.
- If a job requires on-site / a region the user isn't authorized for → out-of-scope (down-ranked, not punished).
Work-authorization questions are answered **only from profile or AI** (never EEO, never fabricated) — the existing legal/work-auth gate in the executor is reused unchanged. The expansion is a *ranking* lever (more remote candidates surface) bounded by a *truthfulness* gate (authorization must be real).

---

## Cross-browser + product-ready notes

**Cross-browser.** Chrome MV3 and Firefox stay at parity because every new subsystem reuses proven patterns: `background.js` already guards `chrome.tabGroups?.*` and keeps apply-tab registry/concurrency/window-id in `storage.local` (not `storage.session`, which Firefox lacks); the Observer's nav recorder and Replayer state follow the same `storage.local`-only rule; both browsers support the `webNavigation` events tapped. `manifest.json` already carries `browser_specific_settings.gecko` (id + `strict_min_version 121`, MV3 SW). New content modules join `web_accessible_resources` the same way existing ones do. No new permission is required. The **dashboard mirror gate** (`extension/app/* ↔ app/src/app/*` byte-identical) and `validate-extension.mjs` in CI keep both builds honest.

**Product-ready.** Every new table FK-cascades to `profiles`, so per-user isolation is structural, not bolted on. `answer_lineage`, `application_outcomes`, and `punishments` are clean, exportable, and per-profile — `POST /export` / `POST /import` (already an extension point) extends to recipes + outcomes with a review gate. No PII leaves the box; the hard rail guarantees credentials are never stored. The result is a system that could become a real multi-user product without a data-model rewrite.

---

## PHASED IMPLEMENTATION PLAN

Sequenced so an autonomous one-shot build executes end-to-end with self-verification and a GitHub commit per phase. Each phase gates on `npm test` (the existing harness: `status, fit, prompts, secrets, profile-memory, autoapply, autoapply-breakdown, data-safety`) **plus** new targeted tests. **Note:** there are **no existing recipe/replay/observer tests** — each greenfield phase must *create* its gating test as a deliverable before the feature is "done." Commits go to a branch; the release pipeline (`v11.* tag → Actions → electron-builder → PierreSalama/Job-ext-app`) is exercised only at the explicit release phase.

> **Build-order rationale.** Safety first (P0), then the data the loop needs (P1–P3), then the offline brain (P4), then the consumers of that data (P5 Replayer, P6 Reward), then ranking that ties it together (P7), then hardening + release (P8–P9). The two greenfield, research-tinged pieces (Replayer P5, embedded-runtime stretch in P4) are isolated so a stall in either cannot block the reward loop, which is the north-star deliverable.

### P0 — Safety rail + migration scaffolding
- **Goal.** Close the non-negotiable credential rail and lay all migration groundwork before any learning code runs.
- **Deliverables.** Extend `SENSITIVE_RX` in `db.js` to drop password/payment/card/CVV/PIN/credential/security-answer keys at **both** the Observer write path and the harvest path. Add all new tables + additive `ALTER`s via the `MIGRATIONS[]` array (with `backupNow('pre-vN')`). New `tests/safety-rail.test.mjs`.
- **Verifies (agent).** `npm test` green (esp. existing `data-safety.test.mjs`); `safety-rail.test.mjs` proves credential keys can never reach `qa`/`profile_fields`/recipes, with positive/negative cases ('security clearance' passes; 'security question' drops); migration runs **idempotently** on a copy of a real `userDir` DB (re-run → no-op, `user_version` advances once).
- **Exit criteria.** All tests green; DB on a copied real userDir migrates cleanly and re-runs as no-op; backup file created.
- **Risk.** Too-broad regex eats legitimate fields → mitigated by explicit positive/negative test corpus committed in this phase.

### P1 — Observer (answers) promoted to always-on
- **Goal.** Promote existing passive capture into an always-on Observer recording every manual application's answers with lineage, on any site, independent of the queue.
- **Deliverables.** Stamp captured answers with `answer_lineage` source `'manual'` through `captureCurrentAnswers → harvestAnswersToProfile`; `POST /observe` route wired to existing `upsertJob` atomicity; capture is a no-op when auto-apply is off.
- **Verifies (agent).** Replay recorded **jsdom fixtures** of a Workday + Greenhouse manual apply; assert answers land in `profile_fields` with lineage and sensitive fields excluded. Extends `profile-memory.test.mjs`.
- **Exit criteria.** Fixtures produce lineage-stamped answers; zero sensitive keys; capture runs with queue off.
- **Risk.** Double-harvest / over-capture on noisy pages → reuse `detectApplyForm` scoring + `JUNK_KEY_RX`.

### P2 — Navigation recorder + ATS classifier
- **Goal.** Record the human navigation path + ATS/company attribution recipes need.
- **Deliverables.** `nav_events` writer hooked to existing `webNavigation` listeners (storage.local-safe); ATS classifier extended to iCIMS/SuccessFactors/Taleo/Bamboo/Ashby/direct; handoff-edge detection folded into `nav_events`; **rolling cap** enforced on insert.
- **Verifies (agent).** Feed a synthetic nav trace (Google→LinkedIn→Workday); assert correct `(ats, company)` attribution + a `handoff` edge; assert row count stays bounded under the cap after N inserts. New `tests/observer-nav.test.mjs`.
- **Exit criteria.** Attribution + handoff correct; rolling cap holds; no Firefox-incompatible API used (validate-extension passes).
- **Risk.** `nav_events` bloat → rolling window + per-session cap from day one (tested).

### P3 — Recipe Store + Distiller + Transfer Engine
- **Goal.** Turn recorded answers+navigation into reusable, transferable recipes keyed by ATS and company.
- **Deliverables.** `distiller.js` folds Observer sessions into `ats_recipes` + `recipe_steps` (label_pattern, field_type, strategy, advance_text, median_delay_ms); `resolveRecipe(ats, company, profileId)` blending ATS-level + company overlay (company wins on conflict); recipe-coverage score exposed.
- **Verifies (agent).** New `tests/recipe-transfer.test.mjs`: distill one apply at `Rogers/Workday` → assert a fresh `Bell/Workday` page resolves the **ATS** recipe; a company-specific screening question resolves the **company overlay**, not the ATS default.
- **Exit criteria.** Cross-company ATS transfer proven; overlay precedence proven; coverage score returned to discovery.
- **Risk.** Over-generalized ATS recipes fill company fields wrong → confidence + company-overlay precedence + the P5 divergence guard mitigate.

### P4 — Bundled Gemma local AI + deterministic fallback
- **Goal.** AI that works on a fresh offline Windows box and a weak laptop, with a no-model floor.
- **Deliverables.** **(Track A, critical path)** Remap `hardware.js TIERS` to Gemma 1b/2-3b/4b; publish per-tier GGUF as separate release assets; first-run **tier-targeted** download reusing `localsetup.js` streaming+verify+checksum; USB sidecar `models/` check before network. `ai/deterministic.js` mirroring the prompt's high-confidence common-question rules + `fit.js`. **(Track B, stretch — non-blocking)** `ai/gemma.js` embedded-llama.cpp provider behind the same `generate()` contract.
- **Verifies (agent).** Extend `ai-provider.test.mjs`: with **no network** and the bundled 1B tier, `/ai/answer-question` returns grounded answers; with **no model at all**, `deterministic.js` answers location/education/years/relocation and `fit.js` scores; checksum-verify rejects a corrupted GGUF; installer boots on a clean Windows VM image (Track A) without crashing when no runtime is present (ENOENT-safe).
- **Exit criteria.** Offline-with-1B works; no-model deterministic floor works; corrupt-weight self-heals; clean-VM boot is crash-free. (Track B optional; if not green, default to Track A and proceed.)
- **Risk.** Installer size + CI time + the runtime-swap temptation → **separate weights assets** (under 2 GB each) + Windows-only + tier-targeted download keep it shippable; Track B explicitly cannot block the build.

### P5 — Recipe Replayer + human-pacing stealth (greenfield)
- **Goal.** Auto-apply replays known-good recipes with learned cadence; diverges safely.
- **Deliverables.** `replayRecipe()` path in `executor.js` consuming `recipe_steps`; verification gate (every required field has a step, else fall back); divergence guard → park + correction event that retrains the recipe; pacing jitter from `median_delay_ms` (`mousedown→pause→mouseup`, scroll pauses).
- **Verifies (agent).** Extend `autoapply.test.mjs`: a recorded recipe replays end-to-end on its fixture (paced, no fabrication); an **injected unexpected required field** forces a downgrade to review (no blind submit, correction event written); a low-confidence recipe falls back to discover-every-step.
- **Exit criteria.** Happy-path replay green; divergence → review + retrain green; confidence gate green; never fabricates / never blind-submits on divergence.
- **Risk.** Stale recipes after ATS DOM change → divergence guard + confidence decay + fall-back-to-discovery prevent broken submits.

### P6 — Reward Engine: Gmail → emails table, lenient match + confirm-train
- **Goal.** Make interview replies the north-star signal and let confirmation train the matcher.
- **Deliverables.** **Wire Gmail through `emailUpsert` + `matchEmailToJob`** (net-new — `gmail.js` does not write `emails` today); add `sender_domain ↔ company-domain` as an explicit signal in `matchEmailToJob`; write `match_confidence`/`match_source`; confirm-link inbox (`suggested→manual` + stores a labeled training example + applies forward-only elevation); `application_outcomes` rows on classified linked emails (positive reply / mild-negative rejection).
- **Verifies (agent).** Extend `prompts.test.mjs` + new `tests/reward-match.test.mjs` with fixtures: a recruiter reply from a sender-domain matching a recently-applied company links as `auto`; an ambiguous reply links as `suggested`; confirming a `suggested` row flips it to `manual`, elevates status, and persists a training example; a rejection writes a mild-negative outcome that touches fit-rank only (recipe/answer credit preserved).
- **Exit criteria.** Gmail populates `emails`; lenient match emits correct lifecycle; confirm trains + elevates; rejection is fit-only; outcomes ledger populated.
- **Risk.** Mislabeled rewards poison credit / confirm-prompt flood violates Goal 4 → fractional confidence-weighted credit, hold `suggested` rewards until confirmed, and surface a *prompt-volume* metric so leniency can be tuned down.

### P7 — Strict relevance, punishments + unified rankJob
- **Goal.** Tie credit + punishment + fit into the single rank discovery and the queue consume.
- **Deliverables.** `punishments` table + write paths; `rankJob(job, profileId)` = `fit.js` ⊕ AI fit ⊕ `reward_score` ⊖ punishments(decay) ⊖ staleness; `queueNext` + discovery consult it; "punish company" button cascades to all that company's queued tasks; geo/remote gate keyed to work-authorization profile field.
- **Verifies (agent).** New `tests/rank-punish.test.mjs`: punishing a company removes all its queued tasks and excludes future discovery (until decay); a high-reward `(ats,company)` outranks a fit-equal cold one; an unauthorized-region on-site job is down-ranked; punishment decay restores eligibility after `decay_at`.
- **Exit criteria.** Punish cascade works; reward history moves rank; geo gate honored; decay restores.
- **Risk.** Over-punishment starves volume → decay + per-kind weighting + a "punished" dashboard view so the user sees and can lift blocks.

### P8 — Cross-browser parity + end-to-end self-verification
- **Goal.** Prove Observer + Replayer + Reward at full parity on Chrome MV3 and Firefox, end to end.
- **Deliverables.** Apply `tabGroups`/`storage.local` guards to all new state; browser-caps probe; full `npm test` + `validate-extension.mjs`; an end-to-end fixture run (manual apply observed → distilled → replayed → simulated interview email → reward credited → rank moved).
- **Verifies (agent).** `validate-extension.mjs` passes for both builds; the dashboard mirror gate (`extension/app/* ↔ app/src/app/*`) is byte-identical; the e2e fixture asserts the full loop closes (a credited outcome row + a moved `rankJob` score for the originating `(ats,company)`).
- **Exit criteria.** Both browser builds validate; mirror gate green; e2e loop closes measurably.
- **Risk.** Firefox-only regressions from a Chrome-only API slipping in → caps probe + CI validate gate catch it before release.

### P9 — Release: weights pipeline + installer + tag
- **Goal.** Ship through the existing pipeline with the weights-sidecar reality handled.
- **Deliverables.** Publish per-tier GGUF as release assets; confirm NSIS installer stays lean + first-run tier download + USB sidecar path; bump version, cut a `v11.*` tag → Actions → electron-builder → `PierreSalama/Job-ext-app`.
- **Verifies (agent).** Clean Windows VM: install → first-run pulls the machine's tier (or finds the USB sidecar) → AI answers offline after pull → deterministic floor works with weights absent. Release artifacts present on the GitHub release; each asset under 2 GB.
- **Exit criteria.** Clean-VM install→offline-AI works; assets published under size cap; tag-built installer runs.
- **Risk.** **(Dad-trial constraint, from memory.)** Releases auto-update Dad's app. **Do NOT run `release.ps1` / cut a public `v11.*` tag while Dad's trial is active** — iterate locally (`npm start` / reload unpacked) until Pierre clears the release. This phase is **gated on Pierre's explicit go** (see Open Questions).

---

## Key risks & mitigations

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Recipe Replayer is fully greenfield** (no executor seam exists); divergence handling across arbitrary ATS DOMs is hard. | High | Verification-before-replay gate; divergence guard → review (never blind-submit); confidence decay + fall-back-to-discovery; isolated in P5 so it can't block the reward loop. |
| 2 | **Bundled-Gemma is a packaging + (optional) runtime change, not a graft;** 9 GB bundle-all fights GitHub's 2 GB/asset limit. | High | Track A (keep Ollama, bundle models) is the critical path; weights are **per-tier sidecar assets** + tier-targeted first-run download + USB sidecar; Track B (embedded llama.cpp) is non-blocking stretch. |
| 3 | **Gmail isn't wired to the `emails` table** (the lenient matcher lives in IMAP `email.js`). | Med-High | P6 explicitly routes Gmail through `emailUpsert`/`matchEmailToJob`; treated as net-new wiring, not assumed. |
| 4 | **Lenient matching at max volume poisons credit** (mislabels) or **floods confirm-prompts** (violates Goal 4). | Med-High | Fractional confidence-weighted credit; hold `suggested` rewards until confirmed; reward clipping; confirm-prompt-volume as a tunable metric. |
| 5 | **Human-pacing replay ≠ guaranteed bot-evasion.** | Med | Framed as harm-reduction floor *on top of* hard controls: throttle, concurrency cap (3), never bypass CAPTCHA/login, per-domain back-off. |
| 6 | **One-shot autonomous build of greenfield RL-ish loop + new AI packaging with no pre-existing tests.** | Med-High | Every greenfield phase ships its own gating test as a deliverable; phases sequenced so a stall in P5/Track-B can't block the north-star loop; per-phase commits. |
| 7 | **Too-broad `SENSITIVE_RX`** eats legitimate fields. | Med | P0 positive/negative test corpus; layered (not single-point) rails. |
| 8 | **`nav_events` SQLite bloat.** | Low-Med | Rolling cap enforced on insert + tested in P2. |
| 9 | **Over-punishment starves volume** (Goal 1 ⊥ Goal 3). | Low-Med | Decay; per-kind weighting; "punished" dashboard view to review/lift. |
| 10 | **Releasing during Dad's trial breaks his run.** | Med (process) | P9 gated on Pierre's explicit go; iterate locally until cleared. |

---

## Open questions for Pierre (decide before/while building)

1. **Local runtime — Track A or B?** Default is **keep Ollama, bundle Gemma models** (lowest risk, reuses the whole working stack). Do you want the **embedded llama.cpp** track built in this one-shot (so Dad needs *no* separate runtime), accepting it as the build's riskiest piece — or keep it as a stretch and accept Ollama's one-time install on Dad's box?
2. **Offline-bundle shape.** Acceptable that the installer stays lean and the machine's *tier* downloads on first run (Dad pulls ~1 GB), with a **USB sidecar** for true-no-network boxes — vs. forcing one ~9 GB all-tiers installer? (The latter exceeds GitHub's 2 GB/asset limit, so it can't be one release asset regardless.)
3. **Confirm-prompt budget.** What's the acceptable *daily* volume of "confirm this email↔application link" prompts before leniency auto-tightens? This is the direct Goal-1↔Goal-4 tension knob.
4. **Replay autonomy threshold.** Initial `θ_replay` — how conservative? E.g., AUTO-replay only after a recipe has `success_count ≥ 2` and one confirmed *positive* outcome, vs. replay after a single mechanical success?
5. **Gemma vs. Qwen for the local tier.** The charter says Gemma 1B/2B/4B; the existing `hardware.js` recommends Qwen/Llama (which are already proven on your stack). Hard requirement Gemma, or open to keeping the proven Qwen tiers for the structured-JSON path and using Gemma only for prose?
6. **Dad-trial release gate.** Dad's ~1-week trial started ~2026-06-15. Confirm: **no public `v11.*` release / `release.ps1`** until you explicitly clear it — the one-shot stops at P8 (local-validated) and waits for your go on P9?
7. **Work-authorization source of truth.** Should geo/remote expansion read authorization from a single locked `profile_fields` key you set once, or per-profile (e.g., a "US-authorized" profile vs. a "Canada-only" profile)?
8. **Punishment permanence default.** When you punish a company, default to **permanent** or **decaying** (and over what horizon)?
