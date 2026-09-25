# RUN-STATE — what this session is doing, so "quiet" can be checked against "expected quiet"

Updated 2026-09-05, late evening. Pierre is away until Sunday evening.

## Standing constraints (unchanged, and none of them have been relaxed)

- Apply to nothing. Send no email. Auto-apply stays disabled on the laptop.
- No release without fresh explicit authorization. 122 commits are unpushed, deliberately.
- Never solve a CAPTCHA, create an account, type a password, or answer a demographic self-ID.
- Never invent experience. Every claim traces to evidence.md, the live profile, or something he said.

## Verified state right now

- Suite: 1988 passing, 0 failing, 1 skipped. Working tree clean.
- Laptop auto-apply: `enabled: false`. No run active, queue not moving. As intended.
- Laptop providers: **codex is quota-blocked until Oct 5**, claude-cli is proven and serving.
  `canAnswer: true`, so applying still works when he re-enables it.

## Method that is working, stated so it survives a restart

Live data beats static analysis roughly 2:1 for finding real bugs, and it has now caught three
things tonight that reading the code did not:

1. Predicted French gaps in `UI_NOISE_Q_RX` / `CAPTCHA_Q_RX` / `SITE_LOGIN_Q_RX` were real in the
   regex and **absent from the live queue**. 299 parked questions, not one French combobox,
   CAPTCHA or sign-in string. The predicted priority was wrong.
2. An edit to `MOTIVATION_RX` silently dropped "cover letter" and ten live questions. The
   hand-written check passed because it had been written from the edit.
3. A test asserting curly single quotes delimit a question was wrong: 11 live rows contain U+2019
   and zero contain U+2018, so it is an apostrophe, never a quote.

So: before widening any pattern, diff it against the live bank (`laptop-qa2.json`, 4,543 rows) and
the parked queue (`jat-parks.db`, 334 tasks) and read every row it newly matches.

## Landed tonight, all committed, none released

Suite 2046 passing, 0 failing, 1 skipped (the real-Codex test, which self-skips on quota).

| file | what was wrong |
|---|---|
| `escalate.js` | the motivation guard missed 22 of his real questions, 4 French and 18 English. 46 refused before, 68 now. |
| `guardrails.js` | a pronouns field is self-ID. Three live tasks were stranded on one. |
| `provider.js` | an unreachable peer cost 10.8 to 13.8 seconds on EVERY call, two thirds of every agent step. Now cools down 5 minutes. |
| `db.js` | "AI rescue" was 114 of 334 parked tasks and unanswerable. The real question was already in each row's `reason`. Distinct keys 1 to 113. |
| `db.js` | harvested self-ID answers were not in the high-stakes recall gate. 11 blocked. |
| `deterministic.js` | **three years of anesthesiology.** `estimateYears` takes no subject, so every "years of X" got the same number. 294 of 793 now withheld. |
| `deterministic.js` | **"authorized to work in the United States?" answered Yes.** A Canadian profile applied to any jurisdiction. 30 answers corrected. |
| `deterministic.js` | five filled work-auth profile fields were never read, and `N/A` parsed as a confident `No`. |

### The two biggest are the same shape

A rail answering from a general fact without checking whether the fact applies to the question in
front of it. Years of experience, and country of authorization. Both produced false statements on
real applications, both passed every test, and neither was visible from reading the code. Both were
found by running the actual function against his actual data and reading the output.

### Corrections to my own findings, recorded so the pattern stays visible

Three alarms did not survive measurement. Saying so is part of the method:

- "harvested self-ID answers replayed 26 times" -- `seen_count` counts WRITES, not servings, and the
  shape gate refuses a bare "0"/"1" anyway. Only the pronoun rows actually reached forms.
- "the bank holds a false P.Eng claim" -- it holds `"1"`, but that is a raw radio value the shape
  gate refuses. `"1"` means nothing consistent in this bank.
