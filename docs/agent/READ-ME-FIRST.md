# Pierre — read this before anything else

Written Saturday 2026-09-05 evening and extended through Sunday morning, while you were away.
Ordered by what costs you most if ignored.

---

## If you read nothing else

| # | do this | why | where |
|---|---|---|---|
| 1 | **Reply to Method CRM** | an interview invitation from Sep 3, still unread | your inbox |
| ~~1b~~ | ~~**Update the extension on the laptop**~~ **DONE 2026-09-06**: laptop is on 11.154.0, `check-extension-live` exits 0. Repeat with `node tools/deploy-ext-laptop.mjs`. Original: | it is running **11.127.0**; the tree is **11.154.0**. 31 commits of apply-flow fixes have never executed on the machine that applies, including the one for your single biggest failure bucket. Not blocked on the Chrome Web Store: that copy is loaded unpacked. See section 0 | Tailscale SSH to `C:\ProgramData\JAT-Remote\chrome-extension-pierre` |
| 2 | **Publish the OAuth consent screen**, then reconnect Gmail | it is in Testing, so every reconnect lasts exactly 7 days. Dead since **Aug 8** (measured: the newest email in the ledger is a LinkedIn notice at 2026-08-08T13:00), so JAT cannot tell you an interview arrived. The Method CRM invitation of Sep 3 is not in JAT at all. It WOULD match your Gmail query once reconnected, because its body says "your application" | Google Cloud Console, then Settings |
| 3 | **Upload `PierreSalama_2026.3.pdf`** as the default résumé, on the LAPTOP | the agent is tailoring from a July document and reproduced "Full-Stack Developer, 2024 to Present" tonight | app, Documents |
| 4 | **Edit the profile headline** | same stale claim, second location, the upload will not touch it | app, Profile |
| 5 | **Release** | Saturday's five safety rails plus eleven more fixes from Sunday are here and not shipped: the salary floor on two paths that never had it, the US country clamp, the years-of-experience and work-authorisation answers, fourteen stale start dates. Do NOT re-enable auto-apply first | `tools/release.ps1` |

> **Every count in this file was measured on THIS PC's database, which has not been written since
> 2026-09-03 20:57 UTC.** The applier is the laptop, and its live queue looks different: done 409
> (not 668), failed 249 (not 22), skipped 404 (not 209), parked 208 (not 334). The FIXES are
> unaffected — each is proven by a test that fails when it is reverted, and by four end-to-end runs;
> a code bug does not live in a database. The COUNTS are wrong for the machine you care about, and
> so is the **81% eligible** headline, which came from `jat-doctor` against the same stale snapshot.
>
> **I then computed the real one.** ELIGIBLE is `done / (done + failed + awaiting_review)` over a
> window — four fields, all present in the laptop's live queue. On the laptop: **53%** all time,
> **48%** over 30 days, **46%** over 14, **37%** over the last 7. Below target in every window and
> falling as the window narrows. Not 81%. Re-run `node tools/jat-doctor.mjs --minutes 60` **on the
> laptop** to confirm it against the transcripts, but the arithmetic is not in doubt.
>
> This makes row 1b the most important line in the table, not the second: the machine sitting at 37%
> is the one missing 31 commits of apply-flow fixes. Found at 11:45 on Sep 6, packing up, which is
> far too late.

Then, when you have time: fix the residency and Angular answers (sections 4 and 5), the seven
below-floor salary answers (now enforced on all three paths, see section 0), the site-versus-résumé
divergence (5), and sit down once with the recurring screening questions (8).

`git push` in the JAT repo when convenient: **169 commits**, including everything above, are on one disk.

---

## 0. The machine that applies is running a build from three weeks ago

This is the newest finding and it is the largest, so it goes first even though the numbering does not.

| component | this repo | your laptop | how it updates |
|---|---|---|---|
| app | 11.154.0 | **11.154.0** | electron-updater, automatic |
| extension | 11.154.0 | **11.127.0** | nothing |

Thirty-one commits touching `extension/` have never run on the applier. Among them `a8384ee`,
whose own message calls it *"the dominant live failure on the laptop"* and which matched 12 of 14
captured stalls. **That is the fix for your 52x "Easy Apply did not transfer" bucket.**

