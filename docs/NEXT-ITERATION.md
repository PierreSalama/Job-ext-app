# JAT v11 — Next Iteration: live-test fixes + Apprenticeship Engine v2

Captured 2026-06-16 from Pierre's live testing of v11.18.0. **Documentation only —
nothing here is implemented yet.** Ordered: bug fixes first (they block real-world
throughput), then the v2 learning features.

---

## A. Live-test bug fixes (observed while auto-applying on LinkedIn)

### A1. LinkedIn Easy Apply daily limit — detect, pause, pivot
**Observed:** LinkedIn modal *"You reached today's Easy Apply limit."*

**Research (the limit):** ~**50 Easy Apply submissions per rolling 24-hour window.**
- LinkedIn does **not** publish this officially (not in TOS / help). The ~50 figure is
  user-reported + third-party-confirmed across 2025–26 sources.
- It's a **rolling 24h** window — the timer starts at your first apply of the cycle.
- **Premium does NOT raise it.** Introduced to curb one-click spam.

**Desired behavior:**
1. **Detect** the limit (the modal text `reached today's Easy Apply limit`, or a
   submit that's refused with that copy).
2. **Record** how many Easy Applies we'd done in the window when it hit, so we *learn
   the real threshold over time* per account (it may not be exactly 50) and surface our
   current best estimate in the dashboard.
3. **Pause Easy Apply** for a cooldown (set `kv.easyApplyLimitUntil = now + ~24h`).
4. **Pivot, don't idle:** while Easy Apply is cooled down, keep working the queue on
   **non-Easy-Apply** jobs — external/company-site applies (see B/C), discovery, and
   distilling recipes from past applies. Resume Easy Apply after the cooldown.

**Where:** `executor.js` (detect modal + report `easyapply-limit`), `db.js`/`server.js`
(`easyApplyLimitUntil` kv + a rolling 24h submit counter), `queueNext` (skip Easy-Apply
route while cooled down, still dispatch external/direct jobs), dashboard (show the
inferred limit + cooldown countdown).

### A2. Executor types "0" into LinkedIn's global search bar instead of clicking Apply
**Observed:** instead of clicking Apply it kept going to the **top search bar** and
entering **"0"**.

**Hypothesis:** a fill/scan path is targeting LinkedIn's global header search input
(a `role="combobox"` typeahead) rather than a field *inside the apply modal*. There's
already a guard in `autofill.js scanUnknown` that skips `input[type="search"]` and
role=combobox labeled "search" — but it's **leaking** here: either the current DOM
doesn't label it "search", or the replay/fill path bypasses the guard. Two sub-bugs:
(a) wrong element targeted (the search box), and (b) the value "0" — trace where a bare
`0` comes from (a years/quantity answer? a default? a mis-resolved step?).

**Fix direction:**
- **Scope every fill to the verified apply dialog root** — never fill an input that
  isn't inside the confirmed apply modal/`dialog` (we already verify that dialog for
  submit; reuse it as the fill boundary).
- Harden the "never touch site chrome" guard: explicitly exclude LinkedIn's top search
  by id/class/aria/placeholder, and never fill a combobox/typeahead that lives outside
  the apply form.
- Trace + fix the `0` value source.

**Where:** `autofill.js` (scan/fill boundary + search guard), `executor.js`
(pass the verified dialog root as the fill scope), `replay.js`/`attemptReplay` (same
boundary on the replay path).

### A3. Apply window opens OVER the user's windows; tab never activates/groups → stays throttled, content never loads
**Observed:** it opens a **new window over the existing ones**, **doesn't switch tabs
or open the group**, so the apply tab never becomes active/visible — it "never
hibernates and loads the actual content" (Chrome occlusion-throttles it; the
Easy-Apply form never hydrates). The live transcript even showed *"apply tab is
hidden/occluded — Chrome throttled it; nudging its window to hydrate"* — the nudge
fired but the underlying placement/activation is still wrong.

**Regression note:** earlier in the session we'd reached a state Pierre LIKED — the
apply window opened *on the side, not over him*, and loaded fully. Recent changes
appear to have regressed window placement + tab activation.

**Fix direction:**
- Apply tab must be **`active:true` in its dedicated window**, and the window placed
  **on the side / not over the user's focused window** (restore the earlier behavior).