- "the 455 answers of 2 are a live bug" -- stale, from when his profile said 2 years. It says 3 now.
### When the deterministic floor actually speaks, measured not assumed

`deterministic.answer` is reached from exactly three places, all in `provider.run`, and all three
are fallbacks: AI disabled, no provider configured, or **every provider errored**. Nothing else in
the app or extension calls it. So it never runs while the AI is working.

That corrects two things I said earlier tonight:

- Withholding an answer does **not** cost extra model calls. The floor is not in the normal path.
- The floor's wrong answers were not reaching every application. They reach a form only during a
  provider outage.

It does not make the fixes small. `remote.js` records what an outage looks like here: both CLIs
probed healthy while every real call failed, "every unfamiliar screening question fell to the
deterministic floor", and that window ran to **38 parked against 31 submitted**. Those 31 went out
with whatever the floor said. Three years of anesthesiology, and authorized to work in the United
States, are answers built for exactly the moment nobody is watching.

One real consequence to expect: during an outage these gates convert "wrong answer submitted" into
"question parked". That is the right trade and it is deliberate, but the parked count will rise if
the chain goes down. Codex is quota-blocked until Oct 5, so the chain is one claude-cli failure
away from the floor right now.
## THE BIGGEST THING FOUND TONIGHT, AND IT IS NOT A CODE BUG

The applier laptop is running extension **11.127.0**. The working tree is **11.154.0**.
It is connected and reporting live, so this is not a stale reading.

**31 commits touching `extension/` are not running on the machine that applies.** Among them:

- `a8384ee` *apply: follow LinkedIn's full-page handoff instead of waiting for a modal* (Aug 26).
  Its own message calls it "the dominant live failure on the laptop", matching **12 of 14**
  captured stalls. This is the fix for the 52x "repeated page-level action did not transfer:
  Easy Apply to this job" bucket. It has never run there.
- `1ac7355` a question about him vs a question for him
- `5f4e5dc` an ambiguous selector is a trap
- `0b566b8` the resume styling has to exist on the machine that applies

`server.js` already warns about exactly this: *"a silent version gap is the failure that hides
every other fix."* It was written when the gap was three versions. It is now twenty-seven.

**This invalidates conclusions, not just fixes.** Any judgement about whether an extension-side
change worked, made by watching the laptop since 11.127.0, was measuring the old build.

### Why nobody noticed, which is the sharpest version of it

The laptop was checked on both halves:

| component | tree | laptop | how it updates |
|---|---|---|---|
| app | 11.154.0 | **11.154.0** | electron-updater, automatic |
| extension | 11.154.0 | **11.127.0** | nothing |

The app half of the release pipeline works and that machine is exactly current. The extension half
has no equivalent on the applier at all. And the version number on display, the one `/health`
returns and the dashboard shows, is the APP version. It reads 11.154.0. Everything looks current.

The build that is waiting was checked hard before recommending it:

- `validate-extension.mjs` -- 98 passed, 0 failed
- `validate-versions.mjs` -- all three sources synced at 11.154.0
- the harness -- **41 of 41 scenarios pass**, loading the REAL extension against faithful fixtures
- `linkedin-fullpage-handoff` is one of those 41, and it **passes**. That is the fixture for
  a8384ee, the fix for the dominant live failure. Written, fixture-verified, never shipped.

It is not a risky build. It is a build nobody shipped.

(Counting note: naming the scenarios from the fixture FILENAMES gives seven names the harness does
not know, because the registry is not the file list. Those seven read as failures and are not.
`linkedin-easyapply.html` is the scenario called `linkedin`.)

### Why it is not blocked on the Chrome Web Store

The CWS gate blocks public distribution. The laptop loads the extension UNPACKED from
`C:\ProgramData\JAT-Remote\chrome-extension-pierre`, so it never goes through the store. I could
find no automated sync for that folder anywhere in `tools/`, which is presumably why it drifted.

### What it needs, and why I did not do it