**Why nobody saw it.** The app half of the release pipeline works and is exactly current. The
extension half has no equivalent on that machine. And the version number on display, what
`/health` returns and the dashboard shows, is the APP version. It reads 11.154.0.
`server.js` already carried the warning, written when the gap was three versions: *"a silent
version gap is the failure that hides every other fix."* Nothing compared the two numbers.

**The waiting build was checked before recommending it:** `validate-extension` 98 passed 0 failed,
all three version sources synced, and **41 of 41 harness scenarios pass** including
`linkedin-fullpage-handoff`, the fixture for that very fix. It is not a risky build. It is a build
nobody shipped.

**The build you are deploying is untouched by the overnight session.** Verified: of the 34 files
changed since Saturday 20:00, ZERO are under `extension/`. They are 8 app-side sources, 19 tests, 2
docs and 2 tools. So the extension you push is the tree's own 11.154.0, exactly what the harness
validated at 41 of 41, and the two halves are independent: deploy the extension now, release the
app fixes whenever you choose.

**Do this before judging anything else here.** Every conclusion drawn by watching that laptop since
11.127.0 was measuring the old build, including my own reading of its parked queue on Saturday.

Verify afterwards:

```
node tools/check-extension-live.mjs --node http://100.104.86.34:7744 --token <token>
```

It should print `current` and exit 0. It prints `BEHIND` and exits 1 today.

### Also fixed Sunday morning, all app-side, none released

- **Your salary floor guarded one of three paths to a form.** 79 harvested answers bottoming at
  85,000 were being shipped against a 90,000 floor, plus 72 rows in the answer bank. Now one
  exported rule, called by all three.
- **You were applying to US jobs.** 357 in the store, 70 queued, 51 completed. The country clamp
  only knew "United States" and ", USA"; American postings say "Ann Arbor, MI". 136 rejections
  becomes 470, with zero Canadian jobs lost. This is also where every H-1B and "authorized to work
  in the United States" question in your bank came from.
- **Fourteen start-date answers offered to start in the past**, July and August dates, all servable.
- **The deterministic floor answered "3" to "how many years of anesthesiology experience"** and
  "Yes" to "are you authorized to work in the United States". Six fixes there in total.

Full detail in `docs/agent/RUN-STATE.md`, including the surfaces that were audited and came back
clean, so nobody re-derives them.

---

## 1. You have an unread interview invitation from Sep 3

**Method CRM — "Invitation to Interview"**, from Angelina Kolomoitseva, **Thu Sep 3**, still unread:

> "I have reviewed your application and would like to schedule an initial 15-20 minute Zoom..."

Also sitting unread or unactioned since Aug 1:

| date | what |
|---|---|
| Sep 3 | **AutoTrader.ca** — Software Engineer, sets out the interview process |
| Sep 2 | **AutoTrader.ca** — same role |
| Aug 26 | **AutoTrader.ca** — Software Engineer, AutoSync |
| Aug 12 | **Hiring Fluency** — React Developer assessment, **deadline was Aug 14, expired** |
| Aug 9 | **Mitchell** — "Fast Track" Python Developer Jr |
| Aug 3 | **Ethan Rowe** — Follow-up Virtual Interview, Teams link |

Talent500 is recruiter spam. PolicyMe (Sep 3) is a form acknowledgement.

I read the list only. Nothing was opened, marked read, replied to or deleted. The single email sent
today was the one you pre-approved to Bharath at Agilus.

---

## 2. Why JAT never told you: it has ingested no email since 2026-08-01

- **Laptop** (the machine that applies): Gmail `configured: false, authorized: false`. Last attempt
  2026-08-01 — *"Not authorized — reconnect Gmail in Settings."*
- **PC**: the app is not running; its newest stored email is 2026-08-08.

Every invitation above arrived after that, so the feature you asked for — *"connect the emails to
jobs and report if any interviews came in or not"* — has been dark the whole time.

**DO NOT JUST RECONNECT. That is what guarantees the next outage.** The code already worked this
out and wrote it down (`app/src/main.js` ~631):

