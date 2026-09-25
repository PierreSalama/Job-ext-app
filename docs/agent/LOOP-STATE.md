# AI Apply loop state

Pierre is away from **Saturday 2026-09-05 midday** until **Sunday evening**. Three Claude sessions
are working in parallel; this file is the one for JAT AI Apply.

**Why this file exists.** The loop lives only as long as the session. Close the window and it is
gone, whatever the wake mechanism. This is here so a fresh session can pick the work up without
re-deriving thirty hours of context. Read it first, update it as you go.

---

## JAT HAS NOT SEEN AN EMAIL IN FOUR WEEKS

Measured 2026-09-05. This is the feature he asked for in his own words — "link up with gmail with
my email to connect the emails to jobs and report if any interviews came in or not" — and it is
dark on both machines:

| | |
|---|---|
| Laptop (`100.104.86.34`, the machine that applies) | `configured: false, authorized: false`. Last attempt **2026-08-01**: *"Not authorized — reconnect Gmail in Settings."* |
| PC | app not running at all; newest email in its ledger is **2026-08-08** |

**What that costs him, concretely.** 90 applications sit in `awaiting_review` — submit was clicked,
outcome never confirmed. Cross-referencing them against the inbox resolves exactly **1**, because
no email has been ingested since before most of them were made. Any interview invitation,
rejection or recruiter reply in the last four weeks is invisible to JAT.

**The matching itself is fine** — 1,190 of 1,427 stored emails are matched to a job (83%,
981 automatically). Nothing needs rebuilding. The sync is simply not authorised.

This is already on his list as "JAT Gmail reconnect" and "new Google OAuth client"; the point of
this entry is that it is not housekeeping. It is the difference between knowing and not knowing
whether an interview came in.

### The strongest proof of submission is implemented, tested, and never used

`evaluateSubmitEvidence` in `extension/content/signals/success.js` opens with:

```
// A correlated application network POST/XHR observed around the submit is
// independent proof the form actually transmitted (best-effort; optional).
if (networkPost === true) return { verified: true, reason: 'network-post' };
```

**Nothing ever passes `networkPost`.** The one real call site, `executor.js` ~4376, supplies
`before, after, formGrounded, msElapsed, urlBefore, urlAfter, newNodes` and nothing else, so the
parameter always defaults to `false` and that branch has never executed.

Measured on the live ledger of 1,357 tasks:

| evidence reason | rows |
|---|---|
| `text-became-success` | 488 |
| `new-confirmation-node` | 1 |
| **`network-post`** | **0** |

Zero in `submission_evidence` and zero in every transcript.

**And it is tested.** `tests/submit-truth.test.mjs:219` passes `networkPost: true` and asserts the
verdict. That test is behavioural, correct, and green — it proves the DECISION works while nothing
in the system ever reaches it. Nothing asserts the wiring, so nothing noticed.

This is the same family as the source-grep tests, arriving from the other side: there, a test that
could not see the code; here, a test that sees the code perfectly but not whether anyone calls it.
**Ask "what calls this?" as well as "does this work?"**

Two consequences worth his attention:

- It explains the 43 `static-success-text-unchanged` and 21 `no-post-click-change` rows below. A
  real submit almost always makes a request; observing it would settle most of them. A content
  script cannot see network traffic in MV3 — this needs the service worker (`chrome.webRequest`),
  so it is EXTENSION-side and behind the CWS Privacy-practices gate regardless.
- Verification leans on two signals, not one. Corrected 2026-09-05 after counting the whole table
  rather than a slice: of 668 `done` tasks, `text-became-success` 488, **`url-confirmation` 151**,
  `apply-form-closed` 20, `post-nav-confirmation` 6, `confirmed` 2, `new-confirmation-node` 1. An
  earlier note here said "488 of 489", which overstated the concentration. `new-confirmation-node`
  really has fired once, ever.

- **The trustworthiness rule holds in production.** Every one of those 668 rows carries evidence;
  not a single task is marked `done` without it. That is the rule Pierre cares most about and it is
  being honoured on every row.

**Swept for the same shape.** A scanner over `app/src` and `extension` for optional destructured
parameters that no other file ever supplies found exactly two: `networkPost` above, and
`allowAccountWalls` (`guardrails.js:66`). The second is benign and the distinction is the useful
part — an unwired parameter that REMOVES a capability (proof of submission) is a bug; one that
merely keeps a restriction permanently on (never write tailored documents for an account-walled
site) is just unused configuration. Scanner at `scratchpad/unwired.mjs`.

Its first version searched for `name + ':'` and so missed shorthand `{ formGrounded }`, reporting
four false positives. Comparing on the bare identifier fixed it.

