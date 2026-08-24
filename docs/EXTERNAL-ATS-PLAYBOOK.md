# External ATS Apply Playbook (JAT v11)

> Authoritative, evidence-based reference for how the major external Applicant
> Tracking Systems present their apply flow, captured by direct DOM inspection of
> the **real** company pages JAT's auto-apply reached (from `nav_events`). This is
> the source of truth for the per-ATS adapters in `extension/content/sites/`.
> Last reconnaissance: 2026-06-19 (live pages, Claude-in-Chrome); verdict column re-measured
> against live node data 2026-08-24 — see the dated call-outs under Lever, Greenhouse and Ashby.

## TL;DR — winnable vs walled

| Platform | Hosts | Account needed? | Submit gate | Verdict |
|---|---|---|---|---|
| **Lever** | `jobs.lever.co/*/apply` | No | **reCAPTCHA** (since ~2026-08-20) | ⚠️ was "fully auto" — see §Lever |
| **Greenhouse** | `job-boards.greenhouse.io`, `boards.greenhouse.io` | No | none | ✅ FULLY AUTO again as of 11.124.0 — see §Greenhouse for the four widget fixes |
| **Ashby** | `jobs.ashbyhq.com` | No | none | ⚠️ fills + submits, but success is not verified — see §Ashby |
| **BambooHR** | `*.bamboohr.com/careers` | No | **reCAPTCHA** | ⚠️ FILL → park for human submit |
| **Workday** | `*.myworkdayjobs.com` | **Yes** (create account / sign in) | account wall | ⛔ park "needs you (account)" |
| **iCIMS** | `careers*.icims.com` (URLs end `/login`) | **Yes** | login wall | ⛔ park "needs you (account)" |
| **Taleo** | `*.taleo.net` | **Yes** | login wall | ⛔ park "needs you (account)" |

**Why this split is the right design:** Pierre's `easyApplyOnly` filter is off, so the
queue is heavy with external postings. The old code tried to brute-force *every*
external site with a generic "click the most advance-y button" loop — which on
account-walled sites clicked "Apply" 40× (BMO/Workday) or stalled on multi-step
forms. The honest, high-yield strategy: **drive the account-less platforms to
completion, fill+park the CAPTCHA-gated ones, and cleanly flag the account-walled
ones** instead of looping. ~64 of the recon'd external jobs were on the three
fully-auto platforms.

---

## Lever — `jobs.lever.co`
- **Open:** the `/apply` URL *is* the form (single page). If on a Lever job page without `/apply`, the opener is `a.postings-btn`/"Apply for this job" → navigates to `…/apply`.
- **Form:** real `<form action="…/apply">`, single page (no steps).
- **Core fields (stable names):** `input[name=name]` (Full name, req), `input[name=email]` (req), `input[name=phone]`, `input[name=location]`, `select[name=opportunityLocationId]`.
- **Resume:** `input#resume-upload-input[name=resume]` (label "Attach Resume/CV"); Lever auto-parses the resume to pre-fill — re-read fields AFTER upload settles.
- **Custom questions:** `.application-question` blocks, label in `.application-label`.
- **Submit:** `button.template-btn-submit` — text "Submit application".
- **Also:** "Apply with LinkedIn" (`.awli-button`) — ignore; use the manual form.

> **STALE VERDICT CORRECTED 2026-08-24.** The "FULLY AUTO" line above was written before Lever
> began serving a reCAPTCHA on the apply form. Live evidence: **68 Lever tasks retired on the
> CAPTCHA gate** across both nodes (62 laptop, 6 PC) — "CAPTCHA gate — not auto-solvable by policy,
> retired rather than parked forever" — against **0 submitted, all-time**. Observed on waabi,
> pointclickcare and magnetforensics tenants from 2026-08-20 on.
> Lever therefore belongs on the **BambooHR contract**, not the fully-auto one: fill everything,
> then park `awaiting_review` ("solve the CAPTCHA and submit") so Pierre gets a one-tap finish,
> instead of discarding a filled application. See `sites/bamboohr.js` for the `submitGate:'captcha'`
> pattern and `executor.js` fill-then-park handling.

## Greenhouse — `job-boards.greenhouse.io` (modern) / `boards.greenhouse.io` (legacy)
- **Open:** form is embedded on the job page (`#application-form`), single page; scroll into view. Some themes show an "Apply" (`button.btn--pill`) that scrolls to the form.
- **Core fields:** labelled "First Name*", "Last Name*", "Email*", "Country*", phone (`input[type=tel]`). Modern GH uses auto-generated ids; map by the visible `<label>` text, not `name`.
- **Resume/cover:** `input#resume` and `input#cover_letter` (accept `.pdf,.doc,.docx,.txt,.rtf`); affordance is a `button.btn--pill` "Attach" (the real `<input type=file>` is hidden — set `.files` directly).
- **EEO/demographic:** present (`[id*=demographic]`) — optional; leave/Decline.
- **Submit:** `button[type=submit].btn--pill` — text "Submit application".