> THE 7-DAY DEATH. Reconnecting fixes `invalid_grant` for exactly one week and then it dies again:
> re-authorised 2026-08-01, last success 2026-08-08 14:15, a 7.6-day life. That is the signature of
> a Google Cloud OAuth consent screen still in **TESTING** status, where refresh tokens are expired
> after 7 days by policy.

So the actual fix, in order:

1. **Google Cloud Console → APIs & Services → OAuth consent screen → PUBLISH APP.**
   While it stays in Testing, every reconnection buys exactly seven days.
2. Then reconnect Gmail in Settings.

This has now killed the sync at least twice: 2026-06-30 (1,828 consecutive `invalid_grant` failures
over 31 days) and again a week after the 2026-08-01 reconnection. Both times nothing surfaced it
until somebody went looking, which is five weeks of interview mail on the second occasion.

**The matching is fine**: 1,190 of 1,427 stored emails are linked to a job, 981 automatically.
Nothing needs rebuilding.

Knock-on: 90 applications sit in `awaiting_review` (submit clicked, outcome never confirmed).
Cross-referencing them against your inbox resolves exactly **1**, because the evidence was never
ingested.

---

## 3. Do not re-enable auto-apply until you release

**Five safety rails were broken or weak.** All fixed here, all APP-side, none shipped:

| rail | what was wrong |
|---|---|
| `HIGH_STAKES_RECALL` (db.js) | decides what the autofill bundle WITHHOLDS. A scraped "Yes" to "Do you have work authorization in the US?" would have gone onto a real form |
| `FACT_RX` (escalate.js) | decides what the agent ESCALATES rather than answers. "Are you authorized to work in Canada?" and "Do you require sponsorship?" were answerable |
| residency duration | not high stakes, though it gates a Canadian federal clearance and `security clearance` already was |
| the salary floor (guardrails.js) | failed OPEN whenever a field's label could not be read, so a number below your 90,000 floor could be typed |
| the password guard | correct, but the property another file depends on was untested. Now pinned |

The first three share one cause: a stem in front of a word boundary. `\b(work authoriz|...)\b`
cannot match "work authorization", so those branches were dead — the same family as the
literal-backspace regexes. A sweep of 2,644 regex literals found no others.

**Measured against your real answer bank**, not invented phrasings. All 4,543 stored questions run
through the old and fixed predicates:

| | |
|---|---|
| treated as high stakes before | 279 |
| treated as high stakes now | **293** |
| newly withheld | **14** |
| coverage lost | **0** |

All 14 are genuine eligibility questions: "will you require our assistance with work authorization
now or in the future" (asked 64 times), "please list the citizenships you currently hold" (14),
"Have you lived outside of Canada in the past 10 years?", the French "Avez-vous l'autorisation
legale de travailler au Canada", three "work authorization expiration date" variants, and the two
residency-duration ones. Nothing protected before is unprotected now, and the extra withholding is
0.3% of the bank, so it will not start parking applications.

**Then the same check in French, because Montreal is your second location priority.** French
right-to-work questions were almost entirely UNPROTECTED, and the few that passed did so only
because they carried English text alongside:

| asked | question | was |
|---|---|---|
| **192** | "Avez-vous la citoyenneté canadienne, une résidence permanente..." | not high stakes |
| 3 | "Êtes-vous légalement autorisé à travailler dans le lieu où se trouve ce poste?" | not high stakes |
| 2 | "Avez-vous besoin de parrainage pour travailler au Canada actuellement?" | not high stakes |
| 1 each | four more phrasings of "légalement autorisé à travailler" | not high stakes |

Fixed, with the location/status line held carefully: **"résidence permanente"** is a status claim
and is withheld, while **"province de résidence"**, "country of residence" and "ville de résidence"
stay answerable. Parking every location question would strand the commonest field on any form.

Final count across the live bank: **279 before today, 293 after the English fix, 305 after the
French one.** 26 more questions withheld out of 4,543, and zero coverage lost at either step.

**All four pre-release checks are green with these fixes in place**, so this is ready for you to
ship whenever you want:

| check | result |
|---|---|
| `node tools/apply-e2e.mjs --fixture` | done in 28 steps, correctly parked in Prepare mode, **0 policy refusals** |
| `cd app && npm test` | 1,923 passing |
| `node harness/run.mjs linkedin lever greenhouse ashby bamboohr` | 5 / 5 |
| `node tools/validate-extension.mjs` | 98 / 98 |

The zero policy refusals matter: the salary-floor change refuses more than it used to, and a real
end-to-end run confirms it does not refuse anything it should not.

One fail-open I deliberately did NOT close: the self-identification guard has the same
unreadable-label hole, but unlike salary there is no independent signal in the value, so closing it
means refusing every click on a ref whose label cannot be read. Your call — the narrow version is
written up in `LOOP-STATE.md`.

Both are APP-side, so `release.ps1` ships them with no Chrome Web Store gate. **The laptop is on
11.154.0 and does not have them.** Auto-apply is off there, which is the only reason this was not
live exposure. Nothing was released — a release is a production deploy and needs your say-so.

---

## 4. Two contradictory residency answers on the applying machine — neither typed by you

Found in the laptop's live answer bank. Both were scraped, both reachable by a real lookup:

| question | stored answer | source |
|---|---|---|
| how many years have you lived in canada? | **6** | scraped from LinkedIn |
| Have you lived in Canada for 10+ years?* | **"on"** (a raw checkbox value = yes) | scraped |

Six years and "yes, 10+ years" cannot both be true, and you never typed either. "Have you lived in
Canada for 10+ years" is the standard prerequisite question for a **Canadian federal security
clearance**, so a wrong answer there is the same unrecoverable kind as work authorisation.

`security clearance` was already gated as high-stakes; residency duration was not. I have added it,
with tests both ways so "Location (City)" and "Where are you located?" stay answerable — parking
every location question would strand the most common ATS field there is.

**Please delete or correct both rows**, and tell me the real number so it can be recorded as your
answer rather than a scrape.

Also worth knowing, though NOT a live risk: one row claims **6 years of React**. About twenty other
rows say 3, and the 6 dates to 2026-06-12 with no recorded source at all. It is unreachable — its
stored normalisation is in an older unsorted format that current lookups can never produce — so it
is dead data rather than a false claim waiting to happen. 77 of 4,543 rows are stale that way.

## 5. It has been claiming 3 years of Angular. You told it zero.

The answer bank stores one row per exact phrasing, and your corrections only ever fixed the phrasing
you were shown:

| answer | asked | source | question |
|---|---|---|---|
| **3** | **5,696** | auto-assisted | how many years of **work** experience do you have with angular |
| **0** | 19 | **your correction** | how many years of angular experience do you have |

The two normalise identically except for the word "work", so they are stored as different questions
and the high-volume one never got your fix. Angular is not in the stack you gave me.

I found seven subjects where a correction of yours is contradicted by a scraped answer. Only this
one is high-volume; the rest are 2 to 62 encounters (software development 0 vs 2, javascript 3 vs 2,
react 3 vs 6, kubernetes 0 vs 2, capital markets 0 vs 2, web development 3 vs 2).

**Java is worth a look too**, though nothing of yours contradicts it: `how many years of work
experience do you have with java` says **3**, asked **11,222 times**, auto-assisted — while the
French phrasings of the same question say **0**.

**I did not edit the bank.** Correcting these is a write to the live ledger on the applying machine,
and nothing will submit while auto-apply is off, so it waits for you. What the fix needs is either
your answer against the high-volume phrasings, or corrections that propagate across phrasings of the
same question — the second is the real repair.

### THE RÉSUMÉ CORRECTIONS NEVER REACHED THE AGENT

This is the one to fix before any application goes out.

On 2026-09-05 at 12:14 the evidence audit's corrections were committed to
`F:/GITHUB/Perosnal/portfolio-site/resume/resume-2026.html`. The agent does not read that file. It
reads the **documents table**, whose default résumé is `PierreSalama_2026.2.pdf`, **uploaded and
indexed 2026-07-20** — six weeks before the audit.