Copy `extension/` to that path on the laptop, then reload the extension. `POST /ext/reload` arms a
reload, and the extension acknowledges it, but that only reloads what is already on disk: the files
have to be updated first.

Pushing a new build to the machine that applies is release-class. It changes what runs on his
applier, and the standing rule is no release without fresh explicit authorization. So it is
reported, not done. Auto-apply is off, so nothing is applying on the old build meanwhile.
## SURFACES ALREADY AUDITED, INCLUDING THE CLEAN ONES

Recording what was checked and found HEALTHY matters as much as the fixes: it stops the next
session spending a night re-deriving the same negative results.

| surface | verdict |
|---|---|
| deterministic floor | **six real bugs**, all fixed. Years, jurisdiction, profile fields, N/A, start-date contradiction, bare yes/no. |
| recall gates | **two gaps**, fixed: harvested self-ID answers, and start dates already past. |
| salary floor | **two of three paths had no floor**, both fixed and now sharing one exported rule. |
| autofill bundle | gained the salary and stale-date rails; the work-auth/self-ID gate was already right. |
| country clamp | **US state codes were missing entirely.** 357 US jobs, 70 queued, 51 applied. Fixed. |
| **fit gate / seniority cap** | **HEALTHY.** 216 of 758 completed tasks would be rejected today, but they are June and July, from before the rules tightened. Only ONE since 2026-08-20. Nothing to fix. |
| **answer bank, "broken" rows** | **HEALTHY.** The app's own audit calls 277 rows broken; ZERO of them would be served. The shape gate contains every one. |
| **answer bank, "junk" rows** | **NO ACTION, deliberately.** 417 are servable but almost none are harmful, and several are right: "ON" answering "province state" is Ontario. The junk QUESTIONS never match a real form label. |
| **structured profile in the bundle** | **HEALTHY.** Ships unfiltered by design; currently holds no self-ID fields and a desiredSalary above the floor. |
| extension version | **27 versions behind on the applier.** Not a code bug. Blocked on Pierre. |
| **48 "retired: atsBoards off"** | **HEALTHY, closed.** All 48 carry the identical timestamp 2026-08-20T14:32, so it was one bulk cleanup when the setting was toggled, not a leak. `autoApply.discovery.atsBoardsEnabled` is `true` again. Nobody needs to chase these. |
| **the `failed` path** | **HEALTHY, checked before extending the skip fix to it.** All 22 failed tasks carry a specific reason (timed out, stuck on a step, executor already running). The "failed without a diagnostic" fallback has fired **zero** times, so the same trail-preservation was not written for it. |
| **agent loop, `(unparsed)`** | **the single commonest step, 16 of 219, now diagnosed and mostly eliminated.** Every one is a write_resume call with an unescaped quote in bodyHtml. Repaired in place; unrepairable ones now report position and text. |
| **discovery, two location policies** | **HEALTHY, and the asymmetry explains the US leak.** ATS-boards uses an allow-list that fails closed; jobFit uses a deny-list that fails open. US jobs arrived through the second. |
| **jobs with no location (1,085)** | **FLAGGED, not fixed.** 134 queued, 105 applied. The clamp passes them deliberately, and only 18 arrived since 2026-08-20. Rejecting them would contradict a documented decision. Pierre's call. |

Use `GET /qa/audit` before writing another ad-hoc audit. It classifies all 4,545 rows and is better
than anything hand-rolled here.

## A CORRECTION, AND THE REAL SHAPE OF THE FAILURES

I said the failure buckets "may be partly fiction" because the ask_human dispute bug files correct
behaviour as failure. **That was wrong, and checking took one query.**

`ai_runs`, `ai_steps` and `ai_blocks` are all **zero** on the applier. The AI Apply agent has never
run there. `disputeSummary` has therefore mislabelled nothing historically. The fix still matters,
because that path is where the system is heading, but it has corrupted no existing number.

The buckets come from `auto_apply_tasks.last_error`, written by the EXTENSION EXECUTOR, a different
code path entirely. Grouped honestly, they are:

| n | reason |
|---|---|
| **100** | **submit was clicked but could not be verified** (43 static-success-text-unchanged, 23 no-grounded-form, 21 no-post-click-change, 13 no confirmation evidence) |
| 59 | auto-apply skipped without a diagnostic |
| 48 | retired: company career-site source disabled (atsBoards off) |
| 34 | no Easy Apply on this posting, apply is on the company site |
| 16 | filtered: above your level cap (mid) |

States: 668 done, 334 parked, 209 skipped, 90 awaiting_review, 32 queued, 22 failed.

**So the dominant current failure is not the opener at all: it is a submit that happened and could
not be proven.** That is the trustworthiness rail refusing to claim a submission it cannot
evidence, which is correct, but 100 tasks sitting in it is a measurement problem worth its own
session. And every one of those was produced by the STALE extension build, so read them again
after the deploy before drawing any conclusion.

## ONE DETECTOR IS HALF WRONG, AND 26 FINISHED APPLICATIONS ARE ASKING TO BE CHECKED

**Corrected from a first pass that overstated this.** The first version said the `no-evidence`
check was "100% wrong". It is not wrong at all: those 13 tasks are `done`, successful, and carry
only a stale error string. Transcripts are cleared on `done` (all 668 of them are empty), which is
why they looked evidence-less. Cosmetic, not a misclassification.

The real numbers, by detector reason:

| reason | total | done | awaiting review | proven real | **proven, still awaiting** |
|---|---|---|---|---|---|
| **static-success-text-unchanged** | 43 | 0 | 43 | 22 | **22** |
| no-grounded-form | 23 | 0 | 23 | 2 | 2 |
| no-post-click-change | 21 | 0 | 21 | 2 | 2 |
| no-evidence | 13 | 13 | 0 | 13 | 0 |

**26 tasks ask Pierre to review an application that provably went out, and 22 of them come from
one check.** `static-success-text-unchanged` has a 51% false-negative rate. The other two live
checks sit around 9 to 10%, which is a different order of problem.

"Proven" means the JOB reached submitted-or-later. The ghosting sweep only ever runs on a job
already marked submitted (`submitted -> ghosted (no response in Nd)`), so `ghosted` cannot be
reached without a real submission. 32 ghosted plus 7 submitted.

### ROOT CAUSE FOUND: the strongest proof channel has never once fired

`evaluateSubmitEvidence` offers three independent proofs. One of them is dead code.

```js
if (networkPost === true) return { verified: true, reason: 'network-post' };
```

`networkPost` appears in no file but `success.js`. It defaults to `false`, and the single call site
(`executor.js:4376`) passes `before, after, formGrounded, msElapsed, urlBefore, urlAfter, newNodes`
and nothing else. **No caller has ever supplied it, so that branch cannot execute.**

Its own comment calls it "independent proof the form actually transmitted", which is exactly what
is missing on the 22. On a page whose boilerplate already trips `SUCCESS_TEXT_RX`, text can never
prove anything (that is the Activision guard, and it is correct), so only two channels remain: a
URL change and a new DOM node. When neither fires on a real submission, it is filed unverified.

This is the same shape as the five rails found on 2026-09-05: a rule that never fires looks exactly
like a rule that always passes. See [[silent-failure-is-the-default]]. It is in the verification
rail this time, which is the one place it costs credit for real work.

**A permission-free way to wire it, untested and offered as a starting point, not a conclusion:**
`performance.getEntriesByType("resource")` needs no manifest permission and lists the requests the
page made, with timings. Snapshot before the submit click, diff after, and look for a new request
to the form origin inside the click window. Resource Timing does not expose the HTTP method, so it
is corroboration rather than proof, and it should feed the existing evidence ladder rather than
mint a `done` on its own. The alternative, the `webRequest` permission, is not in the manifest and
adding one would complicate a Chrome Web Store review that is already blocked.

### Where it lives, and why it is not tonight's fix