**I mis-described this rule once before correcting it.** I said the success check "tests presence
rather than a before/after change". It does not: `textBecameSuccess = !before.successText &&
after.successText === true` is a diff, and `static-success-text-unchanged` is its deliberate refusal
for the Activision case where the page looked like success both before and after. The design is
right; the missing piece is the network signal.

### Why 90 applications are unverified — measured, three buckets

All 90 `awaiting_review` rows carry NO `submission_evidence`. **79 of them do carry the grounded
`isFinalSubmit(...)=true` marker in their transcript**, so the final submit really was clicked.

`creditRaceLostBacklog` exists to stamp exactly these as `probable`, and it IS wired. It credits
**1 of the 79**, because its filter is `last_error LIKE '%AFTER the final submit was clicked%'` —
wording only `reconcileStaleRunning` produces. The other 78 were written by the executor's own R1
verification and read differently:

| count | last_error | what it means |
|---|---|---|
| 43 | `static-success-text-unchanged` | success text was on the page BEFORE and after, so the check could not tell |
| 23 | `no-grounded-form` | no verified apply surface to check against |
| 21 | `no-post-click-change` | nothing on the page changed after the click |

**Do NOT widen the credit filter to cover them.** Those three are genuinely weaker evidence than a
race-loss — "nothing changed after the click" may well mean the submit did not take. Stamping them
`probable` would inflate the ledger, which is the one thing the trustworthiness rule forbids.

The useful work is the other direction: `static-success-text-unchanged` at 43 is the single biggest
verification gap in the pipeline, and it is a solvable one — the check needs a before/after snapshot
rather than a presence test. That is a real improvement to propose, not to land unattended.

### The safety governor is live and nowhere near its limit

Checked because his LinkedIn account was warned for automated access on 2026-08-10, after 281
scrapes a day passed unnoticed. `GET /auto-apply/search-permit?source=linkedin` on the laptop:

```
{"ok":true,"allowed":true,"used":5,"budget":20}
```

`recordPlatformTouch` is wired in three places — discovery search, apply dispatch, and the gated
search permit — and the counts prove it is recording.

`platform_touches` is EMPTY on the PC, which looked alarming for a moment. It is not: that app is
not running and is not scraping, and the table carries a 7-day retention sweep. The machine that
actually touches LinkedIn is the laptop, and its governor is working.

### The other recovery functions, checked against live rows

Ran each recovery's own WHERE clause read-only against the ledger, to see whether any is missing its
population the way `creditRaceLostBacklog` and `neverStarted` are. Most are simply idle, which is
the correct answer:

| recovery | rows it would act on today |
|---|---|
| `quarantineUntrustworthyDone` | 0 |
| `reclaimDeadParks` | 0 |
| `recoverRaceLostSubmissions` | 0 |
| `reconcileFalseSubmits` | 12 on the PC, **3 on the laptop** |

The false-submits are jobs marked `submitted` whose auto-apply task never reached done or
awaiting_review — the "I never applied to that" shape. It matters because `submitted` is in the
ENGAGED set, so `duplicateOf` refuses to apply to that employer again: on the laptop, GitLab,
Viv Technologies and Borrowell are currently blocked on a submission that did not happen.

**It self-heals.** `reconcileFalseSubmits` runs at app start (`main.js` ~975). The PC's count is
higher only because its app is not running. Nothing to do beyond opening the app.

**I nearly reported this as much worse.** The first count was 188 skipped tasks with an empty
transcript, which looked like 90% of all skips being never-attempted. It is not: a fast-skip
(external posting, level cap, already applied) legitimately decides before the executor writes
anything. Splitting by `last_error` put the genuinely-never-attempted figure back at 59. An empty
transcript alone proves nothing.

### Four static sweeps: three worked, one did not. The failure is the useful part.

| sweep | candidates | real |
|---|---|---|
| tests that reimplement production logic | 21 | 1 fixable, 2 structurally blocked |
| regex stems dead in front of a word boundary | 11 | 3 (two were safety rails) |
| optional parameters no caller supplies | 2 | 1 (`networkPost`) |
| **exported functions nothing references** | **211 → 73** | **0** |

The last one does not work and should not be repeated. Excluding tests, 211 of 735 exports looked
unreferenced; 7 of 8 sampled were used by tests, which is what an export is FOR. Counting tests as
usage left 73, and the two that looked meaningful — `inQuietWindow` in the safety governor and
`fitsPierre` in the watchlist — are both used inside their own file. Nothing real.

**Why it failed, which matters more than that it did.** The three genuine "capability nothing
reaches" findings were not uncalled exports at all:

- `networkPost` — a parameter no caller passes, so a branch never executes
- `GET /qa/audit` — fully wired, well built, and simply never run
- `creditRaceLostBacklog` — wired and running, but its filter matches 1 of the 79 rows it was for

Each is "the code runs, but the situation that would use it never arises, or the data never
matches". None is visible to static analysis. All three were found by comparing LIVE DATA against
what the code says it does. Read the ledger, not the exports.

### A known fail-open I did NOT close, and why

`guardrails.js` reads a field's label to decide three things. `labelFor` now returns **null** when
the page could not be asked at all, and the salary check treats that as "refuse if the value looks
like money below the floor" (fixed 2026-09-05). The **self-identification** check one block above
still reads `if (label && SELF_ID_RX.test(label))`, so an unreadable label means a voluntary
demographic question can be clicked or filled.

`SELF_ID_RX` appears in exactly one place. Unlike the password rail — which has an intrinsic guard
inside the `fill` tool that refuses an unidentifiable ref — **there is no second layer here.**

**Why I left it.** The salary fix worked because the VALUE carries an independent signal: a 4-7
digit number between 20,000 and 1,000,000 is money whatever the label says. Self-ID has no such
signal — "Yes" tells you nothing about whether the question was about ethnicity. The only options
are to leave it, or to refuse every click and fill on any ref whose label cannot be read, which
would block ordinary work on every CDP hiccup. That trade-off is his to make, not mine to make
unattended.

If he wants it closed, the shape is: refuse on an unreadable label for `fill` (typing into a field
nobody could identify) while still allowing `click`. That is narrower than refusing both.

## READ THIS BEFORE RE-ENABLING AUTO-APPLY

**Do not turn auto-apply back on until these fixes are released.** Two rails that keep
work-authorisation questions away from the agent were broken and were fixed here on 2026-09-05:

- `HIGH_STAKES_RECALL` (db.js) — decides what the autofill bundle WITHHOLDS. Broken, a scraped
  "Yes" to "Do you have work authorization in the US?" would have been shipped to a real form.
- `FACT_RX` (escalate.js) — decides what the agent ESCALATES instead of answering. Broken,
  "Are you authorized to work in Canada?" and "Do you require sponsorship?" were answerable.

Both are APP-side, so they ship by `release.ps1` with no CWS gate. **The laptop is running
11.154.0 and does NOT have them.** Auto-apply is off there right now, which is the only reason
this is not live exposure. Turning it on before releasing puts the broken rails back in front of
real applications under his name.

Nothing was released while he was away — a release is a production deploy and needs his fresh
authorization every time.

## The hard rule while he is away

**Apply to nothing. Send no email.** His résumé carried three false claims, so nothing goes out
under his name until it is rewritten and he has seen it. Reading a real ATS page for reconnaissance
is fine. Filling one is not. `--auto` on the e2e rig refuses anything but the local fixture, and
auto-apply is deliberately disabled on the laptop. Leave it disabled.

## Wake mechanism, and the trap

A cron registered inside a session **did not fire for 22 minutes** while the session sat idle, on
2026-09-05, observed independently by three sessions. Do not rely on a scheduler alone.

End every turn by launching a background shell command that waits and exits
(`Bash`, `run_in_background: true`, e.g. `Start-Sleep -Seconds 900`). Its completion arrives as a
task notification, which wakes the next turn with no scheduler involved. Re-arm each time one fires.
Keep several staggered so one missed re-arm does not end the run.

Peer sessions also poke each other: call the session-management `list_sessions`, and `send_message`
anything genuinely stalled, telling it to continue **its own** work. Never hand a peer a new
objective.

**Two things measured the hard way on 2026-09-05, both by getting them wrong:**

- **Quiet is not dead. The threshold is 25+ minutes, not 15.** The Plex Hub session was poked at 23
  minutes while it was correctly waiting on a ~38 minute Rust build with a poller armed. A session
  mid-long-job is indistinguishable from a stopped one from outside, and `isRunning: false` does not
  settle it. Before poking, check the peer's own state file — that session keeps one at
  `scratchpad/RUN-STATE.md` saying what it waits on and for how long.
- **A session's TITLE does not tell you what it works on.** The session titled "Plex Hub library song
  playback" (and carrying PR #2) is actually on the Plex Hub **server and admin** backlog: the admin
  request page, failed-request resolution, server binary builds on the offload laptop, deploys. It
  has never touched song playback. It has had to correct this three times. **Ask the session, do not
  read the title** — a wrong lane in the return summary is something Pierre would act on.

## Needs Pierre — decisions nobody should make for him

**The vault has no git remote.** `F:/GITHUB/Perosnal/nexus-vault` — 99 commits, 243 notes, the
thing CLAUDE.md calls his persistent memory across every session — exists on one disk with nothing
configured to push to. Verified independently 2026-09-05 after the GMServer session raised it.

**Nobody should push it while he is away, and none of us has.** That vault carries people's names,
employment detail, an account-compromise note and a security checklist. Pushing it publishes all of
that, and he has authorised pushing *project code*, never the vault. One command once he says yes,
and the destination (private repo? which host?) is his call.

**What was done instead, because it is a local backup and not publication** — he has said backups on
the external drive are fine:

| | |
|---|---|
| `D:/code/backups/nexus-vault.git` | full mirror clone: all 99 commits, all history, restorable with `git clone` |
| `D:/code/backups/nexus-vault-notes/` | plain copy of all 243 `.md`, so the 10 not yet committed are covered too |

Both verified after writing. This removes the single-disk risk; it does not remove the need for an
off-machine copy, which is still his decision.

Two things to know before touching that repo: other sessions have uncommitted edits in it right now,
so stage only your own paths and never `git add -A`; and `git pull --rebase` refuses while it is
dirty.

### The needs-you queue on the LAPTOP, measured 2026-09-05 over its own API

The laptop is the machine that actually applies, so this is the tally that matters. Read with
`curl -H "x-jat-token: <token>" http://100.104.86.34:7744/queue` — read-only, no changes made.
1,425 tasks, **209 parked**, **54 permanently at the rescue cap** so nothing will release them
without him. Zero questionless parks: the 2026-09-05 sweep cleared all 15 and none have recurred.