| corrected today | still in what the agent reads |
|---|---|
| `Full-Stack Developer (2025 to Present)` · `Production & Assembly (2024 to 2025)` | **"Full-Stack Developer, 2024 to Present"** |
| 93.5% of commits (3,079 of 3,292), 10 desktop apps, 8 services, 18 repos | "15+ apps and services", "12 repos", "479-case test suite", "32,000-LOC platform" |

**Proof it is live:** the end-to-end run tonight generated a tailored résumé reading
`Tacel | Full-Stack Developer | Toronto, ON | 2024 to Present`. That is precisely the employment
history you asked to have corrected, being reproduced today.

**I have rendered the corrected résumé to PDF so this is one step:**

```
F:/GITHUB/Perosnal/portfolio-site/resume/PierreSalama_2026.3.pdf
```

Upload it in the app as a **résumé** and mark it **default**. That is the whole fix: setting a new
default automatically clears the flag on the previous one (`db.js` ~3356), and the agent reads
whichever document is default for that role. Do it on the **laptop**, which is the machine that
applies; the PC is a separate ledger with its own copy.

The old files are not deleted, only demoted, so you will end up with five copies of
`PierreSalama_2026.2.pdf` sitting alongside the new one. They are inert. Delete them if you want a
tidy list; nothing reads them once they are not default.

**The résumé is not the only place that claim lives.** The laptop profile's `headline` field reads:

```
Full-Time: Full-Stack Developer at Tacel (2024 - Present)
```

Same uncorrected history. Uploading the PDF will not touch it, so edit the headline too, to
something like "Full-Stack Developer at Tacel (2025 to Present)". Everything else in that profile
checks out: `yearsExperience` 3, `salaryExpectation` "CAD 100,000-110,000. Open to less for the
right role.", `university` Toronto Metropolitan University, `major` Computer Science.

**And the sponsorship field, which is already on your list.** The profile gets two of the three
right:

| field | value | verdict |
|---|---|---|
| `workAuthorization` | "Authorized to work in Canada (no sponsorship required)" | jurisdiction-qualified, correct |
| `authorizedToWorkInCanada` | "Yes" | scoped by its own name, correct |
| **`requireSponsorship`** | **"No"** | **unqualified.** True for Canada, false for a US role |

Only the third needs changing, to something that carries its jurisdiction, e.g. "No for Canada; yes
for the United States". Nothing has gone wrong from it yet: zero US-located jobs have ever been
submitted from either machine.

### A third home for the old numbers: your own "additional information" blurb

`src: manual`, so you wrote it, and it goes out a lot. Seen 1,060 times on one phrasing and 525 on
another:

> "Toronto-based full-stack developer with **2 years** of experience building production software in
> React, Node.js, TypeScript, Python, and Rust. At Tacel, I've led work across a **15+ app**
> operations platform, built CI/CD and ETL systems, and rebuilt Tacel.ca, contributing to a 25%
> lower bounce rate and 30% ..."

Two figures in it are superseded by the corrected résumé, which says **3 years of professional
experience** and **10 desktop apps in daily use and 8 production services**. Three different
experience numbers are now in circulation: the résumé and profile say 3, this blurb says 2.

I am not going to decide which is right, because it depends on what you count. If "developer" starts
in 2025 the honest figure for the role is under two years, while three is right for professional
experience at Tacel including the production and assembly period. Both readings are defensible; what
is not defensible is three different numbers going to different employers.

The "15+ app" figure has no such ambiguity: the audit replaced it with 10 apps and 8 services.

Fix it in the app under the learned answers for "additional information" (the audit at
`GET /qa/audit` will show you the rows), or answer it once more and let the correction stick.

### And a fourth: your site disagrees with your résumé, which is my fault

This morning's evidence-audit pass corrected `resume/resume-2026.html` thoroughly and left
`index.html` partly stale. Three claims now diverge:

| claim | `index.html` | corrected résumé |
|---|---|---|
| CI/CD scope | **12 repos** (lines 183 and 519) | **18 repositories** |
| internal npm ecosystem | **9-package** | **12-package** |
| IPC channels | **~200 IPC** (twice) | not claimed at all |

**I have not changed the site.** These are public claims about your work and I cannot re-derive from
here which number is right for which scope: 12 repos may have been true when that paragraph was
written and 18 true now, and I would be guessing. You produced the audited figures this morning, so
you know which is which.