`extension/content/success.js`. Nothing in the 31 undeployed commits touches it: only `a8384ee`
touches the apply path and that is the LinkedIn opener. `480a8a7` sounds relevant and is not, it
fixes `read_page` in the AI Apply agent. **So the deploy will not move this bucket.**

It CAN be developed without the laptop: the harness runs the real extension against
`greenhouse-static-success-text`, `greenhouse-unverifiable-confirm` and `ashby-late-confirm`. That
is the proving ground. Worth its own session, and worth doing after the deploy so the measurement
that follows is taken on the build that is actually running.

## THE PATTERN, SWEPT FOR SYSTEMATICALLY

Having claimed silent failure is the dominant bug class here, I swept for it mechanically: option
parameters with a default that NO production caller ever supplies. That is precisely how
`networkPost` was found, so it is a testable definition.

Across 381 files, exactly **three**, and they are not the same kind of thing:

| parameter | default | used as | what that means |
|---|---|---|---|
| `networkPost` (`extension/content/signals/success.js:66`) | `false` | `if (networkPost === true) return verified` | **a proof that can never be granted.** Costs credit for real submissions. |
| `allowAccountWalls` (`app/src/ai/guardrails.js:111`) | `false` | `if (!allowAccountWalls) refuse` | the guard ALWAYS fires. A harmless escape hatch nobody can open. |
| `allowWrites` (`app/src/ai/tools/jat.js:187`) | `true` | `if (!allowWrites) refuse` | the refusal NEVER fires. "This run may not write to the ledger" cannot be engaged. Latent, not currently harmful. |

So the claim holds, but narrowly: one of the three actually costs anything, and it is the one in
the verification rail.

### The part worth remembering

`networkPost` IS TESTED. `tests/submit-truth.test.mjs` passes it as true and asserts the branch
returns `network-post`. That test passes. The logic is correct. Nothing in production supplies the
parameter, so the branch has never once executed.

A green test named for the behaviour is exactly what stops anyone looking further. This is the
sharpest instance of [[silent-failure-is-the-default]] in the codebase: not an untested rule, a
well-tested unreachable one.

### And the scan itself failed three times, silently

Before it worked it reported "nothing found" three times, from a signature regex that excluded
`}`, a back-context check using `$` without the `m` flag, and a path filter expecting `./extension`
when `path.join` strips the `./`. Each was caught only by asking whether it still found the case it
was written for. A scan for silent failure that fails silently is worth less than no scan, so it
now prints whether it found `networkPost` and says the result is untrustworthy when it has not.

## GUARD-VS-PATH COVERAGE, AFTER TONIGHT

The dominant pattern tonight was a rail that is correct and does not reach every path. Swept
mechanically at the end, to check the work closed the gaps rather than moving them.

| guard | agent fill | recall | bundle + /qa/lookup | floor | executor |
|---|---|---|---|---|---|
| `isHighStakesQuestion` | . | yes | yes | . | . |
| `isSensitiveKey` | . | yes | . | yes | . |
| `isJunkQuestionText` | . | yes | . | . | yes |
| `isPlaceholderAnswer` | . | yes | . | . | . |
| `salaryBelowFloor` | yes | . | yes | . | . |
| `staleStartDate` | . | yes | yes | . | . |
| `SELF_ID_RX` | yes | yes | . | . | . |
| `ACCOUNT_WALL_RX` | yes | . | . | . | . |

Three blanks that are NOT gaps, and the reasons matter more than the table:

- `SELF_ID_RX` looks missing from the bundle. It is not: self-ID was folded INTO
  `isHighStakesQuestion` tonight rather than added as a parallel check, so the bundle inherits it
  from the row above. That is the whole argument for widening a rule instead of copying it.
- `isSensitiveKey` is not on the bundle because credentials are refused at WRITE time in
  `profileFieldUpsert` and never enter the table. Defended at the boundary instead.
- The executor column is nearly empty by architecture: it is a separate runtime that receives an
  already-filtered bundle and imports no app-side guard.

