# What I did while you were away

Saturday 2026-09-05 evening → Sunday 2026-09-06 noon. JAT only. Nothing was applied, no email was
sent, no release was cut, auto-apply stayed off the whole time.

---

## Read this before the numbers below

Measured at 11:31 today, while packing up. **Every row-count in this report came from the database
on THIS PC, and that database has not been written since 2026-09-03 20:57 UTC.** The applier is the
laptop. I audited the wrong machine, three days stale, and only checked at the end.

|                  | PC snapshot (what I audited) | Laptop, live now |
|------------------|------------------------------|------------------|
| done             | 668                          | 409              |
| skipped          | 209                          | 404              |
| failed           | 22                           | 249              |
| parked           | 334                          | 208              |
| awaiting_review  | 90                           | 109              |
| queued           | 32                           | 46               |

**What this does not change:** the fourteen fixes. A bug in `estimateYears`, in the country clamp,
in the salary rail, is in the code — not in anybody's database. Each one is proven by a test that
fails when the fix is reverted, and four end-to-end runs reproduced the behaviour directly. Those
stand exactly as written.

**What it does change:** every count attached to them, and one headline.

### The 81% is wrong, and the real number is the other way round

`jat-doctor` computes ELIGIBLE as `done / (done + failed + awaiting_review)` over a window. That is
four fields, so I computed it on the laptop's live queue directly (1,425 rows, newest write
2026-09-06 03:31 UTC — 23:31 last night, when it went quiet):

| window    | done | failed | awaiting | ELIGIBLE |
|-----------|------|--------|----------|----------|
| all time  | 409  | 249    | 109      | **53%**  |
| 30 days   | 318  | 249    | 98       | **48%**  |
| 14 days   | 238  | 241    | 44       | **46%**  |
| 7 days    | 59   | 83     | 17       | **37%**  |

**Not 81%. Below the 60% target in every window, and falling as the window narrows** — which is the
direction that matters, because the narrow window is the current build. The PC's 81% described a
machine that stopped applying on Sep 3.

### And the dominant failure on the laptop is extension-side

Same source, 241 failures in the last 14 days, bucketed by `lastError`:

| n  | failure |
|----|---------|
| 83 | repeated page-level action did not transfer: **Easy Apply to this job** |
| 57 | stuck on a step (page stopped advancing) |
| 48 | timed out / interrupted |
| 15 | smartapply step did not advance (Continue never enabled) |
| 14 | external apply timed out after 4 min |

By class: 125 `transient_page`, 97 `unknown_failure`, 14 `external_site`, 3 `bot_challenge`.

I traced where each string is actually written, because "it's all the extension" was too tidy to
trust:

- **83 + 57 + 15 = 155 are extension-origin** — `executor.js`, `linkedin-apply.js`,
  `opener-stall.js`. `db.js` only classifies those, it does not write them.
- **48 are app-origin**, and I had this one wrong at first. `"timed out / interrupted — will retry"`
  is written by `reconcileStaleRunning` (`app/src/db.js:4223`) when a dispatch goes stale. A comment
  right above it records a measurement someone already took **on the laptop, 2026-08-12: of 185 such
  deaths, 127 had a near-empty transcript** — the executor never ran at all. Those are dispatches
  claimed faster than Chrome could execute them, and there is already a fix that routes them back to
  `queued` instead of burning them as failures.

So the honest version is **155 of 203 extension-side, 48 pointing at dispatch pressure on the same
machine**. The top bucket is the one that was 52 on Sep 2: it has grown to 83 while the laptop ran an
extension 31 commits behind.

That is still the story: **the failing code and the un-deployed code are the same code.**
After you deploy, this table is the thing to re-measure — the top row is the one that should move.

So the sentence at the top of this report was backwards. Your auto-apply was **not** quietly working
and merely saying untrue things. On the machine that applies it is at **37% over the last seven
days**, and that machine is running a three-week-old extension missing 31 commits of apply-flow
fixes. Those two facts belong next to each other: **the deploy is not housekeeping, it is the fix.**

And it is not a new diagnosis. Your own vault note for **2026-07-03** already says it: *"the loaded
extension was STALE — deploy + unpacked-reload alone converts those 38 failures to fast skips"*, with
the eligible rate at **32%** at the time. Two months later the fix still has not been deployed and the
rate has moved 32% → 37%. I re-derived in one night something that was already written down.

### The other counts, corrected where I could check them

- "**114 of 334 parked tasks say `AI rescue`**" — on the laptop it is **4 of 208**. The laptop's
  dominant park reason is `needs N answer(s)` (111 need one answer, 38 need two). The humanize fix is
  still right; its blast radius there is four rows, not a hundred.
- Treat **294 of 793**, **357 US jobs**, **30**, **79**, **72**, **26**, **59** the same way: real
  measurements of the PC snapshot, not of the machine that applies.