Both files are committed and NOT published, so nothing is live yet. Worth a five-minute pass before
it is. Until you do, every tailored résumé inherits the old claims.
Nothing has gone out, auto-apply is off, but this must happen before it comes back on.

What I verified: the SOURCE HTML carries every correction — "Full-Stack Developer (2025 to Present)
· Production & Assembly (2024 to 2025)", 93.5% of commits, 3,079 of 3,292, 18 repositories, the App
Store authorship. The PDF is Chrome's render of that exact file, by the same `renderPdf` the app
uses for every résumé it sends.

**Confirmed on the LAPTOP too, not just the PC.** Its default résumé document is the same
`PierreSalama_2026.2.pdf`, indexed **2026-08-03**, weeks before the corrections. So this holds on
the machine that actually applies. It also carries FOUR copies of that same file (indexed Jul 20,
Aug 3 twice, Aug 23); the Aug 3 one is the default. Worth tidying when you upload the new one.

**VERIFIED VISUALLY.** Text extraction failed three ways (Chrome subsets fonts on print-to-PDF, so
the content streams hold glyph indices; the in-app browser will not render a local PDF), so I opened
the PDF in real Chrome through the CDP rig and read the rendered page. It is correct:

- **Tacel — Toronto, ON · 2024 to Present · Full-Stack Developer (2025 to Present) · Production &
  Assembly (2024 to 2025)** — the honest employment history
- 93.5% of its commits (3,079 of 3,292), 10 desktop apps in daily use, 8 production services,
  12-package npm ecosystem, CI/CD across 18 repos
- Author of a cross-platform mobile app published on the Apple App Store
- Education: Honours Bachelor of Science, Computer Science, Toronto Metropolitan University,
  2020 to 2024, last-term GPA 3.8
- No Angular and no Java anywhere. One page.

The degree line also independently corroborates the `manual` answer in the bank saying you hold a
bachelor's — two sources, agreeing, neither scraped.

I said in an earlier note that "the résumé is clean". That was wrong and this entry replaces it.
What was true: no Angular and no Java reach the résumé, and the years-of-experience figure is right.
What I missed: the document itself is the pre-audit version.

### What IS contained: the answer-bank overclaim

`my_resume` hands the agent a résumé DOCUMENT and it tailors from that; the answer bank is only
consulted for screening questions. So the Angular row can put a wrong number in a form field, but it
cannot put a false claim in the résumé. That separation holds — the problem above is that the
document itself is out of date, not that the bank leaked into it.


I checked, because it would be the worse outcome. The end-to-end run tonight generated a real
tailored résumé, and it says: "3 years of professional experience", the correct stack (JavaScript,
TypeScript, Python, Rust, SQL, Node, React, Next, Svelte, Astro, Electron, Tauri, PostgreSQL),
Tacel 2024 to Present, and **no Angular and no Java anywhere in it**.

That is architecture, not luck. `my_resume` hands the agent YOUR OWN résumé out of the documents
table and it tailors from that; the answer bank is only consulted for screening questions. So the
Angular row can put a wrong number in a form field, but it cannot put a false claim in the document
you send. Worth knowing which half of the system to trust.

### What the bank agrees on, which is the useful half

Weighted by how often each was actually asked, and all carrying your own corrections: **Node 3,
JavaScript 3, Python 3, SQL 3, TypeScript 3, full stack 3, back end 3** — and honest zeros for
**React Native, Kubernetes, Docker, Vue, PHP**. React resolves to 3. That is a consistent picture of
about three years, and it is good evidence for the résumé pass you wanted to do once enough was
gathered.

## 6. Seven stored answers ask for less than your own floor

Your configured `autoApply.salaryFloor` is **90,000**. The answer bank on the laptop holds seven
salary answers of **85,000**, encountered 168 times between them:

| seen | answer | question |
|---|---|---|
| 119 | 85000 | what are your target base salary expectations |
| 24 | 85000 | what are your yearly base salary expectations |
| 11 | 85000 | what is your desired annual salary for this role |
| + 4 more | 85,000 / CAD 85,000 annually | various |

