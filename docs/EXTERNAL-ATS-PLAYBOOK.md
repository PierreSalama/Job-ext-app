# External ATS Apply Playbook (JAT v11)

> Authoritative, evidence-based reference for how the major external Applicant
> Tracking Systems present their apply flow, captured by direct DOM inspection of
> the **real** company pages JAT's auto-apply reached (from `nav_events`). This is
> the source of truth for the per-ATS adapters in `extension/content/sites/`.
> Last reconnaissance: 2026-06-19 (live pages, Claude-in-Chrome).

## TL;DR — winnable vs walled

| Platform | Hosts | Account needed? | Submit gate | Verdict |
|---|---|---|---|---|
| **Lever** | `jobs.lever.co/*/apply` | No | none | ✅ FULLY AUTO |
| **Greenhouse** | `job-boards.greenhouse.io`, `boards.greenhouse.io` | No | none | ✅ FULLY AUTO |
| **Ashby** | `jobs.ashbyhq.com` | No | none | ✅ FULLY AUTO |
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

## Greenhouse — `job-boards.greenhouse.io` (modern) / `boards.greenhouse.io` (legacy)
- **Open:** form is embedded on the job page (`#application-form`), single page; scroll into view. Some themes show an "Apply" (`button.btn--pill`) that scrolls to the form.
- **Core fields:** labelled "First Name*", "Last Name*", "Email*", "Country*", phone (`input[type=tel]`). Modern GH uses auto-generated ids; map by the visible `<label>` text, not `name`.
- **Resume/cover:** `input#resume` and `input#cover_letter` (accept `.pdf,.doc,.docx,.txt,.rtf`); affordance is a `button.btn--pill` "Attach" (the real `<input type=file>` is hidden — set `.files` directly).
- **EEO/demographic:** present (`[id*=demographic]`) — optional; leave/Decline.
- **Submit:** `button[type=submit].btn--pill` — text "Submit application".

## Ashby — `jobs.ashbyhq.com`
- **Open:** `…/application` is the form; the job page has an "Apply for this job" → reveals/links the form. React SPA — **no `<form>` element**; wait for hydration.
- **Core fields (stable system names):** `input[name=_systemfield_name]` (req), `input[name=_systemfield_email]` (req). Custom fields have **UUID `name`s** → map by the label rendered in the field group (label is a sibling element, not a `<label for>`; placeholders are generic "Type here…").
- **Resume:** file input + an "Upload File" button and an **Autofill** affordance (parses resume) — upload, then re-read.
- **Radios/selects:** custom questions render as `input[type=radio]` groups and comboboxes.
- **Submit:** `button._primary_*` — text "Submit Application".

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