The right first move on the numbers is to point the doctor at the laptop and re-read it:
`node tools/jat-doctor.mjs --minutes 60` reads the local DB, so it needs to run **on the laptop**, or
against a copy of the laptop's `jat.db` pulled over Tailscale.

---

## The one-line version

~~Your auto-apply was **working** (81% on eligible applications, target 60%) but saying untrue things
on forms.~~ **Corrected at 11:31, see above.** On the laptop it is at **37% over seven days** and has
been below target all along. I fixed 14 wrong-answer bugs, which still matters. But the headline is
the one I had already found and then talked myself out of: **the machine that applies is running a
three-week-old extension, and it is missing the fixes for its own biggest failure bucket.**

---

## Do these first, in this order

- ~~**Deploy the extension to the laptop.**~~ **DONE 2026-09-06 21:5x.** It ran **11.127.0**; the tree
  is **11.154.0**. `check-extension-live` now prints `current  100.104.86.34:7744: 11.154.0` and
  exits 0. 31 commits of apply-flow fixes are live on the machine that applies for the first time,
  including the fix for its own top failure bucket. Repeat it any time with
  `node tools/deploy-ext-laptop.mjs`. Original note follows: 31 commits
  of apply-flow fixes had never executed there. Not blocked on the Chrome Web Store — that copy is
  loaded unpacked. Copy `extension/` to `C:\ProgramData\JAT-Remote\chrome-extension-pierre` over
  Tailscale SSH, then `POST /ext/reload`. Verify: `node tools/check-extension-live.mjs --node
  http://100.104.86.34:7744 --token <token>` should print `current` and exit 0.
- **Re-run the doctor ON THE LAPTOP.** Everything I measured came from this PC's database, which
  stopped being written on Sep 3. I recomputed the one number that matters from the laptop's live
  queue — it is **37% over seven days, not 81%** — but the doctor also reads transcripts, which the
  queue API does not expose. `node tools/jat-doctor.mjs --minutes 60` reads whatever DB is local to
  it, so run it **there**. Every other count in this report still describes the wrong machine.
- **Reply to Method CRM** — interview invitation, Sep 3, still unread.
- **Publish the OAuth consent screen, then reconnect Gmail.** Ingestion died **2026-08-08**. The
  Method CRM mail will match your query once the pipe is open (its body says "your application").
- **Upload `PierreSalama_2026.3.pdf` as default résumé — on the LAPTOP.** Edit the profile headline.
- **Authorize a release** for the 14 app-side fixes. Independent of the extension deploy.

---

## What I fixed (14, all app-side, all tested)

Each has a test that **fails when the fix is reverted** — checked individually.

**Answers that were untrue**

- "How many years of **anesthesiology** experience?" → answered **3**. `estimateYears` takes no
  subject, so every "years of X" got the same number. 294 of 793 such answers now withheld.
- "Are you legally authorized to work in the **United States**?" → answered **Yes**. Your Canadian
  profile was applied to any country. Also "require sponsorship in the US?" → **No**. 30 corrected.
- **You were applying to US jobs**: 357 in the store, 70 queued, 51 completed. The country clamp knew
  "United States" but not "Ann Arbor, MI". Rejections 136 → 470, zero Canadian jobs lost.
- **14 start-date answers offered to start in the past** (July and August dates), all servable.
- It promised **two weeks' notice and an immediate start** in the same breath. Now one default.
- Bare **Yes/No typed into free-text fields** — including "No" into *"what is your current work
  status in Canada?"*, which reads as saying you're not eligible.

**Your salary floor reached one of three paths**

- The agent's `fill` tool had it. The **autofill bundle** did not (79 harvested answers at 85,000
  against your 90,000 floor). **`/qa/lookup`**, which the executor calls to fill a field directly,
  did not either (72 more). Now one exported rule, called by all three.

**Self-ID and privacy**

- Harvested self-ID answers were outside the recall gate — pronouns, Indigenous, 2SLGBTQIA rows.
  11 blocked. A **pronouns field** is now treated as self-ID and left blank; three tasks were
  stranded on one.

**Queue and diagnostics**

- **`"AI rescue"` was 114 of 334 parked tasks** and unanswerable. The real question was already
  stored in each row's `reason`; the queue just showed the marker. Worse, all 114 deduped to one
  key. Now 113 distinct rows.
- **An unreachable peer cost 10.8–13.8 seconds on every AI call** — two thirds of every agent step,
  waiting on your PC. Now cools down 5 minutes.
- **`(unparsed)` was the commonest step in the system** (16 of 219). Every one was a résumé with an
  unescaped quote. Now repaired in place instead of burning a step; unrepairable ones report where
  and why.
- **An application parked by `ask_human` was recorded as a FAILED run.** Correct behaviour, filed as
  failure.