- Ensure the window isn't fully occluded (visible enough that Chrome won't throttle);
  make the hydrate-nudge reliably **activate the tab + raise the side window briefly,
  then restore the user's focus**.
- Re-open the tab-group / window so the tab is the visible active tab.

**Where:** `background.js` — `autoApplyTargetWindow()`, `createAaTab()`, the
`jat11.nudge-apply-window` handler / `nudgeApplyWindows()`, and the group logic.
Investigate what regressed vs the "opens on the side, loads fully" state.

---

## B. Apprenticeship Engine v2 — element-level interaction recorder ("learn exactly what I click")
**Pierre's ask:** the app + extension should **watch every button the user clicks and
every field they fill**, capture the **actual HTML + XPath/CSS selector** (the real
"code chunks") of each element, **memorize** it, and **learn to perfect the apply
procedure** — not only the Apply button, but **all fields and obstacles** along the way.

**Gap today:** the Observer captures *answers* (P1) and *navigation* (P2), and the
distiller builds recipes keyed by `label_pattern` + `field_type` — but it does **not**
yet record the **real element selector / HTML / inter-step timing**. `recipe_steps`
carry null `strategy`/`median_delay_ms`/`options` (the deferred piece flagged in P3/P5).
This is exactly that piece, expanded.

**Scope:**
- A **content-script interaction recorder** that, during a manual apply on **any site**,
  records each interacted element:
  - a robust **XPath + CSS selector** (+ a stable fallback signature),
  - a small **HTML snippet** of the element (and its labelling context),
  - **attributes** (id/class/aria/role/name/data-*),
  - the **action** (click / fill / select / upload / advance),
  - the **value entered** (NEVER credentials/payment — the P0 rail still applies),
  - the **surrounding question/label**,
  - **inter-step timing** → real `median_delay_ms` (feeds the human-pacing stealth that's
    currently a default).
- Post to `POST /observe/step`; persist (extend `recipe_steps` with `selector`,
  `xpath`, `html_snippet` columns, or a new `interaction_steps` table joined to recipes).
- The **distiller** enriches recipes with these real selectors; the **replayer** targets
  the exact element (selector first, the existing `label_pattern` token-match as
  fallback) — making replay far more robust and literally "perfecting the procedure" as
  the user demonstrates more.
- Captures **obstacles**: multi-step gates, custom widgets, modals, file uploads, the
  board→external handoff click.

**Why it matters:** this is what makes the engine genuinely *learn the human*, on the
Apply button and everything around it, and improve every time the user applies by hand.

## C. Learn from outside websites (beyond LinkedIn/Indeed)
The recorder (B) + distiller must operate on **direct company career sites** and
**external ATS** (Workday/Greenhouse/Lever/iCIMS/…), reached via board→ATS handoff or
opened directly. The plumbing exists (P2 handoff edges, P3 ATS/`direct` recipes,
`classifyAts`) — v2's element-level capture is what makes applying on a **real company's
own job board** actually learnable + replayable, not just LinkedIn/Indeed.

## D. New board support: Glassdoor
Add **Glassdoor** as a first-class source:
- **Discovery:** Glassdoor job-search scraping (mirror the LinkedIn/Indeed discover path).
- **Capture:** detect Glassdoor job/application pages.
- **Apply:** Glassdoor's apply flow + its frequent **external-ATS redirect** (so it
  flows into the same recipe/replay machinery).
- **Where:** `classifyAts` (+ glassdoor), `discover.js`, `detector.js`, a new
  `content/sites/glassdoor.js` adapter.

---

## Suggested order when we implement
1. **A2 + A3** (search-bar bug + window/throttle) — they block *every* live apply right now.
2. **A1** (Easy Apply limit detect + pivot) — so we don't waste the daily 50 and keep
   working external jobs after the cap.
3. **B** (element-level recorder) — the core v2 learning leap; also feeds real pacing
   that helps A3's stealth.
4. **C + D** (external-site learning hardening + Glassdoor) — broaden the surface.

Sources for the Easy Apply limit: [fastapply.co](https://blog.fastapply.co/linkedin-easy-apply-limit-how-to-apply-200-jobs-day-2026), [loopcv.pro](https://www.loopcv.pro/guides/linkedin-easy-apply-limit/), [LinkedIn post (R. Bicknell)](https://www.linkedin.com/posts/rachelbicknell_linkedins-easy-apply-now-has-a-limit-this-activity-7358190082186518528-Agt7).