> **THE ACTUAL BLOCKER, measured 2026-08-24.** Greenhouse forms *answer* fine and *fill* only
> partly. A controlled re-run (faire, `boards.greenhouse.io/faire/jobs/8603123002`, PC node, with
> AI answering confirmed healthy) resolved every value correctly and still parked:
>
> ```
> trace:field "location (city)*"  type=combobox src=profile → Toronto, ON
> trace:fill  "location (city)*"  → left-empty (typeahead no match)
> trace:field "this role will be in-office…" type=combobox src=qa → Yes
> trace:fill  "this role will be in-office…" → left-empty (typeahead no match)
> trace:ai reply "which categories describe you?" → ans="Fullstack, Backend, Frontend" conf=0.83 → accepted
> trace:ai       "which categories describe you?" → AI answer could NOT be filled (un-pickable widget)
> trace:submit BLOCKED by native validation — 5 required field(s) still invalid; not clicking
> ```
>
> **ROOT-CAUSED AND FIXED IN 11.124.0.** The four mechanisms, each confirmed by instrumenting the
> real `fillCombobox` against the live faire page (Playwright, no submit) rather than inferred from
> the trace. Note that **the trace text was misleading**: "typeahead no match" was printed for two
> completely different causes, neither of which was the typeahead.
>
> 1. **The profile's own city.** `profile.city` is `"Toronto, ON"` — a city *plus* its region,
>    because that is what a person types into a City box. `pickLocationIndex` compared that whole
>    string against each option's LEADING component (`"toronto" !== "toronto, on"`) and vetoed every
>    candidate, so **every** location field on **every** ATS was left blank. `Location (City)*` is
>    the single most parked ATS question on the live install (15 tasks). Fixed by splitting the hint
>    city and using the remainder as region/country evidence only when the profile states none.
> 2. **The label trap.** `looksLikeLocationLabel` matched the bare word "location" anywhere, so
>    *"…can you commit to being in-office three days per week at the **location** where this position
>    is posted?"* — a Yes/No dropdown — was routed through the location matcher, which looks for a
>    CITY among `["Yes","No"]`, found none, and abandoned a field whose correct option was on screen
>    (6 ms, no wait). Fixed: a location FIELD label is short; a long sentence that merely mentions a
>    place is a screening question.
> 3. **The "No options" notice.** The option selector carries `[class*="-option"]`, a substring match
>    on the class attribute — and react-select's empty state is
>    `class="select__menu-notice select__menu-notice--no-options"`. `--no-optionS` contains
>    `-option`, so the notice counted as an option, satisfied the wait loop on its first tick,
>    matched nothing, and was reported as an "un-pickable widget". Fixed by excluding notices, and
>    by scoping the option search to the control's **own** menu (`aria-controls` listbox → select
>    shell → document) so a foreign menu can no longer end the wait.
> 4. **No multi-select, no checkbox groups.** A "select all that apply" answer arrives as one string
>    and must be committed one value at a time (partial success counts — one real selection satisfies
>    the question; blank guarantees a park). And `scanUnknown` skipped **every** checkbox ("never
>    auto-decide bare checkboxes"), so a required checkbox group was invisible to the scan and only
>    surfaced as an unanswerable blocker at native validation. Groups of 2+ are now surfaced once,
>    with the legend as the question; a lone consent box is still never auto-decided.
>
> **Voluntary demographic questions marked required.** Greenhouse's demographic block is introduced
> as "completely voluntary" and then ships `aria-required="true"` + a hidden `required` sentinel, so
> the browser refuses the submit until it holds a value. `NEVER_AUTOFILL_RX` correctly refuses to
> self-identify, which left the form unsubmittable. We now pick the site's **own decline option**
> ("I don't wish to answer" / "Decline to self-identify") and never a substantive value. Note the
> question that broke this — *"Which categories describe you? Select all that apply to you:"* — names
> no protected class at all, so it slipped the label guard entirely and the AI answered a list of
> ethnicities with `"Fullstack, Backend, Frontend"`. Detection is now structural (`#demographic-section`).
>
> **KNOWN UNSUBMITTABLE SHAPE (faire).** faire's "How did you hear about Faire? (Select all that
> apply)" ships `required` on **all 11** checkboxes. Verified live: `form.checkValidity()` stays
> false with one ticked, 19 `invalid` events fire on submit and the browser cancels the click — so
> the browser only considers it satisfied when the applicant claims **every** channel. We tick the
> one that is true and park with that reason stated, rather than tick eleven lies. Not a JAT bug and
> not fixable from our side; rare in the corpus (2 of ~100 parked ATS questions).