| blocked | question |
|---|---|
| **28** | **Location (City)** — the single biggest blocker, see below |
| 14 | Export Control statement acknowledgement |
| 13 | Country |
| 17 | "a required field" / "could not be identified" — BY DESIGN, see below |
| 8 | weekly office attendance |
| 4+ | work-authorisation, several wordings — **he answers these, never us** |

**RESOLVED — and it is not a bug.** Traced end to end 2026-09-05, read-only:

- 23 of the 28 report `Please fill out this field.`, the browser's message for an EMPTY required
  field. Only 5 report `Please enter a valid answer`. So the field was mostly never filled, not
  filled-and-rejected.
- The value exists: the laptop profile has `city = "Toronto, ON"`, `country = "Canada"`.
- These are LinkedIn Easy-Apply postings, whose location box is a typeahead, so autofill enters the
  combobox branch. When `fillCombobox` cannot COMMIT a value, RULE 1 at `autofill.js` ~2008 leaves
  the field untouched on purpose: *"typing into it makes the field look answered while its value is
  empty, which submits wrong; blank is honest."* It emits `skipped-combobox-miss` and parks.

So 23 applications are parked because a safety rule chose parking over guessing. Changing that rule
trades parked applications for wrongly-submitted ones, which is the wrong direction. **Do not
"fix" this without Pierre.** The useful lever is the typeahead commit path itself (the same class
`pickSuggestion` handles on the AI Apply side), not the fallback.

