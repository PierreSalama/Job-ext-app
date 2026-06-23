# JAT v11 — Auto-Apply Improvement Plan

_Living doc. Last updated 2026-06-23 (v11.37.0)._

This captures what we learned from the live runs, what's been fixed, and the ordered plan to
keep improving auto-apply. It's the companion to the email-driven pipeline work (below) and the
[[external-ats-handoff]] concept.

---

## 1. What works today
- **LinkedIn Easy Apply: solid.** Verified submits with real success-truth evidence, no false
  positives. This is the bulk of current throughput (~2/min observed when supply exists).
- **External (company-site) apply:** the machinery now exists end-to-end —
  - same-tab handoff (v11.33.0: breaker-clear + `waitForExternalTarget` host/path detection),
  - **popup-blocked `window.open` recovery (v11.36.0)** — the dominant Indeed failure: a MAIN-world
    hook captures the URL the page passed to a blocked `window.open` and the SW opens it directly.
  - recognised ATS adapters (Lever/Greenhouse/Ashby submit; BambooHR park; Workday/iCIMS/Taleo park).

## 2. Post-mortem: the computer-freeze (FIXED v11.37.0)
**Symptom:** the machine froze / slowed badly during auto-apply.
**Root cause (from live data — 791 discovery batches in 25 min, ~32 board-scrapes/min):** the
app's discovery `runTick()` had **no time gate**. The idle-watchdog (`main.js`) re-pokes `runTick`
every few seconds whenever the queue is drained — and because external applies were failing fast,
the queue stayed drained — so discovery ran essentially **back-to-back**, each tick spawning up to
3 JobSpy subprocesses (PyInstaller exe) in parallel. That pinned the CPU.
**Fix:** `runTick` now **self-throttles to the configured interval** (floor 60s) regardless of how
often it's poked; a manual/forced run bypasses. Plus live settings: dropped the 3 empty boards and
disabled focus-steal. Locked by a regression test (`discovery-provider.test.mjs`).

## 3. Parallelism: why "3 workers" shows as 1
Concurrency 3 is set, but the queue is tiny and **LinkedIn-dominated**. The dispatcher
(`queueNext`) deliberately **spreads workers across distinct sites** (one apply per site at a
time) to avoid same-session conflict — so when nearly every queued job is `linkedin`, only **one**
worker can run. This is correct behaviour, not a bug.
**To actually use 3 workers we need _diverse supply_** (jobs on ≥3 different ATS hosts queued at
once) — which depends on §4. Window **tiling** (v11.35.0) keeps the 3 windows from occluding each
other; on a single monitor they tile across the screen (visible = un-throttled, the tradeoff).

## 4. Supply is the real ceiling
Live discovery by board:
| Board | Result |
|---|---|
| LinkedIn | ✅ yields (but ~20s/scrape) |
| Indeed | ✅ yields (15/batch) |
| Glassdoor | ❌ empty — bot-walls/403 |
| Google Jobs | ❌ empty — JobSpy scraper unreliable |
| ZipRecruiter | ❌ empty — blocks datacenter IPs |

**LinkedIn + Indeed are the only real supply.** Throughput is supply-bound, not pacing-bound.
Levers: (a) residential proxies to revive Glassdoor/Zip; (b) widen LinkedIn/Indeed keyword×location
rotation; (c) **external apply reliability** (every Indeed external that now lands is net-new volume).

## 5. Ordered roadmap
1. **Verify the popup-handoff fix live** (v11.36.0) — confirm Indeed externals reach `done`/
   `awaiting_review` instead of "handoff did not attach". _(Next live run.)_
2. **Email-driven pipeline** (in progress, see §6) — turn replies into pipeline status so the tool
   tracks the whole funnel, not just the submit.
3. **More ATS adapters / unrecognised-ATS hardening** — account-wall detection, generic form-root,
   honeypot skip (spec'd in the external-apply plan).
4. **Supply diversification** — proxy support for Glassdoor/Zip, or drop them; richer query rotation.
5. **Parallelism payoff** — once supply is diverse, the 3 tiled workers engage; revisit caps.
6. **Vision rescue (deferred)** — only if live data shows a residual class of visual-only failures.

## 6. Email-driven pipeline (new build)
Goal: read all of the user's Gmail and attach every message to the right job — even a company
reply with no obvious job — and advance the pipeline stage (acknowledged → assessment → screen →
interview → offer → rejected). Deterministic-first matching ladder (threading / Message-ID,
sender-domain→company, subject/body, recency-uniqueness) with **ChatGPT only to disambiguate**.
See the email-matching commits + tests. Connecting Gmail uses the app's secure OAuth flow (the
user enters/authorises credentials himself — JAT never has Claude move raw tokens).
