# Critical review of Codex's Auto-Apply Reliability plan

> Independent grounded critique (vs the real code + live logs) of `AUTO-APPLY-EXTERNAL-RELIABILITY-PLAN.md`. Generated 2026-06-19.

# Verdict

Codex's diagnosis is sharp and largely correct — it correctly identifies that the current generic, text-label-driven model is producing *false* successes (verified in code: `success.js` `pageTextLooksLikeSuccess()` regex-matches pre-existing `document.body.textContent` with no baseline and no submit correlation, which is exactly how Activision and Canada Job Bank passed), and Phase 0 (grounded surface + baseline-before-submit + evidence quorum) is the right, necessary fix that will plausibly drive false-done to ~0. **But the plan will only reach 60-70% against a denominator it deliberately shrinks (eligible + reachable + supported attempts), not against "most jobs I attempt," and the headline architectural move — replacing a real-user MV3 extension with a desktop-owned Playwright profile — *raises* LinkedIn account-ban risk while the plan never once addresses bot-fingerprinting.** The catch: this is a near-total greenfield rewrite (none of `app/src/automation/state-machine.js`, `classifier.js`, `routes.js`, `policy.js`, `evidence.js`, or `adapters/` exist yet — confirmed empty), and the current live regression to 3% is not the new architecture failing; it's that the working path was disturbed before the replacement was built.

## What Codex got RIGHT

Credit where due — the diagnosis is the strongest part of this document:

- **Cloudflare-misread-as-occlusion is a real, specific, verifiable bug.** The 22 June-19 failures labeled "window occluded / LinkedIn throttled" were Indeed Cloudflare verification pages (Ray ID). Treating this as a per-host circuit breaker (§7.2: stop dispatching Indeed after first challenge, canary-validate recovery, exponential cooldown) is exactly right and directly fixes the single biggest failure cluster.
- **The false-positive submit crisis is correctly named as the Phase-0 blocker.** Making success *impossible* without post-submit evidence tied to a grounded surface (baseline-before-submit in §8.2 so pre-existing success text can't count after a click) is the correct ordering. You cannot chase throughput while "done" is a lie. The code confirms the failure mode precisely.
- **Application-surface grounding (§5.3)** as a non-negotiable precondition — container must be visible, belong to the current job, contain candidate/application semantics (not newsletter/contact/search/report), and have identity matching the source — is the correct structural fix for "misclassified a static page as an application form."
- **Typed state machine + typed actions (OPEN_APPLICATION, SUBMIT_APPLICATION…) instead of text labels** is the right abstraction. The resume-choice interstitial as its own modal state (fixing repeated opener clicks) and the durable route chain (preventing child navigation from overwriting canonical job identity) are both well-targeted.
- **Evidence quorum with verified/probable/uncertain/rejected verdicts** (only "verified" → done) and **honest denominators (§4.3)** that mandate publishing raw dispatch success alongside filtered metrics — this is intellectually honest and prevents metric-gaming. The Playwright/tracing/typed-recipe ideas are all real engineering wins.

## What's WRONG or RISKY

- **The live 3% is a self-inflicted regression, not validation of the rewrite.** The new architecture doesn't exist on disk yet (`app/src/automation/` contains only `config.js`, `db.js`, `discovery/`, `distiller.js` — none of the proposed engine files). So whatever drove the June-19 run to 2/78 is the *current* extension path being degraded or mis-instrumented, not the Playwright engine underperforming. Diagnosing 3% as "proof we need the rewrite" conflates two things: the false-success bug (real, fixable in place) and a throughput collapse whose root cause must be isolated before committing to a multi-month rebuild.
- **Bot-detection / account-ban risk on LinkedIn gets WORSE, and the plan is silent on it.** The current executor runs *inside Pierre's real, already-trusted Chrome profile* and carries LinkedIn-specific safety (confirmed: `EASYAPPLY_LIMIT_RX` honors the ~50/24h cap, `CAPTCHA_RX` pauses rather than pushing). The proposed Playwright worker spins up a *fresh* `%APPDATA%/jat11-app/automation-profile` with no device-trust history, then Phase 4 drives it to ≥80% autonomous Easy-Apply submits up against that hard cap. A never-before-seen device producing near-cap automated volume on day one is the textbook LinkedIn flag. The 1300-line doc never mentions `navigator.webdriver`, the CDP `Runtime.enable` console leak, `AutomationControlled`, or bundled-Chromium-vs-`channel:'chrome'`-vs-`connectOverCDP`. It conflates session persistence ("cookies survive restarts") with *device trust*. Its only ban mitigations address rate, not fingerprint — which is the dominant ban vector for LinkedIn. This risks Pierre's primary professional identity.
- **The 70% denominator is narrowed by construction.** "Eligible + reachable + supported" excludes exactly the cases that dominated June-19 (Cloudflare, login, visible CAPTCHA, broken links). Nothing in the architecture *removes* those gates — it converts them from false failures into honest assisted/excluded attempts. That is correct engineering but it is denominator management, not throughput. The headline 70% can be hit while raw verified rate on "every job I try" sits at ~15-30%. The plan never estimates the external-ATS reachability rate that actually bounds Pierre's real goal.
- **Rewrite/scope risk is severe.** Eleven phases, ten data tables, an adapter registry across ~15 ATSes, a constrained-AI-fallback layer, a teaching/healing system. This is a 6-12 month program presented as one plan. The risk isn't that any phase is wrong; it's that Phases 0-1 (the high-value, in-place fixes) get held hostage to a Playwright migration that may not be needed for LinkedIn at all.
- **Abandoning the working Easy-Apply path is the biggest unforced error.** The extension already has battle-tested LinkedIn handling. The plan treats "move everything to Playwright" as monolithic and would re-derive guardrails that already work, on a riskier substrate.

## Will it reach 60-70% trustworthy submits?

Honest, conditional, per-lens:

- **Trustworthiness (false-done → 0): YES, achievable.** Phase 0 is sound and the code confirms the bug it fixes. This half of the goal is realistic and is the plan's genuine win.
- **Throughput to 70% of the SLO denominator (eligible/reachable/supported): PARTIALLY / conditionally.** Plausible *on mature adapters* (LinkedIn, Lever, Ashby, Greenhouse) once built — but only because the denominator excludes the hard cases. Achievable on paper, less meaningful in practice.
- **Throughput to 70% of what Pierre actually cares about ("most jobs I attempt"): NO.** Cloudflare/CAPTCHA/login gates are routed to humans, not solved. Real ceiling is bounded by external-ATS reachability, which June data suggests is low (~15-30% raw is the realistic band).
- **Bot-safety lens: PARTIALLY, and net-negative for LinkedIn unless split out.** Safer for Indeed/ATS (better challenge classification); riskier for LinkedIn (fresh automation fingerprint). As written, the plan trades a perfectly-camouflaged real-user session for an automation-flagged low-trust profile and pushes it to high volume — the precise ban pattern.

## How I'd improve it — concrete, phased, testable path

**Do FIRST (this week, in the existing extension — no rewrite):**

1. **Ship success-truth + evidence in place.** Add a pre-submit baseline snapshot in `executor.js`/`success.js`: capture `document.body.textContent` hash + URL + form signature *before* the submit click; only count NEW post-click confirmation containers or a correlated application POST/XHR. *Testable:* replay Activision + Canada Job Bank fixtures → both must reject; zero false-done across a 30-fixture regression set.
2. **Add honest metrics now.** Emit raw dispatch success (verified / every dispatched) alongside any filtered number. *Testable:* dashboard shows both; current-run counts exclude historical "done" records lacking structured evidence.
3. **Quarantine the historical false positives** (Activision, Canada Job Bank) and audit existing "done" rows with no evidence. *Testable:* migration flags every evidence-less done.

**Roll back the live regression NOW:** revert to v11.19.2 (last known-good) so the live system isn't sitting at 3% while the rewrite is debated. The rewrite is a months-long effort; do not leave production broken in the interim. *Testable:* v11.19.2 reproduces its prior verified rate on a canary set before any further change.

**Then, isolated spikes (prove before committing):**

4. **Indeed/Cloudflare fix can ship without Playwright.** Implement the §7.2 circuit breaker in the current dispatcher: stop dispatching Indeed after first challenge, surface one live page, cool down. *Testable:* a run with ≥1 Cloudflare hit produces zero "occluded" mislabels and zero further Indeed dispatches.
5. **Prototype Playwright bot-safety BEFORE any migration commit.** A throwaway spike: launch `channel:'chrome'` (real binary, not bundled Chromium), strip `navigator.webdriver`/`AutomationControlled`, and check what LinkedIn/Cloudflare return on a *throwaway* account — never Pierre's real one. *Testable, go/no-go gate:* if a fresh automation profile triggers "unusual activity" within N low-volume Easy-Applies, Playwright is **disqualified for LinkedIn** and LinkedIn stays in-extension (or `connectOverCDP` attached to Pierre's real running Chrome).
6. **Split the LinkedIn decision from Indeed/ATS.** Adopt Playwright only where it's clearly safer (Cloudflare-gated Indeed, external ATS). Keep LinkedIn Easy-Apply on the in-profile path, port the existing `EASYAPPLY_LIMIT_RX`/`CAPTCHA_RX` guardrails forward, add an absolute low per-day LinkedIn cap (well under 50) that ramps only with clean history, and gate autonomous LinkedIn submit behind an explicit ToS/risk opt-in (default to review-mode where the human clicks final submit).

**Minimum-viable slices (only after spikes pass):** Phase 0 evidence (done above) → observability/taxonomy → *one* adapter end-to-end (LinkedIn in-profile, or Lever via public API as the cleanest external test) → measure real reachability before building the long tail. Don't build 15 adapters on faith.

## Bottom line + recommended immediate next step

The plan's *diagnosis* is excellent and its Phase-0 success-truth work is correct and necessary — adopt that immediately, in place. But the plan's *headline solution* (monolithic Playwright migration) is the riskiest part for the highest-value asset (Pierre's LinkedIn account), is unjustified for the working Easy-Apply path, and bundles a multi-month rewrite with fixes that don't need it. It will reach 70% *of a deliberately narrowed denominator*, not 70% of the jobs Pierre actually attempts — and the honest raw number is likely 15-30%.

**Immediate next step:** roll the live system back to v11.19.2 to stop the 3% bleed, then land the in-place success-truth/evidence fix (item 1) plus honest dual metrics (item 2) this week — these recover trustworthiness with zero rewrite risk. Run the Playwright-on-throwaway-LinkedIn bot-safety spike (item 5) as a hard go/no-go gate *before* committing a single line of the `app/src/automation/` rebuild.
