# JAT v11 — Reliable External (non-Easy-Apply) Pipeline: Recon + Design

Read-only recon 2026-08-22. Sources: repo `F:\GITHUB\Perosnal\extensions\job-application-tracker\v11` (11.121.0) + live laptop node `100.104.86.34:7744` (`/auto-apply/live`, `/auto-apply/history?limit=400` → 556 records 2026-08-16..08-21, `/queue?state=queued`, `/settings`). No writes, no claims, no dispatches.

**Headline:** the ~4% raw rate is a bookkeeping artifact — 204 of the 206 `flow_failed` are a one-time bulk retirement of a stale non-easy-apply backlog, not live failures. Real terminal success in the window is 23/308 ≈ 7.5% (supportedRate 5.6% of 231 "drivable"). The node has been **completely idle since 2026-08-21T21:28Z (>24h)** — today's applies are 0 because nothing is pulling work, not because flows fail. And the easy→external fallback **already exists in code** (three mechanisms); what's missing is (a) a *budget-exhaustion* trigger, (b) external supply (`atsBoardsEnabled` is OFF on the laptop), and (c) reliability of the external flows themselves.

---

## 1. Failure taxonomy — 556-record history pull (2026-08-16 → 08-21)

Rollup: **submitted 23** (LinkedIn 15, Indeed 8) · failed 101 · needs_you 26 · skipped 362 · pending/in-flight 44.
By source: linkedin 386, indeed 77, greenhouse 40, lever 27, ashby 26.