**I did NOT do the live-form check I proposed.** These are LinkedIn URLs, and driving LinkedIn with
automation is what got his account warned on 2026-08-10. Everything above came from the ledger, the
profile API and the source.

**The earlier inference was wrong and is left here as a warning:** MEASURED: 28 parks, reason
`blocked the application: Please enter a valid answer`, and `options: null`, so it is a FREE-TEXT
field, not a dropdown. INFERRED, not verified: a Greenhouse-style location box that requires a
suggestion to be picked rather than typed, which is the class `pickSuggestion` handles on the AI
Apply path but which the extension path may not. Worth confirming against one live form before
anyone changes code — do not assume it is the `pickLocationIndex` dropdown bug, because that one
is about options and these fields have none.

**Two park strings that look like defects and are NOT.** Both are deliberate last resorts with the
reasoning written next to them, and both carry the real explanation in the question's `reason`
field rather than its `question`:

- `park('AI rescue', …)` — `executor.js` ~2107
- `park('a required field on this form could not be identified', …)` — `executor.js` ~3701

I mis-read the first as junk and nearly reported ~92 phantom broken rows. **Read the `reason` field,
and the code that writes it, before calling a park unactionable.**

### The same queue on the PC, for comparison


Not a bug, an actionable fact. 334 parked/awaiting tasks. **18 of them sit permanently at the
rescue cap** (`rescue_count = 3`), so nothing will ever release them without Pierre. The questions
blocking them are a small recurring set, and one answer each clears many applications at once:

| answers | question |
|---|---|
| 14 | Location (City) |
| 7 | Are you eligible to work in Canada? |
| 7 | Are you open to coming to the office 2 times a week? |
| 7 | Export Control statement acknowledgement |
| 5 | How did you first learn about Affirm as an employer? |
| 4+ | sponsorship, in several wordings — **work-authorisation, so HE answers these, never us** |

This is the concrete version of the "six recurring screening answers" already on his list. One
sitting clears most of the queue. Note 18 × "have you previously been employed at Affirm" and
8 × Tailscale-specific ones are single-employer, not recurring.

**Two things I got wrong while measuring this, recorded so nobody repeats them:**

- I investigated the 15 empty-question parks against the PC ledger. They were observed on the
  LAPTOP. The sweeps have not run on the PC since 2026-08-26 because auto-apply is off here, so the
  PC could never have shown them. **The provenance question is still open** — the guard that rejects
  a questionless park has existed since 2026-06-19, so those rows should not have been writable.
- I counted 92 tasks "parked on strings a human cannot answer" and was about to report it. Wrong:
  `park('AI rescue', 'text', null, why)` in `executor.js` is a DELIBERATE last resort, its comment
  says so, and the real explanation is carried in each question's `reason` field, not `question`.
  They are a documented trade-off with their own test file, not a defect. **Read the reason field
  before judging a park unactionable.**

