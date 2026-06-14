# Publishing JAT to the Chrome Web Store — Private (trusted-tester) distribution

Goal: let the people **you choose** install the extension with one click and get
automatic updates — without Developer Mode, and without it being public.

This is the **Private** visibility path: only Google accounts you list as *trusted
testers* can see or install it. You can add/remove people anytime.

---

## What only you can do

1. **Register a Chrome Web Store developer account** — <https://chrome.google.com/webstore/devconsole> — one-time **$5** fee (covers up to 20 extensions, forever).
2. **Verify a contact email** (Account → Account settings).
3. Upload the package, fill the listing, set **Visibility = Private**, add trusted-tester emails, **Submit for review**.
4. After approval, send your people the install link. They click **Add to Chrome** — done.

Everything below (package, listing copy, privacy policy, justifications) is prepared for you.

---

## The package

`dist/jat-extension-v11.12.0.zip` — the `extension/` folder zipped with `manifest.json`
at the root (what CWS expects). Rebuild it anytime with:

```powershell
Compress-Archive -Path "F:\GITHUB\Perosnal\extensions\job-application-tracker\v11\extension\*" `
  -DestinationPath "F:\GITHUB\Perosnal\extensions\job-application-tracker\v11\dist\jat-extension-v11.12.0.zip" -Force
```

> **Auto-updates:** once it's on the store, you publish a new version by bumping the
> manifest version and uploading a new zip. Chrome pushes it to all your testers within
> hours — no re-install. (The companion desktop app keeps its own GitHub auto-update.)

---

## Listing copy (paste into the dashboard)

**Name:** Job Application Tracker

**Summary (≤132 chars):** Capture, track, and assist your job applications across every
job board, with a local desktop companion and AI help.

**Category:** Productivity

**Description:**
> Job Application Tracker (JAT) helps you keep every job application in one place.
> As you browse job boards, it captures the roles you apply to, tracks their status
> through your pipeline, and can assist you in filling out applications. All of your
> data is stored locally in a companion desktop app on your own machine — nothing is
> sent to the developer.
>
> • Automatically captures applications across job boards
> • A pipeline view of every role and its status
> • Optional assisted form-fill, review-first (it never submits without you in control)
> • A local desktop companion app holds your data (SQLite on your machine)
> • Optional AI help using your own API key or a local model

**Single purpose (you'll be asked):** "Help users capture, organize, and complete their
job applications across the job boards they visit."

---

## Permission justifications (you'll be asked for each)

Every permission below is actually used by the code. Paste these into the "permission
justification" fields:

| Permission | Justification |
|---|---|
| `storage` | Stores the local pairing token, user settings, and update-check state. |
| `downloads`, `downloads.open` | Downloads and opens the companion desktop-app installer; attaches/downloads résumé files during assisted apply. |
| `tabs` | Opens and manages job-posting tabs during paced assisted apply, and reads the active tab URL to detect job pages. |
| `tabGroups` | Groups the tabs assisted-apply opens so they stay separate and can be tidied together. |
| `alarms` | Schedules periodic tidy-up and update checks without a persistent background page (required in MV3). |
| `webNavigation` | Detects when you navigate to a job posting / application page so it can offer to capture or assist. |
| `contextMenus` | Adds a right-click "capture this application" menu item. |
| Host: `<all_urls>` | Job postings live on an open-ended set of domains (LinkedIn, Indeed, Greenhouse, Lever, Workday, and countless company career sites), so the content script needs broad host access to detect and capture applications anywhere. It activates its UI only on pages detected as job/application pages, and **excludes** Google, mail, GitHub, ChatGPT, and Claude via `exclude_matches`. |
| Host: `localhost / 127.0.0.1:7744` | Connects (token-authenticated) to the user's own local companion app that stores their data on their machine. |
| Host: `api.github.com`, `github.com`, `*.githubusercontent.com` | Checks for and downloads app/extension updates from the project's GitHub releases. |

---

## ⚠️ The two real review risks (read before submitting)

Private/Unlisted go through the **same review** as public. Two things may draw scrutiny:

1. **`<all_urls>` broad host permission.** Reviewers prefer narrow host scopes. The
   justification above is legitimate (open-ended job-board domains), but if it's
   rejected, the fallback is to **narrow host_permissions to known job boards** (LinkedIn,
   Indeed, Greenhouse, Lever, Workday, Glassdoor, …) or switch to `activeTab` +
   `optional_host_permissions`. That reduces "captures on *every* site" to "captures on
   the boards we list" — a product trade-off for you to decide if it comes up.

2. **Assisted-apply automating LinkedIn/Indeed.** Automating actions on sites whose ToS
   forbid bots can conflict with CWS policy, and Google has removed such extensions.
   Mitigations already in your favor: it's **user-initiated**, **review-first** (stops
   before final submit by default), and framed as *assistance*, not a bot. If review
   pushes back, options are to (a) lean harder on the "assist + you submit" framing, or
   (b) gate the LinkedIn/Indeed automation. Don't lead the listing with "auto-apply to
   jobs automatically" — lead with **track + assist**.

Neither is a showstopper, but go in expecting possible back-and-forth on these.

---

## Privacy policy (required)

CWS requires a privacy-policy **URL**. `docs/PRIVACY.md` is published to the **public**
`Job-ext-app` repo (the release repo), so paste this into the CWS "Privacy policy" field:

`https://github.com/PierreSalama/Job-ext-app/blob/v11/docs/PRIVACY.md`

(or enable **GitHub Pages** on that repo for a cleaner URL). Its contact email is
**pierresalama1152@gmail.com** — add the same address under Account → Account settings.

You'll also complete the **Data use** disclosures: the extension collects job-application
data the user captures and stores it **locally** (companion app + `chrome.storage`); it is
**not sold** and **not sent to the developer**; network calls go only to the user's local
app, GitHub (updates), and any AI/email provider the user configures themselves.

---

## Submit checklist

- [ ] $5 developer account registered + contact email verified
- [ ] `dist/jat-extension-v11.12.0.zip` uploaded
- [ ] Listing copy + single-purpose + category filled
- [ ] All permission justifications pasted
- [ ] Privacy-policy URL set + Data-use form completed
- [ ] At least one 1280×800 (or 640×400) screenshot + the 128px icon
- [ ] **Visibility = Private**, trusted-tester emails added
- [ ] Submit for review

After approval: copy the item's store URL, share it with your trusted testers, and they
install with one click. To add someone later: add their Google email to the trusted-tester
list (Account settings) — no re-review needed.