- **A skip with no reason now keeps 140 characters of the trail**, because transcripts are deleted
  after 3 days and those skips were permanently undiagnosable.
- The **motivation guard** missed 22 of your real questions (4 French, 18 English: "why
  Wealthsimple?", "tell us why you'd like to work with us"). 46 caught → 68.

---

## Things I found but did NOT change — your call

- **26 finished applications are sitting in your review queue.** Their submit worked but couldn't be
  proven. One detector, `static-success-text-unchanged`, accounts for 22 (51% false-negative rate).
  Root cause found: the verifier's strongest proof, `networkPost`, is **dead code** — no caller ever
  supplies it, and a *passing test* vouches for it. I did not fix it: that branch decides whether an
  application counts as sent, and a false positive there is the worst error this system can make.
- **All 48 of the laptop's `timed out / interrupted` failures postdate the fix for them.** The
  requeue guard that sends never-started dispatches back to `queued` shipped in **v11.122.0 on
  Aug 23**, and the laptop's app is on 11.154.0, so it is live there. The 48 run **Aug 25 to Sep 4** —
  every one after the guard. I said I could not tell which from here, then checked: the payload
  carries `hasTranscript` and `attempts`, and that is enough.

  **44 of the 48 have `attempts: 0` and no transcript at all.** A task that ran charges an attempt.
  These never executed — they are precisely the case the guard was written to catch, and they are
  sitting in `failed` instead of back in `queued`. Transcript pruning does not explain it: of the 19
  that failed on or after Sep 1, and so were inside the 3-day retention window when the laptop last
  wrote, **15 still have none**.

  So the guard has a hole. I did not go looking for where — that is a fix, and fixes need your gate.
  The one thing I will point at: the guard's condition is `state === 'scheduled' && neverStarted(...)`
  (`app/src/db.js`, in `reconcileStaleRunning`), and the same function's other branch, for
  `state === 'running'`, has no such carve-out. **That is a hypothesis, not a measurement** — I have
  not confirmed which state these 44 were reaped from. Worth one look before anything is changed.
- **The 114 rescue-parked tasks are all stale** — none fresher than 14 days, 57 older than 60 days,
  113 of 114 never submitted. Bulk-retiring them is reasonable; it's your data.
- **Your diagnostic window is 3 days** (`transcriptClearDays`). After that a failure is
  undebuggable. Worth reconsidering — it capped what I could investigate tonight.
- **A wrong row in your answer bank**: *"how do we pronounce your name?"* → **"He/Him"**. Deleting a
  learned answer can't be undone, so I left it.
- The bank answers *"salary expectations in GBP"* with **"CAD 85,000–110,000"**. Currency mismatch,
  different rail, I'd be guessing at the conversion.

---

## What I checked that was FINE

Recorded so nobody re-derives it: the fit gate and seniority cap (only 1 leak since Aug 20), the
answer bank's 277 "broken" rows (zero would ever be served), its 417 "junk" rows (almost none
harmful — `"ON"` answering "province state" is *Ontario*), the structured profile, the `failed` path
(all 22 carry real reasons), and the 48 `atsBoards` retirements (one historical bulk cleanup).

---

## Verification

- Test suite **2,109 passing, 0 failing, 1 skipped** of 2,110 (from 1,930 — I added 179 tests). Re-run at 11:26 today
- Harness **41/41** scenarios, real extension against real fixtures — re-run in full at 11:35 today, 0 failed
- `validate-extension` **98/0** · version sync OK
- **4 end-to-end runs** — one reproduced the US work-authorisation bug end to end and confirmed the
  fix escalates instead of answering "Yes"
- **176 commits unpushed**, v11 working tree clean. (`git status` from the repo ROOT also lists
  `v$$/`, `v12/`, `v13/` — your own abandoned July directories, untracked since July 3-12. Not
  mine, not touched.)

---

## Honest note on my own reliability

Six times I stated a problem and the next query shrank or overturned it. **Every measured number
held; the inferences I drew between measurements did not.** The worst: I told you your Gmail filter
had never caught an interview email and that reconnecting wouldn't help. Wrong — I'd tested against
a truncated field. It would have had you hesitate on the one item with an unread interview behind it.

I also ran `jat-doctor` — the skill's own step 1 — **last instead of first**. It's what told me the
executor is at 81% and the system was never limping.

And then, at 11:40 while packing up, I found the seventh and largest: I ran it against **this PC's
database, frozen since Sep 3**, when the machine that applies is the laptop. See the section at the
top. The fixes survive that; the counts and the 81% do not. It is the same mistake as the Gmail one
and as the other five — a measurement I took correctly, on something I had not checked was the right
thing to measure.

Weight the numbers here. Weight my sentences around them less.

---

Full detail: `docs/agent/RUN-STATE.md` (audit map, coverage matrix, every deferral with its number,
all corrections). Actions: `docs/agent/READ-ME-FIRST.md`.