## Done this run

| | |
|---|---|
| Résumé and site corrected | `F:\GITHUB\Perosnal\portfolio-site` — committed, **not published** |
| Hidden checkboxes | a control with no box is clicked by its label, so Ashby and Lever consent boxes tick |
| CAPTCHA detection | a visible challenge blocks and names the vendor; invisible scoring does not |
| 15 unactionable parked tasks | legacy sweep in `queueRetryParked` |
| Full auto | exercised for the first time, guarded to fixture-only |
| Migrations tested against the REAL ledger | `tests/migrations-real-ledger.test.mjs`, on a copy. v23 passed every fixture and failed only here |
| `find` after a navigation | it answered from the PREVIOUS page's tree. Now invalidated on navigate |
| The `--auto` refusal | was guarded ONLY by regexes over the rig's source. Now actually run |
| **Five safety rails fixed** | work-auth withholding, fact escalation, residency, the salary floor failing open, and the password rail's fail-closed property pinned |
| **The whole ledger audited** | jobs, tasks, answers, emails, evidence, skips, recoveries and the safety governor, all compared against what the code claims |
| `check_duplicate` timing | its description said only WHAT it does, so the agent called it at step 0 with nothing to compare. Fixed and MEASURED: 28 steps to 26, 456,976 prompt characters to 431,697, and the check now succeeds on its first call |
| Résumé document gap found | the agent tailors from a July PDF; today's corrections went to a file it never reads |

### How to tell whether a prompt-surface change actually helped

Run `node tools/apply-e2e.mjs --fixture`, then read the run out of the scratch database it leaves
behind (`ai_runs` / `ai_steps`, joined on `run_id`, ordered by `seq`). The step list shows exactly
what the agent tried and in what order, and `prompt_chars` on the run row is the cost.

Two changes were verified this way on 2026-09-05, both prompt surfaces, no logic touched:

| change | before | after |
|---|---|---|
| `check_duplicate` says WHEN to call it | step 0 wasted on a check that could compare nothing | step 0 is `navigate`; the check lands first time at step 2 |
| `submit` says the title must be the POSTING's, copied from the page | refused on 2 of 3 runs, agent passed its own résumé headline, 2 steps to recover each time | correct on the first call |

A third followed from tallying every refusal across ten recorded runs (219 steps). The dominant
waste was not what I would have guessed:

| count | failure |
|---|---|
| 16 | `(unparsed)` — the reply was not a single JSON action object |
| 8 | voice-check failures, 4 of them rejecting an already-written résumé |
| 4 | submit or check_duplicate called with the wrong arguments |

Every single voice failure was one of TWO things: an **em dash** (5) and the word **"excited"** (3).
`write_resume` already warned about the dash in date ranges, so it now names both outright and says
that failing means writing the whole document again. That call is the most expensive in the loop at
roughly 20 seconds and several thousand characters, and 4 of 10 runs were paying for it twice.

**Measured across five runs on the same fixture:**

| | steps | prompt chars |
|---|---|---|
| before any change | 28 | 456,976 |
| after `check_duplicate` | 26 | 431,697 |
| after `submit` | 26 | 441,390 |
| after the voice hint | **23** | **382,547** |

18% fewer steps and 16% fewer prompt characters, with no logic changed. The last run had zero
failures and zero refusals, the first completely clean one.

**Caveat worth keeping:** each row is a single run and model behaviour varies, so treat the trend as
real and any individual number as approximate. The mechanism is not in doubt: the specific refusals
being counted above stopped appearing.

**The general lesson: when the agent misuses a tool, the fix keeps going into the REFUSAL rather
than the DESCRIPTION.** A refusal costs a step and a model call on every run that hits it; saying
what is required costs nothing. Both of these already HAD good refusals, and both kept firing.

## What is left, honestly

The backlog below is largely CLOSED. Workable is done, Workday and iCIMS are correctly walled, and
the queue-maintenance test cluster is converted. What remains is either his to decide or genuinely
open-ended:

- **Everything material now waits on him.** Reconnect Gmail, upload the corrected résumé PDF,
  release so the safety fixes ship, answer the recurring questions, clear the CWS Privacy tab.
  `docs/agent/READ-ME-FIRST.md` is the ordered list.
- **~200 source-text assertions remain**, but they are triaged: the ones pinning a literal VALUE are
  fine and should be left alone. The weak ones assert wiring or an expression with no value, and the
  highest-value cluster (db.js queue maintenance) is already converted.
- **The executor refactor** — hoisting `tryAttachResume`, `fieldFromParkReason` and the LinkedIn
  signed-out check into pure exported helpers — is the one structural change that would close the
  remaining test blind spot. Extension code, so it cannot ship until the CWS tab is done anyway.

## Backlog, in order

1. **Dad's second profile end to end** — separate browser, separate ledger, consent gate, role
   manifest. The last untouched item, and the one that makes this usable by two people.