One residue, now measured rather than guessed: `salaryBelowFloor` is absent from recall, so
`qaLookup` can still hand a below-floor answer to the AI prompt as a prior example. Both routes
onward are guarded, `/qa/lookup` and the agent fill tool.

I first guessed that closing it would push "about 22" salary questions into the needs-you queue and
deferred it on that basis. **The measured answer is ONE**, a single parked question reading
"Desired Annual Salary", against 96 below-floor rows in the bank and 299 distinct parked questions.
The guess was wrong by a factor of twenty-two.

Left open anyway, but now for a stated reason rather than a wrong one: `salaryBelowFloor` lives in
`ai/guardrails.js`, and `db.js` does not depend on the AI layer. Doing it properly means moving the
rule into `answer-shape.js`, which db.js already requires and which exists for exactly this, then
updating guardrails, server.js and their tests. Four files and a layer change to close one queue
row on a path guarded at both exits. Worth doing next time answer-shape is open; not worth doing
alone.

**Honest limit of this table:** it is text inclusion, not a call graph. A guard can be mentioned in
a file and still not apply on every branch of it. Read it as a prompt to go and look.

## THE DIAGNOSTIC WINDOW IS THREE DAYS

`maintenance.transcriptClearDays` is **3**, reduced from 14 in the v11.82.0 performance release.
A maintenance pass nulls the transcript of every TERMINAL task (`skipped`, `failed`, `done`) older
than that. The row and its submission evidence survive; the trail does not.

This explains, without any bug being involved:

- all 668 `done` tasks have an empty transcript, while `parked` and `awaiting_review` have theirs
  (those are not terminal, so they are never pruned)
- all 59 "auto-apply skipped without a diagnostic" are unrecoverable now. Their `last_error` was
  written when the transcript still existed, so "no diagnostic" was the verdict THEN, and the data
  to revisit it is gone
- `recoverVerifiedEvidenceFromTranscript` cannot help an old task, though it ran at the time

**So a failure has a three-day diagnostic window, then it is undebuggable.** That is a real
trade against database size and it is Pierre's call, not a defect. But it is short for a system he
checks weekly, and it silently caps the method that found nearly everything tonight: reading the
live data works only on what has not been pruned.

What survived and is therefore still diagnosable: the 334 `parked` and 90 `awaiting_review` tasks,
the whole `qa` answer bank, `profile_fields`, and the jobs table. Every finding tonight rests on
those, so none of it is affected. But nobody should expect to post-mortem a `done` or `skipped`
task from last week.

## GMAIL: ONE PROBLEM, NOT TWO. A CORRECTION.

**The finding I posted first was wrong and is retracted here in full.** I claimed the query filter
had never caught an interview email and that reconnecting Gmail would not surface the next one.
Both were artefacts of a broken measurement: I tested the clauses against subject and snippet only.
**Gmail searches the whole body.**

Retested against the body, all 12 interview emails in the ledger match a phrase clause. Not zero.

What is true, and is a much smaller thing: they match on GENERIC clauses, never the
interview-specific ones.

| email | matched on |
|---|---|
| Virtual Interview Request (Ethan Rowe) | `"your application"` |
| Confirming Phone Interview (Syntronic) | `"thank you for applying"`, one also `"next steps"` |

`"schedule an interview"`, `"interview invitation"` and `"invite you to interview"` have never
fired. The generic clauses do all the work. That is fragile rather than broken: an invitation that
mentions neither the application nor thanks would slip through, and recruiters do sometimes write
that way. Worth two more clauses eventually. Not urgent, and NOT a reason to distrust the reconnect.

**And on Method CRM specifically:** its body reads "I have reviewed your application and would like
to schedule an initial 15-20 minute Zoom". That contains `"your application"`, so it matches. It
would be ingested. The only reason JAT never saw it is the real one:

**Ingestion stopped 2026-08-08.** The newest email in the ledger is a LinkedIn notice at 13:00 that
day. Everything since is absent. Publish the OAuth consent screen, reconnect, and the backlog
should arrive, Method CRM included.

There is no thread-following, incidentally: `gmail.js:366` fetches with the configured query plus a
date bound and nothing else. `threadId` is recorded, never used to pull siblings. That was another
guess of mine that the code disproved.

## THE 114 RESCUE PARKS ARE ALL STALE, WHICH SETTLES WHAT TO DO WITH THEM

I left these as "Pierre's decision: answer them or bulk-skip" without measuring whether they were
still worth deciding about. Measured now:

| age since last update | count |
|---|---|
| 14 days or less | **0** |
| 15 to 30 days | 6 |
| 31 to 60 days | 51 |
| **over 60 days** | **57** |

And 113 of the 114 jobs are still `started`, never submitted.

**Not one is fresher than two weeks. Half are older than two months.** So these are not 114
opportunities waiting on his answers, they are 114 dead postings sitting in the queue. The system
already reasons this way elsewhere: `retireUnanswerableParks` retires a site sign-in gate after a
week untouched, on the grounds that "the posting is stale by now".

That does not undo the db.js fix. Making the rescue reason readable is what stops the NEXT hundred
becoming this, and it is worth having. But for these particular 114 the value is in clearing them,
not in answering them, and my earlier framing of "113 distinct answerable rows" oversold it.

Stated as measured: zero fresher than 14 days, 57 older than 60, 113 of 114 never submitted.
Whether to bulk-retire them is still his call, but it is now an easy one.

## THE DOCTOR SAYS THE EXECUTOR IS AT TARGET, AND I SHOULD HAVE RUN IT FIRST

The skill's step 1 is OBSERVE, via `tools/jat-doctor.mjs`. I went straight to raw SQL all night and
only ran the doctor at the end. It gives a better picture than my queries did:

```
ELIGIBLE: done 293 / apply-able 363 = 81%   at target
raw:      done 293 / terminal 572  = 51%   (includes legitimate skips)
```

**The executor is at 81% on applications it can actually do**, against a 60% target. The raw 51% I
would have quoted counts external postings and too-senior filters as failures. They are not.

That matters for how everything else here reads. The system is not limping. Most of tonight's
fixes were about CORRECTNESS, what it says on a form, not about throughput, and the throughput
number was fine the whole time.

Two more things the doctor gives free:

- **Recovery hygiene is clean.** "awaiting_review with an R1 verified marker (>0 = downgrade bug
  live): 0". The old downgrade race is not running. Note this is a DIFFERENT check from the 26 I
  found: the doctor looks for a verified marker on the task, I looked for the JOB reaching
  submitted-or-later. Both are true at once, and the 26 stand.
- **It independently flags the extension gap**, from a completely different angle: "EA-dense
  discoverTick LIVE? NO — still app JobSpy only (reload the extension to activate the
  Easy-Apply-only discovery)". Two unrelated signals now say the same thing.

Dominant current failure per the doctor: "auto-apply skipped without a diagnostic", 59x. That is
the one whose reason now carries a trail fragment, so the next ones will be readable.

**Lesson for the next session: run the doctor before the SQL.** It knows which skips are legitimate,
and a raw state count does not.

## What is blocked on Pierre, in the order that unblocks the most

1. Reply to Method CRM.
2. Publish the OAuth consent screen, then reconnect Gmail. Reconnecting first "guarantees a repeat".
3. Upload `PierreSalama_2026.3.pdf` as the default resume **on the laptop**, not the PC.
4. Edit the profile `headline`.
5. Authorize a release. Nothing above ships without it.
6. Decide on the 114 rescue-parked tasks: they are now readable, but still need answers or a bulk skip.

## Facts he does not have on file, which keep parking applications

Found in the rescue reasons, recurring: driver's licence, criminal record / pardon, the specific
Canada work-authorization category, US work authorization. Each one parks real jobs repeatedly.
These are his to answer. Do not guess any of them.