**Nothing stops these being written.** `salaryWouldUndercut` compares your answer against the
POSTED range — it never compares it against your own floor. The floor is used to decide which jobs
to apply to, not what to ask for. That is a coherent gap rather than a bug, and worth closing.

The bank is also inconsistent about the ask: `CAD 100,000-110,000` (seen 706, matches what you told
me), `CAD 115,000-140,000` (seen 704), `CAD 85,000 to 110,000` (175), `CAD 100,000-116,000` (60).
Different employers have been given materially different numbers.

Two smaller junk rows worth deleting while you are in there: `what is the highest level of education
you have completed => 48`, and `what is your university grade point average => Toronto Metropolitan
University`.

**Education checked out.** A scraped "Yes" to holding a bachelor's degree is asserted 738 times, and
I went looking for a false credential claim — but there is a `manual` row where you answered "Yes, I
hold a Bachelor of..." yourself, so the scrape agrees with you. No problem there.

## 7. 56 applications were thrown away on the PC. The LAPTOP is clean.

**Corrected after checking the right machine.** I measured this on the PC ledger and wrote it up as
56 recoverable applications. Then I built the recovery tool, pointed it at the laptop, and it found
**zero**. The laptop is the machine that applies, and its 404 skipped tasks all carry a real reason:

| count | reason |
|---|---|
| 133 | no Easy Apply, the application is on the company site |
| 54 | CAPTCHA gate, not auto-solvable by policy |
| 90 | needs 7 to 15 years, he set 3 |
| 32 | above the level cap |
| 25 | external posting, easy-apply-only mode |
| 12 | already applied |

Nothing there is a lost opportunity. So the tool below currently reports 0 and there is nothing for
you to do, which is the right answer and not the one I expected.

The PC numbers are still real, and the PC's app is not running, so those rows are inert. If you ever
start applying from the PC, run the tool against it first:

```
node tools/requeue-lost.mjs --base http://127.0.0.1:7744 --token <token>
```

It is a DRY RUN by default and needs `--apply` to change anything, because requeueing sends those
applications the moment auto-apply comes back on. Do it after the release in section 3, not before.

### The original PC measurement, for the record

All terminally `skipped`, all still passing your filters today:

| bucket | skipped | still pass |
|---|---|---|
| "auto-apply skipped without a diagnostic" — the run ended and never said why. All August, LinkedIn and Indeed | 59 | **40** |
| "retired: company career-site source disabled (atsBoards off)" — all on 2026-08-20 | 48 | **16** |

The second is the plainer one: a discovery source was off for a day, 48 jobs were retired, and
`atsBoardsEnabled` is **true again now** — nothing reconsidered them. Among the 16 still viable:
Coinbase, Dialpad, Tenstorrent, Warner Bros. Discovery, Shyftlabs, Moment Factory.

For scale, the ledger holds 668 completed applications, so this is roughly 8% more throughput
sitting there for free.

**I did not re-queue them.** That writes to the live queue on the applying machine and would start
sending applications the moment auto-apply comes back on — your call, not mine, and it should
happen after the release in section 3, not before. `queueAdd(jobId, { force: true })` is the
mechanism; `skipped` is terminal so nothing will pick them up on its own.

**Root cause, measured.** All 59 have a COMPLETELY EMPTY transcript — the executor never wrote a
single line, so it never ran. These were never attempted, yet they carry `skipped`, which is a
verdict and is terminal.

`db.js` already has `neverStarted()`, which correctly returns true for an empty transcript and puts
the task back in the queue with no attempt charged. It is applied in exactly ONE place, gated on
`state === 'scheduled'` (`reconcileStaleRunning`). These 59 arrived at `skipped` by a different
path, so it never sees them.

That is the third time today the same shape turned up: a recovery that exists, works, and does not
cover the population it was written for. The others were `networkPost` (never passed by any caller)
and `creditRaceLostBacklog` (its filter matches 1 of the 79 rows it is for).

The source-level rule worth considering: **an empty transcript means the job was never attempted,
so it cannot be "skipped".** A verdict requires having looked. That is one condition in `queuePatch`,
but it changes state transitions on the machine that applies, so it wants your eyes rather than
mine.

