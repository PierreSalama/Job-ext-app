# JAT v11 — Teach & Correct + backlog (Apprenticeship Engine v2) — design & phased plan

Captured 2026-06-16 from Pierre's design conversation. **Design only — no code until
greenlit.** Builds directly on the v11.18.0 Apprenticeship Engine (Observer → Distiller
→ Replayer → Reward + recipes). This is the "teach it by doing, and correct it live"
layer plus the live-test bug fixes and new board support, shipped as ONE new version of
the extension + app.

---

## Vision
Turn *Pierre applying* into the system's training signal at the highest fidelity: it
watches exactly what he clicks and types — the real elements, not guesses — and lets him
**run auto-apply in front of him and correct it on the spot, every detail, by clicking
the right thing.** Every manual apply and every correction sharpens the recipe library so
auto-apply gets measurably better the more he uses it.

## Goals (locked decisions)
1. **Record every interaction at full fidelity** — XPath + CSS + attribute signature +
   label/question + HTML snippet + **screenshot** + value + inter-step timing.
2. **Two capture triggers:** always-on passive **and** a deliberate **Teach Mode** for
   hard training sessions.
3. **Live Teach & Correct:** a supervised run (Step or Run), where a wrong step is fixed
   by **clicking the correct element OR picking from a detected list** (+ value fix), and
   the correction **instantly + authoritatively** updates the recipe.
4. **Full review/audit dashboard:** every learned step is viewable/editable/deletable/
   reorderable, with its screenshot, locator, value, confidence, and a replay-preview.
5. **Retention:** keep the latest-few demonstrations/screenshots per step; prune older.
6. **Privacy rail unchanged:** never capture credential/payment values OR the HTML/
   screenshot regions of those fields.
7. Also in this version: fix the live-apply bugs (A2/A3), Easy-Apply-limit pivot (A1),
   external company-site learning (C), Glassdoor (D).

---

## Components

### 1. The Recorder (content script) — `extension/content/recorder.js` (NEW)
Always-on + Teach-Mode capture of the user's real interactions on any job/apply page.
- Hooks `click`, `input`/`change`, `submit`, focus, and step-advance, scoped to detected
  apply contexts (reuse `detectApplyForm` + the verified dialog root; never site chrome).
- Per interaction, builds a **locator bundle**: robust XPath, a CSS selector, an attribute
  signature (id/class/aria/role/name/data-*), the label/question (`normalizeQuestion`), a
  trimmed **outerHTML snippet**, and the **action + value** (rail-guarded).
- Captures a **screenshot** at meaningful steps (via `chrome.tabs.captureVisibleTab` from
  the SW, or an in-page canvas crop) — bounded, redacting sensitive field regions.
- Records **inter-action timing** → real `median_delay_ms` (replaces the faked pacing).
- Batches to the app: `POST /observe/step` (extends the P2 `/observe` surface).
- **Teach Mode**: a toggle in the overlay/popup; when on, capture is high-fidelity +
  shows a live "captured ✓" affirmation per step so Pierre sees it learning.

### 2. Live Teach & Correct — supervised run + on-page correction
The centerpiece. Pierre picks a job and starts a **"Watch & Teach"** run.
- **Run style (Step | Run):** Step pauses before each action for OK; Run goes at pace and
  he hits **"Wrong"** when he sees an error. Toggle in the overlay.
- **Correcting a step:** he clicks **"Fix this"** → the page enters a **pick mode**
  (DevTools-style highlight on hover) → he **clicks the correct element**, *or* picks it
  from a **list of detected fields/buttons**, and can correct the **value**.
- **Instant authoritative update:** the picked element's locator bundle replaces the
  recipe step's locator (and value), confidence is set high (user-confirmed), and a
  **correction event** is logged. Next apply on that ATS uses the corrected step.
- Built on the P5 `attemptReplay` + `replay.js` decision logic, with a new "supervised"
  mode and a correction overlay; reuses `recordRecipeCorrection` (extended to accept a
  replacement locator/value, not just a confidence decay).

### 3. Review / Audit dashboard — "Taught Procedures"
A dashboard page (mirrored `extension/app/*` ↔ `app/src/app/*`).
- Per **ATS / company**: the ordered recipe steps, each with its screenshot, locator,
  field-type, value, confidence, source (manual/teach/correction), last-seen.
- **Edit / delete / reorder** steps; edit a value; flip a step's scope (ats↔company);
  **replay-preview** (dry-run highlight of where each step would act).
- "Needs attention" surfacing: low-confidence or recently-diverged steps.

### 4. Recipe enrichment + selector-first replay
- The **Distiller** folds demonstrations into `recipe_steps`, now with real
  `selector`/`xpath`/`html`/`screenshot`/`median_delay_ms`.
- The **Replayer** targets **selector-first** (XPath/CSS), falling back to the existing
  `label_pattern` token-match — far more robust than today's label-only matching.

### 5. Backlog fixes folded in
- **A2 (search-bar "0"):** scope every fill to the verified apply dialog root; harden the
  "never touch site chrome / global search" guard; trace the `0` value source.
- **A3 (window opens over you / tab never loads):** restore "open on the side, not over
  the user," ensure the apply tab is `active` in its dedicated window and not occlusion-
  throttled; make the hydrate-nudge reliably activate the tab. (Investigate the regression
  vs the earlier good state.)
- **A1 (Easy Apply ~50/24h):** detect the limit modal, learn the per-account threshold,
  set a cooldown, and **pivot to external/company-site jobs** during it instead of idling.
- **C (external/company sites):** the recorder + selector-first replay make real career
  sites first-class (already partly via P2 handoff + P3 `direct`/ATS recipes).