## Ashby — `jobs.ashbyhq.com`
- **Open:** `…/application` is the form; the job page has an "Apply for this job" → reveals/links the form. React SPA — **no `<form>` element**; wait for hydration.
- **Core fields (stable system names):** `input[name=_systemfield_name]` (req), `input[name=_systemfield_email]` (req). Custom fields have **UUID `name`s** → map by the label rendered in the field group (label is a sibling element, not a `<label for>`; placeholders are generic "Type here…").
- **Resume:** file input + an "Upload File" button and an **Autofill** affordance (parses resume) — upload, then re-read.
- **Radios/selects:** custom questions render as `input[type=radio]` groups and comboboxes.
- **Submit:** `button._primary_*` — text "Submit Application".

> **VERIFICATION GAP, measured 2026-08-24.** Ashby fills and clicks submit, but the SPA gives the
> confirm-detector nothing to latch onto, so runs end `awaiting_review` instead of `done`:
> "submit was clicked but could not be verified (static-success-text-unchanged /
> no-post-click-change)". Live: **100 ATS tasks sit in `awaiting_review`** across both nodes
> (49 PC, 51 laptop) — some of these are very likely real submissions that were never credited,
> and each needs Pierre's one-tap confirmation. Ashby needs real confirm signals (success toast,
> route change, or a 200 on the submit XHR) before its throughput can be trusted or counted.

## BambooHR — `*.bamboohr.com/careers/<id>` ⚠️ CAPTCHA
- **Open:** job page has **"Apply for This Job"** (`button.MuiButton-root.fabric`) → the application form renders at the **bottom of the same page** (scroll down). No new tab, no iframe.
- **Core fields (stable names):** `firstName`, `lastName`, `email`, `phone`, `streetAddress.value`, `city.value`, `state.value` (select "Province"), `zip.value`, `countryId.value` (select).
- **HONEYPOT:** `input[name^=nickname_]` with label "Please leave this field blank" — **never fill** (anti-bot trap; filling it flags the application). The autofill engine must skip honeypots.
- **Custom questions:** required text fields (e.g. "Which web framework…?*").
- **EEO:** Gender/Ethnicity/Disability selects + Veteran radios — optional, leave/Decline.
- **Submit gate:** **reCAPTCHA "I'm not a robot"** sits above "Submit Application" (`button` in the BambooHR footer bar). → JAT fills everything, then **parks `awaiting_review` "ready — solve the CAPTCHA and submit"**. Never auto-solve the CAPTCHA.

## Workday — `*.myworkdayjobs.com` ⛔ account wall
- Heavy shadow DOM + stable `data-automation-id`. "Apply" → **"Autofill with Resume" / "Apply Manually"** → **"Create Account" (email + password) or "Sign In"**. No application without an account.
- **Detection:** host `*.myworkdayjobs.com`; the create-account/sign-in step shows `[data-automation-id="signInLink"]`/`createAccountLink`/password fields.
- **Behavior:** if a Workday session isn't already signed in for this tenant → park `awaiting_input` "Workday account required — sign in once and I'll continue". Do NOT click "Apply" repeatedly (the old 40× loop).

## iCIMS — `careers*.icims.com` ⛔ login wall
- Apply routes through `/login` (seen directly in the reached URLs). Park "needs you (iCIMS account/login)".

## Taleo — `*.taleo.net` ⛔ login wall
- Classic Oracle Taleo requires a candidate account. Park "needs you (Taleo account/login)".

---

## Adapter contract (extend `sites/index.js`)
Each adapter is a hint-pack consumed by `detector.js`/`executor.js`:
```
{
  id, match(hostname),                 // platform id + host test
  account: 'none' | 'required',        // walled? → executor parks instead of driving
  submitGate: null | 'captcha',        // CAPTCHA-gated? → fill then park
  openApply(),                         // reveal/navigate to the form (BambooHR/Ashby openers)
  formRoot(),                          // tight application container (never the page)
  fieldMap,                            // platform field-name → canonical profile key
  isHoneypot(el),                      // skip traps (BambooHR nickname_*)
  advanceSelector / stepAdvanceSelector,
  isSubmitHint(txt, el),               // final-submit recognition
  fileInputSelector, fileAffordanceSelector,
  confirmSignals,                      // post-submit "application received" markers
}
```
Account-walled (`account:'required'`) and CAPTCHA-gated (`submitGate:'captcha'`)
adapters tell the executor to **stop and park honestly** rather than loop.