| Bucket (canonical reason) | Count | Per source | Nature |
|---|---|---|---|
| Bulk retirement: "retired: stale non-easy-apply scrape backlog was blocking discovery refill" | **204** | linkedin 204 | One-time cleanup on 08-21 (manual/session-driven — the string exists nowhere in the repo). Dominates `flow_failed=206` in the run summary. |
| Easy-apply-only policy skip ("external posting — no Easy Apply … skipped, easy-apply-only" + "apply is on the company site") | **82** | linkedin 75, indeed 4, greenhouse 3 | Policy, not failure — jobs Pierre *wants* applied to once the external pipeline is on. |
| In-flight (queued at pull time) | 44 | indeed 24, linkedin 20 | — |
| Dispatch stranded: "timed out / interrupted — will retry" | **38** | linkedin 17, greenhouse 12, ashby 7, lever 2 | Infra: `reconcileStaleRunning` reaps claims the applier browser/SW never ran (`app/src/db.js:3421-3463`). Symptom of the flaky CfT applier, not of any site flow. |
| External form never grounded: "no Easy Apply opener and no drivable form appeared (visible tab)" | **26** | linkedin 12, greenhouse 9, ashby 5 | The #1 *real* external flow bug (`extension/content/executor.js:3383-3404`). |
| Relevance filter (yrs experience, already applied, excluded keyword) | 23 | li 15, ashby 4, gh 3, lever 1 | Working as designed. |
| **Submitted** | **23** | linkedin 15, indeed 8 | 5 LinkedIn submits landed 08-21 13:09–21:23Z — the briefing's "LinkedIn=0" is stale or refers to a narrower stretch; the signed-out latch was not engaged at pull time. |
| CAPTCHA gate (retired by policy) | 23 | **lever 22**, linkedin 1 | **New finding: Lever now serves CAPTCHA** on `jobs.lever.co` apply forms (waabi, pointclickcare, magnetforensics — all 08-20). The playbook's "Lever = FULLY AUTO" verdict is out of date. |
| Host bot-wall, 24h not lifted (retired) | 22 | indeed 20, greenhouse 2 | Indeed Cloudflare wall; breaker worked as designed but supply died with it. |
| Needs answers ("needs N answer(s)") — **AI dead** | 17 tasks (~26 answers) | indeed 9, greenhouse 5, linkedin 3 | Direct casualty of claude-cli OAuth expiry + codex auth (the briefing's 194 ai_log failures). `run-ai-answers.ps1` second-pass also produces nothing while AI is down. |
| Flow stuck mid-form (smartapply "Continue never enabled", "stuck on a step") | 11 | indeed 11 | Likely the same AI outage: required screening fields unanswered → Continue stays disabled. |
| Opener did not transfer (repeated page-level action) | 10 | linkedin 9, ashby 1 | Old repeat-breaker class, now small. |
| Handoff did not attach (page did not change) | 8 | linkedin 7, indeed 1 | External handoff arming bug, small. |
| Submit unverified ("static-success-text-unchanged" / interrupted after submit) | 7 | **ashby 6**, lever 1 | Probably *real submissions* lost to verification — Ashby SPA success detection gap. |
| Account wall parked (Workday sign-in, site sign-in) | 6 | linkedin 6 | Correct per playbook (park, don't loop). |
| Greenhouse iframe nav refused ("form is embedded from job-boards.greenhouse.io") | 4 | greenhouse 4 | Fallback branch of the embedded-ATS navigation (`executor.js:3644-3654`). |
| Misc (country filter, executor busy, messaging errors) | 8 | mixed | Noise. |

**Run-summary reconciliation** (`/auto-apply/live` since 08-20 12:32Z): dispatched 311, verified_done 13, flow_failed 206 (≈204 = the bulk retirement), needs_you 12, skipped 37, in_flight 42, rawRate 4.18%, supportedRate 5.63% of drivable 231. **Queue now: 62 queued = 38 linkedin + 24 indeed, 0 ATS.** Pacing counters `doneDay=0, dispatchedDay=0` and `lastTaskActivity 2026-08-21T21:28Z` → the applier (CfT browser + extension pump) has been dead for over a day; `status:"pacing"` is the known "nothing is asking for work" catch-all.

## 2. Current external-apply architecture

### 2.1 Adapter inventory (`extension/content/sites/`, "adapter-lite" hint packs — registry `sites/index.js:22-27`)

| Adapter | File | Contract | Completeness (code + live evidence) |
|---|---|---|---|
| Lever | `sites/lever.js` | `account:'none'`, no gate; `formSelector`, `openApply()` (a.postings-btn → /apply), `isSubmitHint`, resume input, confirmSignals | Complete as built, **but reality changed: 22/27 lever tasks hit a CAPTCHA gate on 08-20** → per policy they were *retired*, not filled+parked. Needs the BambooHR treatment. |
| Greenhouse | `sites/greenhouse.js` (7.4KB) | drivable, label-based field mapping, hidden file input | Good; failure mode is *grounding* on modern lazy-mounting boards (9 "no drivable form") + 4 iframe-nav-refused + 12 stranded dispatches. |
| Ashby | `sites/ashby.js` (updated 07-26) | drivable, React SPA, `_systemfield_*` names | Good at filling; **weak at verifying** — 6 of 26 tasks ended "submit clicked, could not be verified". |
| BambooHR | `sites/bamboohr.js` | fill + `submitGate:'captcha'` → park `awaiting_review`; honeypot (`nickname_*`) skip | Complete per design (executor honors gate at `executor.js:2601-2609`, `3520-3528`). |
| Workday / iCIMS / Taleo | `sites/walls.js` (`account:'required'`) | park `awaiting_input` "account required" | Working — 4 Workday parks in window, no 40×-click loops. Legacy `sites/workday.js` superseded for host match (`index.js:16-22`). |
| LinkedIn / Indeed / Glassdoor | `linkedin.js` / `indeed.js` / `glassdoor.js` | context hints only | Native easy-apply lanes, not external. |

Executor integration (all in `extension/content/executor.js`): pack derivation :1350-1375 (`driveablePack` = `account:'none'` + `formSelector`; `walledPack` = `account:'required'`); walled park :1433-1446; external opener allowed only when `allowExternal` (`context.easyApplyOnly === false`) :1349, :2434-2444; host-change re-derivation after in-tab handoff :2461-2471; `openApply()` reveal :2648-2660; form scoping :2722; honeypot skip :2829, :2991; CAPTCHA fill-then-park :3520-3528; **embedded-ATS iframe → navigate to iframe src with nav-resume (11.113.0)** :3622-3660; LinkedIn external fast-skip (easy-apply-only) :3171-3217; Indeed external fast-skip :3566-3586. Route classification: `extension/content/route.js:31-92` (`indeed_native` counts as easy-apply; `external_new_tab`/`external_same_tab` → route `external`).

### 2.2 Discovery → apply routing

- **ATS JSON-board discovery** `app/src/discovery/ats-boards.js`: public no-key endpoints (Greenhouse/Lever/Ashby, :14-17), 147 seed tokens (`ats-seed-companies.json`) + DB-harvested tokens (`db.js:1414 jobUrlsForAtsHarvest`), 10 tokens/tick round-robin, ~15-min cadence (`main.js:826,935,994`). Feeds the same `ingestDiscoveredJobs` path. **Gate: `discovery.atsBoardsEnabled` (`ats-boards.js:456`) — default `true` (`config.js:284`) but the laptop has it `false`**, so the ATS lane is currently OFF (the 02:00 08-21 provider entries in live health — docebo/hootsuite/waveapps, accepted 0 — are its last runs). This is why the queue holds 0 ATS jobs.
- **Ingest allowlist** `server.js:348-363 easyApplyIngestEligible`: in easy-apply-only mode keeps linkedin, indeed, **greenhouse, lever, ashby** (ATS postings are "genuinely in-board drivable"), drops glassdoor/google/zip aggregator floods. So ATS jobs flow to the queue *even with `easyApplyOnly:true`* — supply, not policy, is what's missing.
- **Dispatch** `server.js` queueNext: dead-task retirement :670-697, Easy-Apply-cooldown pivot :698, signed-out hold :702, host-breaker skipHosts :713-726, **safety governor** :727-739, bounded scan + ranking :659-794.
- **Budget/role gating** `app/src/safety.js`: only platforms *configured* in `safety.platforms` are governed; `decideTouch(requireConfig:true)` → "unconfigured ⇒ ungoverned ⇒ allowed" (:119-123, :226-236). Live: linkedin primary 40 applies/24 searches per day, indeed primary 40/60, glassdoor/google/zip `role:none` (blocked). **Greenhouse/Lever/Ashby/company sites are deliberately ungoverned** — the safe lane that keeps running while LinkedIn is throttled.

### 2.3 The applier node — CORRECTED 2026-08-22 (live SSH recon)

The CfT supervisor lane is **retired and Disabled on purpose** (it segfaulted 0xC0000005 and relaunched ~60s × 182). On **2026-08-20** the node migrated to driving applies from the unpacked extension inside **Pierre's real, visible, default-profile Chrome** on the laptop, against the app on **7744**. Verified on the box tonight:

- Extension `ehpabielnbljajggjmggngeaemfjpfhn` is registered, enabled and healthy in `…\Google\Chrome\User Data\Default\Secure Preferences`: `location: 4` (unpacked/command-line), `disable_reasons: []`, `has_started_service_worker: true`, host permissions `http://127.0.0.1:7744/*` + `http://localhost:7744/*` **only**, `extensions.ui.developer_mode: true`, path `C:\ProgramData\JAT-Remote\chrome-extension-pierre` (v11.118.0 against app 11.121.0 — no incompatibility observed; a dispatch ran end-to-end tonight). **The persisted-extension-disable hypothesis in `docs/REAL-CHROME-MIGRATION.md` is NOT what is happening** — that doc's blocker applies to the CfT/`--load-extension` path, not to this hand-loaded one, which survives Chrome restarts by itself.
- Loading is by hand (`laptop-normal-browser.ps1`: "the extension folder Pierre will load by hand"), so the lane had **no keeper**: whenever Chrome exits, nothing restarts it. That is the whole outage (see §2.5).
- Port trap: `settings.server.port` still reads **7746** while the app actually listens on **7744** (JAT_PORT env from `C:\Users\laptop\laptop-app-keeper.ps1` wins). Anything that starts the app *without* the keeper — e.g. `run-supervisor-pierre.ps1`, which did exactly this at 22:20 tonight — brings it up on 7746, where the extension cannot reach it (7744-only host permissions). The retired CfT extension is still polling `localhost:7746/health` for the same reason.
- Deploy with `C:\Users\laptop\deploy-laptop-v2.ps1`; `deploy-laptop.ps1` is stale (it ends by running the retired supervisor task).

### 2.5 Why the node went silent 2026-08-21 21:28Z → 2026-08-22 (root cause, evidenced)

Two separate things, neither of them a bug in the apply engine:

1. **21:28Z stop = the safety budget was fully spent, exactly as designed.** `platform_touches` for 2026-08-21: `linkedin apply → 40` (budget 40) and `indeed apply → 40` (budget 40); last LinkedIn apply touch in hour 21. The extension stayed alive and kept running discovery searches afterwards (`linkedin search` touches at 23:11:42Z, 23:31:49Z, 23:51:57Z), so the 11.121.0 app auto-update at 21:45–21:48:59Z (schema v18) did not break it.
2. **The 25-hour blackout = the laptop was shut down and nobody restarted Chrome.** System log: `Kernel-General 13 "operating system is shutting down"` at **2026-08-21 23:59:46Z (19:59:46 local)**; `LastBootUpTime 2026-08-22 03:07:12 local`. After the reboot the App Keeper restored the app on 7744 and Dad's CfT supervisor auto-started, but **Pierre's real Chrome has no keeper** → `platform_touches` for 2026-08-22: **zero rows**. A whole day of applies lost to a missing launcher, not to any failure in the pipeline.

**Fixed 2026-08-22 23:00 local:** new scheduled task **`JAT Chrome Keeper (real profile)`** → `C:\Users\laptop\chrome-keeper.ps1` (interactive as `laptop`, LeastPrivilege, logon trigger + 5-min repetition, runs on battery). It starts the default-profile Chrome only when none is running, never kills or restarts one, and refuses to launch while 7744 is down. Verified: Chrome up at 22:59:46, extension talking to 7744 within seconds, `health.lastTaskActivity` moved to `2026-08-23T03:00:36Z` after 25 h frozen, one task dispatched, 4 new LinkedIn jobs enqueued (queue 62 → 65), `linkedin search` touch recorded; the 23:05 tick correctly no-opped ("ok: real-profile Chrome running (pid 7696)") with still exactly one browser process.

### 2.4 AI answering (currently dead)

Providers `app/src/ai/`: order claude → chatgpt → local (settings), both `useSubscription:true` — `claude.js` shells out to the official `claude` CLI (auth = CLI's own OAuth; expired → every call fails `CLAUDE_AUTH`), `codex.js` shells the Codex CLI (auth dead too), `anthropic.js`/`openai.js` need API keys (**`secretsPresent`: all false**), `ollama.js` disabled. Mid-apply answering (`decideAnswerOrPark`) parks jobs "needs N answer(s)" when AI can't answer; the 30-min second-pass task (`remote/cft-supervisor/run-ai-answers.ps1` → `ai-answer-parked.mjs`, min confidence 0.8) is also inert. Traced to the outage: 17 parked tasks (~26 answers) + most of the 11 Indeed "Continue never enabled" stalls; NOT traced to it: stranded dispatches (38), no-form groundings (26), CAPTCHAs, bot walls.

## 3. The easy→external fallback: does it exist?

**Three mechanisms exist; Pierre's exact trigger does not.**

| Mechanism | Where | Trigger | Effect |
|---|---|---|---|
| A1 dispatch pivot | `server.js:586-598,698` + `db.js:4338 easyApplyEligible` | LinkedIn's "reached today's Easy Apply limit" modal → executor reports `easyapply-limit` (`executor.js:2635-2646`, apostrophe-class regex :76-78) → `setEasyApplyCooldown()` (`server.js:1776-1780`, `db.js:3946-3983`) | LinkedIn jobs *held* (not burned) for 24h or until rolling-24h count drops (multi-node-corrected early reset, `db.js:4225-4246`); external/Indeed keep dispatching |
| Ingest relaxation | `server.js:375` | `easyApplyCooledDown() OR easyApplySupplyExhausted()` | `easyApplyOnly` treated as false at ingest → external/ATS postings enter the queue |
| Executor relaxation | `server.js:874` | same | dispatch context `easyApplyOnly:false` → executor *drives* external handoffs instead of fast-skipping ("both flags must agree or the two halves fight") |

`easyApplySupplyExhausted()` (`db.js:4309-4322`): last 25 terminal outcomes contain **0 applies** AND ≥10 "no easy apply" skips → relax; self-corrects the moment one easy-apply lands.

**Why this is not what Pierre asked for.** He wants "when easy applies run out *because there's a limit*, start doing normal jobs." The limit that actually binds day-to-day is the **safety governor budget** (40+40/day, spread across the day since 11.121.0) — and 2026-08-21 is the proof: `platform_touches` shows `linkedin apply 40/40` and `indeed apply 40/40` spent by 21:28Z, after which the node had nothing left to do but discovery searches, all night, with 62 jobs sitting queued. Exactly the moment an external lane should have taken over — and *nothing* relaxes `easyApplyOnly` when budgets are exhausted: LinkedIn/Indeed jobs are passed over (`safety-budget`), the supply heuristic stays false (applies landed recently, `applied>0`), and external handoffs keep fast-skipping. Meanwhile the only ungoverned lane (ATS) has zero supply because `atsBoardsEnabled` is off. Evidence: 82 easy-apply-only policy skips in six days while the supply/cooldown relaxations mostly never tripped.

**Minimal design (Chunk 3 below):**
1. `db.easyApplyBudgetExhausted()` — true when every `role:'primary'` platform's `applies.used >= budget` for today (read `platformTouchCounts`), OR quiet-hours+budget leave <1 slot. Pure read, ~15 lines next to `easyApplySupplyExhausted`.
2. OR it into both relaxation sites (`server.js:375` and `:874`) — the two halves stay in agreement by construction.
3. On the same condition, let the ATS discovery lane run hot: pass a hint into `atsBoardsService.runTick()` scheduling (or simply flip `atsBoardsEnabled` back on and rely on its own 15-min cadence + refill gate) so the queue actually holds external work when the switch flips.
4. Safety interaction: nothing to change — ATS applies are ungoverned by design (`safety.js:113-123`); optionally add `greenhouse/lever/ashby` platform configs with generous budgets later if Pierre wants a ceiling.
5. Config: laptop settings flip `discovery.atsBoardsEnabled → true` (repo default already true).

## 4. Reliability plan — top 5 chunks, ranked by expected applies/day

| # | Chunk | Est. gain | Size |
|---|---|---|---|
| 1 | **~~Revive~~ DONE 2026-08-22 + harden the applier node.** Root-caused (§2.5) and fixed: `JAT Chrome Keeper (real profile)` now keeps Pierre's real Chrome — the applier since the 08-20 migration — running across exits and reboots. Remaining hardening: align `settings.server.port` 7746 → 7744 so an app started without the keeper can still be reached; add an app-side "no extension contact for >30 min while outside quiet hours" alarm (tonight's outage was invisible for 25 h because `status:'pacing'` covers it). | **+13–20/day** (restores the entire recent baseline; ceiling 80/day governed + ATS ungoverned) | S — done / remainder S |
| 2 | **Restore AI answering.** Pierre: `claude /login` on the laptop (codex optional). Session: verify with one `ai-answer-parked.mjs --min 0.8` pass over the 17 parked tasks, add an `aiUsage` health probe to `/auto-apply/live` so a dead provider is visible instead of silent. Fallback if OAuth keeps rotting: enable `ollama` on the laptop or an API key in secretstore. Test: parked count drains; Indeed smartapply "Continue never enabled" rate drops. | **+5–10/day** (17 parked + most of 11 Indeed stalls + future mid-flow answers) | S code + Pierre login |
| 3 | **Budget-exhaustion → external switch** (the ask; design in §3). Files: `app/src/db.js` (new fn + export), `app/src/server.js:375,874`, laptop settings `atsBoardsEnabled:true`. Test: unit-drive `easyApplyBudgetExhausted` with synthetic touch counts; integration: set budgets to 1, submit once, assert next ingest keeps externals and dispatch context says `easyApplyOnly:false`; live: watch ATS jobs enqueue + dispatch after the daily 80 is spent. | **+10–20/day** (opens the ungoverned ATS lane exactly when the governed lanes stop; 147 seed tokens + harvest keep it fed) | M |
| 4 | **External grounding fixes** — kill the 26 "no drivable form" + 4 iframe-refused: wait-for-hydration before the terminal no-form verdict on ATS hosts (mirror of the LinkedIn `jobPageHydrated()` guard at `executor.js:3383`), per-pack `formReady()` hints for modern Greenhouse lazy mounts + Ashby SPA, and extend `findEmbeddedAtsFrame` nav to the refused-sandbox cases (open as a new top-level task instead of `location.assign`). Test: harness replays against live job-boards.greenhouse.io / jobs.ashbyhq.com pages; assert grounding rate. | **+4–8/day** (26 fails/6d were pure loss; also a precondition for #3's volume) | M/L |
| 5 | **Lever CAPTCHA policy + Ashby submit verification.** Lever: flip to the BambooHR contract (`submitGate:'captcha'` — fill everything, park `awaiting_review` "solve CAPTCHA + submit", one tap for Pierre) instead of retiring 22 jobs/day; keep the retire path only for *unattended* runs older than 48h. Ashby: add real confirm signals (success toast/route change/network 200 on submit) to stop losing ~6 real submits to "could not be verified". Test: harness against a CAPTCHA'd lever tenant + an Ashby posting; verify park/verify states. | **+3–6/day** counted or one-tap-parked | S/M |

Also on the radar (not top-5): Indeed host-wall supply loss (20 retired — breaker is correct, but pair it with #3 so the queue refills from ATS when Indeed is walled); the real-Chrome migration (Preferences diff → `ExtensionInstallForcelist`, `docs/REAL-CHROME-MIGRATION.md:48-58`) as the durable fix for both sign-outs and stranded dispatches; `docs/AUTO-APPLY-EXTERNAL-RELIABILITY-PLAN.md` remains the maximal blueprint (Playwright desktop worker, evidence quorum, checkpoint UX) if Pierre wants the big rebuild instead of these increments.

## 5. Needs Pierre personally vs. what sessions can ship

**Pierre only:** LinkedIn sign-in in the applier's CfT profile (`login-pierre.ps1`; transplants die in ~10min — must be a real login); `claude /login` on the laptop (subscription OAuth); Codex/ChatGPT re-auth (optional); solving parked CAPTCHAs + one-tap confirming `awaiting_review` submits (the needs-you queue, 26 now); any decision to add API keys/Ollama as AI fallback; Workday/iCIMS/Taleo account creation if he ever wants those lanes.

**Sessions can ship without him:** chunks 1, 3, 4, 5 end-to-end (code + deploy via deploy-laptop-v2.ps1 + `schtasks` restart + watchdog); chunk 2's code and verification (blocked only on his login for the live pass); flipping `atsBoardsEnabled` on the laptop; extension-version parity checks; harness runs against live ATS pages.

---

## Addendum 2026-08-23 — parked "questions" that are not questions

Live pull of `GET /queue/parked` on the laptop node: **12 of 22 parked entries are
extraction artifacts**, blocking 7 jobs that have no real unanswered question of
their own:

| Scraped "question" | What it actually is |
|---|---|
| `terraform question_31344737003[]`, `cloudformation …[]`, `pulumi …[]`, `none …[]` | the four OPTIONS of one multi-select, each emitted as its own question, with the field's `name` attribute appended |
| `0-4 question_8786663005[]`, `0-4 / 10+ question_8901966005[]` | same, for a range picker |
| `.remix-css-1a0ro4n-requiredinput{opacity:0;pointer-events:none;position:absolute…}` | a CSS rule text node |
| `5 results available.Use Up and Down to choose options…` | combobox screen-reader help |
| `ResumeUploading...fileuploaded.jpgUpload failed. Max size for files is 10 MB.` | an upload error message |
| `Review`, `required` | a section heading and a field marker |

**Where the fix does NOT belong.** `db.js` already has `UI_NOISE_Q_RX`
(`results? available|use up and down|press enter…`) used in two places, and
widening it to cover the rows above is the obvious move. It is the wrong one:

- `queueRetryParked` uses it to decide a task is fully answered and flips it back
  to `queued`. For the `question_…[]` rows the underlying question is **real** (an
  "which of these have you used?" multi-select) and profile memory cannot answer
  it, so the task would be dispatched, fail to fill, and park again — three times
  each before `MAX_PARK_RESCUES` bites. Seven tasks × 3 = ~21 apply-budget slots
  spent to submit nothing. That is precisely the hot loop the comment at
  `queueRetryParked` was written about after it cost a full Indeed budget on
  2026-08-11.
- `retireUnanswerableParks` uses it to RETIRE terminally, which throws away
  applications that may be perfectly fillable.

**Where it belongs:** the extension's question extraction, which already stopped
one class of this at source in v11.90.12. Two rules cover everything above —
never emit an `<option>`/checkbox label as a standalone question (emit the
group's own label once, with the options as choices), and never emit a text node
that is not inside a label/legend/aria-labelledby target. That removes the junk
before it can park anything, with no budget spent.

**Size:** S, extension-side, needs a deploy + extension reload on the laptop.
Do it in the same deploy as the easy→external switch rather than on its own.