## 8. One sitting clears most of the needs-you queue

209 parked tasks on the laptop, **54 permanently stuck** at the rescue cap. The blockers are a small
recurring set:

| blocked | question |
|---|---|
| 28 | Location (City) — see below, it is not a bug |
| 14 | Export Control statement acknowledgement |
| 13 | Country |
| 8 | weekly office attendance |
| 4+ | work authorisation, several wordings — **you answer these, never us** |

The Location ones are the system refusing to guess: it cannot COMMIT a value into LinkedIn's
typeahead, and a rule deliberately leaves the field blank rather than make it look answered while
empty. Loosening that trades parked applications for wrongly-submitted ones. Do not "fix" it
casually.

---

## 9. A week of work, including tonight's safety fixes, is on one disk

`F:/GITHUB/Perosnal/extensions/job-application-tracker` is **79 commits ahead of origin/main** —
50 of them made today. The remote is `github.com/PierreSalama/Job-Board` (private, last pushed
**2026-08-29**).

I have not pushed: the standing rule here is to push only when you ask, and you did not. But every
safety fix above exists only on this machine until you do. It is one command:

```
git -C F:/GITHUB/Perosnal/extensions/job-application-tracker push origin main
```

Same disk-loss exposure as the vault in section 8, with the difference that this one already has a
private remote configured — so it is a one-command fix rather than a decision.

## 10. The jurisdiction question, measured — real, but it has not fired

Already on your list as the `requireSponsorship: "No"` jurisdiction problem. Now with numbers.

Three of the most-asked authorisation questions are jurisdiction-GENERIC — "the country where the
role is located" — and are answered as if every role were Canadian:

| asked | answer | question |
|---|---|---|
| 1,066 | Yes | do you have the unrestricted right to work in **the country where...** |
| 694 | Yes | are you legally authorized to work in **the region in which the role is located** |
| 518 | Yes | are you legally eligible to work in **the country where this role...** |

Correct for Canada, false for a US role, where you would need sponsorship.

**It has not caused harm, on either machine.** On the PC ledger, of 5,825 jobs, 4,081 are Canadian,
122 US-located, and zero US-located jobs were ever submitted. Re-checked on the LAPTOP after getting
the machine wrong elsewhere: of its 379 submitted jobs, **zero are US-located**. The country filter
held on both. The residual
risk is the 1,622 whose location is unclear or "remote", any of which could be US-based.

Every Canada-specific answer in the bank is correct: sponsorship in Canada "No", authorised to work
in Canada "Yes". The built-in audit at `GET /qa/audit` flags 248 high-stakes rows for your eyes,
277 shape-broken ones that are safe to bulk delete, and 965 junk — out of 4,543. That tool already
existed and is well built; it just needs running.

## 11. Smaller, still yours

- **The vault has no git remote.** 99 commits, 243 notes on one disk. Nobody pushed it — it holds
  people's names, employment detail and a security checklist, and publishing that is your call.
  I took local backups instead: `D:/code/backups/nexus-vault.git` (full mirror) and
  `D:/code/backups/nexus-vault-notes/` (all 243 notes, including the 10 not yet committed).
- **Codex is quota-blocked again until 2026-10-04.** Order is chatgpt → claude → local, so runs
  still work; each call just wastes an attempt first.
- Still on your list from before: HR letter for the 2024 start date, `read:org` token for
  Legacy-Delta-Technologies, sign the AI Apply Chrome profile in, the CWS Privacy-practices tab
  (it blocks every extension fix), and the `requireSponsorship: "No"` jurisdiction wording.

---

## What was done while you were away

1,916 tests passing, tree clean, nothing applied, no release.

- Three real bugs fixed: the two work-authorisation rails above, plus `find()` answering from a
  previous page after a navigation.
- 15 tests converted from grepping source to actually running the code. In four separate files the
  existing tests stayed GREEN while I reinstated the original bug — 8 of 9, 7 of 8, 10 of 11,
  13 of 14. The tests that survived were the ones NAMED for the property they were meant to protect.
- Full detail in `docs/agent/LOOP-STATE.md`.