2. **More ATS widget classes.** Every gap so far was invisible until a real form exposed it: native
   select, Greenhouse type-ahead, committed-value-reads-as-empty, hidden consent checkbox. Read real
   Ashby, Lever and Workable forms read-only and look for the next class.

   Volume in the live ledger, measured not guessed: greenhouse 137, ashbyhq 87, lever 49,
   myworkdayjobs 18, workable 13, icims 2. **Workday and iCIMS are already walled** by
   `ACCOUNT_WALL_RX` in `app/src/ai/guardrails.js`, so those 20 are correctly parked and are NOT a
   widget gap. **Workable is the real hole** and is in every vendor list but was never read.
   Recon so far on a live Workable posting: `jobs.workable.com` fronts a jobseeker login and the
   apply control is a `<button>`, not a link; the form itself lives on
   `apply.workable.com/<company>/j/<token>/apply/`. A modal cookie-consent dialog overlays the page
   on first load and has to be declined before anything under it is clickable. Next step is to read
   that apply URL directly rather than clicking through the board.
3. Whatever the last transcript shows the agent struggling with.

## Testing, all four before any release

```
node tools/apply-e2e.mjs --fixture      # add --auto for the submitting branch, fixture only
                                         # add --provider=claude to force the FALLBACK provider
cd app && npm test                       # 1,925 at time of writing, all passing
node harness/run.mjs linkedin lever greenhouse ashby bamboohr
node tools/validate-extension.mjs
```

`--provider=claude` is worth knowing about: the probe order always picks Codex, so without it the
fallback is never exercised, and every `(unparsed)` step in the recorded runs belongs to the
fallback.

All four green at the time of writing: e2e done in 23 to 26 steps with 0 policy refusals, 1,925 unit
tests, harness 5 of 5, extension validation 98 of 98.

## The dominant bug class here: a rule that silently matches nothing

Five instances now, none of which ever threw an error:

| | |
|---|---|
| three regexes written with a literal backspace instead of `\\b` | matched nothing |
| `HIGH_STAKES_RECALL` (db.js) | `\\b(work authoriz|...)\\b` — the closing boundary cannot be satisfied by "work authorization", so the stem branches were dead. **Withholding scraped work-authorisation answers from the autofill bundle depended on this.** |
| `FACT_RX` (escalate.js) | same defect. "Are you authorized to work in Canada?" and "Do you require sponsorship?" were not treated as facts, so the agent could answer them instead of escalating |
| education topic (deterministic.js) | `graduat`/`undergrad` dead |

**A stem in front of a word boundary is a dead branch.** `\\b(sponsor)\\b` cannot match "sponsorship". Give every
stem its own `\\w*`.

**The sweep is finished and the class is closed.** 2,644 regex literals scanned across `app/src`,
`extension` and `tools`, inline ones included (the education bug was inline, so a
declarations-only scan would have missed it — the first version of this scan did). 11 candidates,
**all false positives on inspection**: `citizen` and `resident` are complete words; `answer-audit.js`
already carries `\\w*`; and two were my own substring search finding "resident" inside **"vice
president"**. The scanner is at `scratchpad/stems.mjs` if it is ever worth re-running.

An earlier version of that scan reported 444 dead branches by testing whether each alternative
matched its own bare text. That is meaningless — most patterns need surrounding context — and it
was thrown away rather than reported.

## The pattern to keep hunting: assertions that read the SOURCE, not the behaviour

There are ~57 more `assert.match(src, /.../)` style assertions across `tests/`. Each one passes
just as happily when the behaviour underneath it has broken, because it only greps a file. The
worst case found so far was the `--auto` guard: four regexes, and nothing ever ran the rig.
Weakening the guard to warn-and-continue left every regex passing while the rig went on to copy
the ledger, launch Chrome and start working a real posting URL for 43 seconds.

Convert the safety-critical ones to behaviour first. A source assertion is fine as a SECOND
assertion next to a behavioural one; it is not fine as the only one.

**Converted so far (15):** the `--auto` submit guard; the work-authorisation rail that keeps a
scraped "Yes" off a real application; the unowned-row rule that preserves duplicate protection on
pre-v23 rows; the Sonnet-only clamp; the hidden consent box that Ashby and Lever require; the résumé template resolution; the wedged-Gmail staleness bound; the Easy-Apply multi-node cap; the walled-host domain reducer; the CLI toolset lockout; the summary-dispute filter; the stale-run duplicate-application guard; the walled-task expiry; the unanswerable-park retirement; the parked-task retry. Each was
verified by breaking the code and watching the new test go red.

**Four of the seven had a break the source test could not see**, which is the whole argument:
neutering the model clamp between the two grepped lines left the source test green while Opus
reached the CLI; removing the wrapping-label path left it green while every Ashby-shaped required
consent box silently stopped ticking; and making the missing-<body> case return the whole file left
all three résumé-template source tests green while the entire document would have been inlined into
a résumé head and sent to an employer; and widening SYNC_STALE_MS to 25 hours left all three
gmail-wedged-sync source assertions green while the exact 47-hour wedge they exist to prevent came
straight back.