- **D (Glassdoor):** `classifyAts` + `discover.js` + `detector.js` + a
  `content/sites/glassdoor.js` adapter (incl. its frequent external-ATS redirects).

---

## Data model (additive; all ids TEXT/uid; FK-cascade to profiles)

```sql
-- Raw high-fidelity demonstrations (pre-distillation); rolling-capped per (ats,label).
CREATE TABLE demonstrations (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  session_id TEXT, job_id TEXT, ats TEXT, company_key TEXT,
  step_index INTEGER, action TEXT,             -- click|fill|select|upload|advance
  label TEXT, label_norm TEXT, field_type TEXT,
  selector TEXT, xpath TEXT, attrs TEXT,       -- attrs = JSON signature
  html TEXT,                                   -- trimmed outerHTML snippet
  value TEXT,                                  -- rail-guarded
  screenshot_id TEXT, delay_ms INTEGER,
  source TEXT,                                 -- manual|teach|correction
  ts TEXT
);

-- Screenshots stored as files under userData/teach-shots/, referenced by id; pruned.
CREATE TABLE teach_screenshots (
  id TEXT PRIMARY KEY, profile_id TEXT, path TEXT, w INTEGER, h INTEGER, bytes INTEGER, ts TEXT
);

-- recipe_steps gains the real locator bundle (additive ALTERs):
ALTER TABLE recipe_steps ADD COLUMN selector TEXT;
ALTER TABLE recipe_steps ADD COLUMN xpath TEXT;
ALTER TABLE recipe_steps ADD COLUMN attrs TEXT;          -- JSON
ALTER TABLE recipe_steps ADD COLUMN html TEXT;
ALTER TABLE recipe_steps ADD COLUMN screenshot_id TEXT;
ALTER TABLE recipe_steps ADD COLUMN source TEXT;         -- manual|teach|correction|distilled
ALTER TABLE recipe_steps ADD COLUMN default_value TEXT;  -- a learned constant answer, if any
```
Retention: a prune keeps the newest N (e.g. 3) demonstrations + screenshots per
`(profile, ats, label_norm)`; screenshots are files (small disk, easy to cap).

---

## Phased implementation plan
Each phase: edit → mirror if dashboard → `npm test` + new targeted tests → commit. Ship
as one new version at the end. Ordered so the bugs that block live runs come first.

- **T0 — Bug fixes A2 + A3.** Verified-dialog fill scope + search guard; window placement/
  activation/throttle. *Verify:* fixtures for the fill-scope guard; manual live re-test.
- **T1 — Schema + retention.** `demonstrations`, `teach_screenshots`, `recipe_steps`
  ALTERs, prune-keep-N. *Verify:* migration idempotent; prune test.
- **T2 — Recorder (full fidelity) + Teach Mode toggle.** `recorder.js`, locator bundle,
  screenshots, timing, `/observe/step`. *Verify:* jsdom fixtures → demonstrations rows
  with full locator bundle, rail excludes credentials.
- **T3 — Distiller enrichment + selector-first replay.** Fold demonstrations → enriched
  `recipe_steps`; replayer targets selector-first. *Verify:* recipe gains real selectors;
  replay-plan resolves by selector on a fixture.
- **T4 — Live Teach & Correct.** Supervised run (Step/Run), on-page "Fix this" picker +
  detected-list + value fix, instant authoritative recipe update + correction log.
  *Verify:* the correction path (pick element → recipe step rewritten + confidence high)
  on a fixture; pure decision logic unit-tested.
- **T5 — Review/Audit dashboard.** "Taught Procedures" page (view/edit/delete/reorder/
  replay-preview); mirror gate. *Verify:* mirror byte-identical; edit/delete round-trips.
- **T6 — A1 Easy-Apply-limit detect + pivot.** *Verify:* limit-detected → cooldown set →
  queueNext skips Easy-Apply, still dispatches external.
- **T7 — C external hardening + D Glassdoor.** Glassdoor adapter + classifier; external
  career-site capture/replay. *Verify:* classifyAts(glassdoor); discovery fixture.
- **T8 — Cross-browser + e2e + release.** Parity guards on all new state;
  validate-extension + mirror; an e2e "teach → correct → enriched recipe → replay targets
  the corrected element" test; bump version, build, publish (app GitHub + extension CWS).

---

## Key risks & mitigations
| Risk | Mitigation |
|---|---|
| Screenshots/HTML bloat storage | Files on disk + prune-keep-N per step; screenshots optional-skippable. |
| On-page picker conflicts with the site's own JS | Picker is an isolated overlay capturing in capture-phase; Esc to cancel; never submits. |
| Brittle selectors break on DOM change | Keep BOTH selector and label_pattern; selector-first, label-fallback; corrections refresh selectors. |
| Live-correct could mis-bind a correction | Correction requires explicit element pick + confirm; logged + undoable from the review UI. |
| Privacy: screenshots/HTML of sensitive fields | Rail redacts credential/payment field values, HTML, and screenshot regions. |
| Scope is large (8 phases) | Phased + per-phase tests + per-phase commits; bugs first so live runs work throughout. |

## Open questions for Pierre
1. **Screenshots:** in-page crop of just the apply form (lighter, focused) vs full visible-
   tab capture (simpler, heavier)? (Recommend: form-crop.)
2. **Teach Mode surface:** a button in the on-page overlay, the extension popup, or both?
   (Recommend: both.)
3. **Supervised-run default:** start in **Step** mode the first time you teach a new ATS,
   then **Run** once a recipe is trusted? (Recommend: yes — auto-pick by confidence.)