**A second weak shape lives next to the first: a test that REIMPLEMENTS the logic it checks.**
`gmail-wedged-sync` defined its own copy of the 15 minute bound rather than importing it, so it
could never disagree with production. Where a constant or predicate drives a rule, import the real
one — exporting it is a one-line, zero-risk change.

**The worst example found, and the one to show him.** `easyapply-multinode-cap` defines a local
`cooled()` mirroring `easyApplyCooledDown`. Removing the blackout from the real function — exactly
the 2026-08-08 bug, two nodes looping refused requests at a LinkedIn account already warned for
automated access — left BOTH of the tests named for that regression green:
"the live two-node case: both nodes stay cooled down" and "without the blackout, the old logic
released BOTH nodes — the regression this guards". A test named after a bug is not the same as a
test that catches it.

Known-good counter-example to copy: `host-breaker-backoff` imports the real `backoffMs` and
`HOST_BREAKER_MAX_COOLDOWN_MS` instead of restating them.

**A third shape, found by writing one badly.** The first version of the CLI-argv tests stored the
args array BY REFERENCE. Moving `args.push('--tools', '')` to just after the `spawn` call — the same
line, verbatim, simply too late for the CLI to receive it — mutated the array the test was holding,
and the test passed. Both argv tests now snapshot with `.slice()`. When a test captures a mutable
object, capture a copy, or it will happily agree with a change made after the call it is checking.

Worth noting what caught that break and what did not: the headline source assertion
`args.push('--tools', '')` PASSED, because the line was untouched. Only the positional test and the
fixed behavioural one failed.

**Swept the reference-capture shape too.** Only two other tests store a stub's argument directly
(`discovery-provider`), and production builds that object inline at the call site and never mutates
it, so they are safe. That shape is otherwise absent.

**The real count is 221, not 59.** The first sweep only matched assertions against a variable named
`src`. Tests also slice db.js into `fn`, `guard`, `server`, `bg`, `argsBlock` and assert on those.

**The worst case found, and the one to show him.** `stale-after-submit-guard` is an entire file
about one rule: a run that died AFTER clicking submit must never be silently retried, because
re-applying to an employer Pierre already applied to cannot be taken back. Inverting one condition
in `reconcileStaleRunning` — every string those tests grep for left untouched — reinstated the bug
completely and left **eight of its nine tests green**. Only the new behavioural one failed.

**The db.js queue-maintenance cluster is DONE.** `reconcileStaleRunning`, `expireWalledTasks`,
`retireUnanswerableParks` and `queueRetryParked` are all driven against a temp ledger now.
`cancel()` is the only member left and is NOT convertible: `TRANSIENT_CANCEL`
lives in `executor.js` unexported and the branch it guards is DOM-dependent, so it needs the
executor refactor recommended above. Its regexes do at least pin the literal reason strings. Every one decides whether a job is
retried, requeued or terminally skipped, all are exported, and all can be driven against a temp
ledger the way `reconcileStaleRunning` and `expireWalledTasks` now are. `expireWalledTasks` is done:
a sign error on its cutoff — SQL, bound and default all untouched — reinstated the 2026-07-20
regression that destroyed 40+ never-attempted jobs in ten minutes, and left seven of its eight tests
green, including the one named "this is the 2026-07-20 protection".

**Three files, three identical results.** Reinstating the real bug left 8 of 9, then 7 of 8, then
10 of 11 tests green. In every case the tests that stayed green were the ones NAMED for the property:
"this is the 2026-07-20 protection", "ONE answerable question keeps the whole park alive", "the
implementation requires EVERY question to be unactionable". For this cluster the expected result is
now that the existing tests do not catch the bug they describe.

**A third technique, learned on the last one.** `queuePatch` REFUSES to write a park with no
questions — it downgrades it to `failed`. The live 2026-09-05 rows (parked, `pending_questions`
empty, reason "needs 2 answer(s)") therefore cannot be created through the API at all. Reproduce a
state the API rejects the way the ledger actually held it, with the second handle. If a bug's own
shape is unreachable through the public API, that is worth noticing rather than testing something
adjacent and calling it covered.

**Two techniques worth reusing, both already in the repo:**

- `upsertJob(..., { manual: true })` bypasses the dedup that otherwise collapses several test jobs
  into one (which cost a debugging round on `stale-after-submit-guard`).
- A short-lived second `node-sqlite3-wasm` handle to the same file backdates a column the API will
  not write — `rank-punish` does it for `decay_at`, `walled-task-expiry` now does it for
  `created_at`. db.js holds no transaction open between synchronous test calls.

**Not every source assertion is worth converting, and saying which is part of the work.** The ones
that pin a literal VALUE — `const APPLY_STEPS = 55`, `const APPLY_CHARS = 750000`,
`scheduledOlderThanMinutes = 2` — do fail when the value changes, which is most of what matters.
The weak ones assert WIRING or an EXPRESSION without a value; those are the remaining targets.

**Swept for this shape** with a script over every test file, matching locally-defined functions
against production names. 21 candidates, most of them coincidence (`sleep`, `call`, `findChrome`).
Three were real:

| | |
|---|---|
| `skip-walled-hosts` → `registrableDomainOf` | FIXED — exported it, deleted the copy and its duplicate TLD set |
| `signed-out-latch` → `signedOut` | a NAME COLLISION, not a reimplementation: production's `signedOut(status,name)` checks provider CLI health, the test's detects a LinkedIn signed-out page. The real detector is inline in `executor.js` and reads `location`/`document` directly, so it is not a pure function anyone could import |
| `ai-rescue-park-fields` / `park-label` → `fieldFromParkReason` | pure, but nested inside another function in `executor.js` and not exported |

**A belief in this repo is wrong, and it was justifying weak tests.** `resume-upload-guard` carried
"executor.js cannot be imported under node (it is a browser content-script entry)". It imports
cleanly and exports `SEND_TIMEOUT_MS` and `run` — verified 2026-09-05. The real barrier is only that
the interesting predicates are not exported:

- `tryAttachResume` is at module scope, unexported, and drives the DOM (needs an export + jsdom).
- `fieldFromParkReason` is pure but nested one level in, so it needs hoisting before it can be exported.
- the LinkedIn signed-out check reads `location.hostname` and `document.body` inline, so it needs
  extracting into a pure predicate before it can be tested at all.

**Recommended, NOT done while he is away:** hoist those three into pure exported helpers (the
`autofill.js` pattern — that file exports freely and its tests drive it under jsdom). It is a real
refactor of extension code, extension changes cannot ship anyway until the CWS Privacy tab is done,
and it should be reviewed rather than landed unattended.

**The clamp is the one to quote.** Leaving both grepped lines exactly as written and neutering the
clamp between them with a single line left the source test GREEN while Opus reached the CLI. Only
the behavioural test caught it. A regex cannot see whether the code it names is ever reached.

This is the same family as the three regexes written with a literal backspace instead of ``,
and the CAPTCHA guard that never fired: **the code did not error, it quietly did nothing.**

## Facts worth not rediscovering

- **`GET /documents/<id>` returns metadata only, not `textContent`.** So the résumé text the agent
  actually uses cannot be read over the API from another machine. Do not spend time trying: compare
  `indexedAt` against the date of whatever change you are checking for instead. Both machines' default
  résumé is `PierreSalama_2026.2.pdf`, indexed 2026-07-20 on the PC and 2026-08-03 on the laptop,
  and the evidence-audit corrections were made 2026-09-05, so neither can contain them.

- **Codex works. An earlier note here said it was quota-blocked until 2026-10-04; that was wrong.**
  The suite did report `CODEX_QUOTA ... try again at Oct 4th, 2026` once, and I recorded it as an
  operational fact. It was transient: `codex.status()` now returns `available: true, needsLogin:
  false`, and Codex served every one of the ten end-to-end runs recorded tonight. A skipped
  `REAL codex` test means the quota was hit at that instant, not that the provider is down.

- **`(unparsed)` is a claude-cli behaviour, not a general one.** Across twelve recorded runs:

  | provider | runs | `(unparsed)` steps |
  |---|---|---|
  | codex | 9 | **0** |
  | claude-cli | 3 | **16** (one run burned 12 of its 37 steps) |

  So the loop's commonest failure is concentrated entirely in the fallback provider. That matters
  whenever Codex is briefly unavailable.

  **Diagnosed as far as it goes.** `node tools/apply-e2e.mjs --fixture --provider=claude` forces the
  fallback (the probe order otherwise always picks Codex). Forcing it reproduced 2 unparsed steps in
  26, then 0 in 26 on the next run, against a historical run with 12 in 37 — so it is intermittent
  and its severity varies a lot.

  **Both captured failures were `write_resume`.** One reply had prose before the JSON, one started
  with a clean brace. `parseAction` ALREADY handles both of those: it tries the fenced block, the
  whole reply, and a slice from the first brace to the last. So neither is structural and the parser
  needs no change. What both replies have in common is a whole ~4,000 character HTML document inside
  a JSON string, which is where the escaping goes wrong. Codex gets it right consistently;
  claude-cli does not.

  If this is ever worth fixing, the fix is in the PAYLOAD, not the parser: `write_resume` passes an
  entire document through a JSON string field. The reply text is now captured at 5,000 characters
  (`rejectedReply`), so the next occurrence will show the exact invalid character.
- The laptop is `100.104.86.34:7744`, currently on the release stream. Auto-apply **off**.
- Anything the agent must work FROM rather than glance at needs `reference: true`, or the 1,200
  character observation clip truncates it. His résumé is 4,749 characters and his profile 2,584.
- A committed react-select reads as EMPTY in both the DOM value and the accessibility tree. Both
  places have a fix; a third would need the same treatment.
