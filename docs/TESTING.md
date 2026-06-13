# JAT v11 — Setup & Test Guide

Two pieces work together: the **desktop app** (owns your data + AI) and the
**Chrome extension** (captures jobs + runs auto-apply). Set up the app first.

---

## PART 1 — Setup (one time, ~3 minutes)

### 1. Start the desktop app
Open a terminal here: `F:\GITHUB\Perosnal\extensions\job-application-tracker\v11\app`
```
npm start
```
A window opens and a tray icon appears. (First run creates the database and a
first backup automatically.)

### 2. Load the extension into Chrome
1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select `F:\GITHUB\Perosnal\extensions\job-application-tracker\v11\extension`
5. **Disable or remove any older JAT** (v8/v9/v10) so they don't conflict.

### 3. Pin & connect
1. Click the puzzle-piece icon → pin **Job Application Tracker v11**
2. Click the JAT icon → **Connect** in the popup
3. A dialog pops up **in the app window** → click **Allow**
4. The popup's dot turns green: `app v11.0.0`. You're connected.

> If the dot stays red "app offline", the app isn't running — start it (step 1).
> If you ever need the logs: app tray is running; logs live in
> `%APPDATA%\jat11-app\logs`.

---

## PART 2 — Test every feature yourself (grouped)

Tick each box. Each group is independent — do them in any order, but **A → B**
first (you need the connection + a captured job before the later groups shine).

### A. Connection & popup (the mission-control panel)
- [ ] Click the JAT icon. The popup shows a green dot + `app v11.0.0`.
- [ ] The **"This page"** card reflects the current tab (says "No job detected"
      on a normal site).
- [ ] Close the app (tray → Quit). Reopen the popup → dot is red "app offline".
      Restart the app (`npm start`) → dot green again.
- [ ] Tray: closing the app **window** (X) keeps the tray icon + capture alive
      (re-open via tray → "Open dashboard"). Only tray → **Quit** fully exits.
- [ ] Press **Ctrl+Shift+J** anywhere → the dashboard window toggles.

### B. Capture — the core ("does it collect well")
- [ ] **LinkedIn SPA path (the big one):** open `linkedin.com/feed`, then
      navigate to Jobs and open a posting **without a full page reload**. Open
      the popup → "This page" card shows the job title/company as *Detected*.
      (No panel appears yet — that's silent mode.)
- [ ] Click **Easy Apply** → the capture panel slides in at "Apply opened".
- [ ] Pick a resume / hit Next → panel shows the resume name + "In progress".
- [ ] Finish applying → panel flips to "Submitted · Saved to tracker ✓".
- [ ] Open the same job again → no duplicate row appears (dedup).
- [ ] **Indeed cross-tab:** apply to a job that opens `smartapply.indeed.com` in
      a new tab → it still captures the right title/company (handoff).
- [ ] **Greenhouse/Lever iframe:** a company careers page with the form embedded
      → it captures (check the row shows up).
- [ ] **Offline queue:** quit the app, apply to a job → the toolbar badge shows
      a number (queued). Start the app → within ~1 min the badge clears and the
      job appears in the dashboard.
- [ ] **Panel collapse:** click the `‒` on the panel → it shrinks to a small
      pill; click the pill → it expands. (Stays collapsed as you move around.)

### C. Capture — false-positive guards (your old complaints)
- [ ] Open a **random site's sign-up / "Create account"** page → **no JAT UI
      appears at all.**
- [ ] If an "Track this application?" card ever appears on a non-job page: click
      **Not a job** → it never asks again on that site. (Re-enable later from the
      popup if you want.)
- [ ] The unsure card auto-fades after ~12s if you ignore it — never sticks.

### D. Manual capture (fallback for anything missed)
- [ ] On any job/ATS page, popup → **📌 Track this page** → row appears in the
      dashboard (may be flagged "needs review" if sparse).
- [ ] Right-click any page → **Track this job in JAT** → same.

### E. Dashboard — the views
Open it: popup → **Open dashboard** (or the app window).
- [ ] **Dashboard:** stat cards (Tracked / This week / In pipeline / Needs
      review), pipeline pills (click one → filtered Applications), recent list.
- [ ] **Applications:** search box, status filter, source filter, click column
      headers to sort, **Export CSV**.
- [ ] **Bulk:** tick several rows → the bar appears → set status / queue for
      auto-apply / delete (delete shows a 5-second **Undo** toast).
- [ ] **Application detail:** edit fields, add tags, change status, set a due
      date, then clear it (empty due date saves as cleared). Save.
- [ ] **Pipeline (kanban):** drag a card to another column → its status updates
      and a timeline event is added.
- [ ] **Live + no-flicker:** open a job's detail, start typing in Notes, and in
      another tab trigger a capture → your typing is **not** wiped; you get a
      subtle "Data changed — refresh" pill instead.

### F. Themes & polish
- [ ] **Settings → Appearance:** click any swatch (53 themes) → applies
      instantly and persists after reload. The desktop app and the extension's
      dashboard show the same theme.
- [ ] Navigate between pages → a brief shimmer skeleton shows while loading, then
      a subtle fade-in.

### G. AI layer (Codex cloud + Ollama local)
- [ ] **Settings → AI:** both chips green — `Codex (ChatGPT) ● ready` and
      `Ollama (local) ● ready`. Click **Test codex** and **Test ollama** → each
      returns text.
- [ ] **Job detail → Fit score** → a 0-100 score + strengths/gaps appears and
      sticks on the row.
- [ ] **Cover letter** → modal with the letter (Copy / Download). Check it didn't
      invent employers.
- [ ] **Tailor resume** (needs a resume uploaded in Documents first) → same
      employers/dates, reordered for the job.
- [ ] **Failover:** quit Ollama (its tray icon → Quit) → the Ollama chip goes
      red, but cover-letter still works (Codex). Set order to `local-only` in
      Settings → it errors clearly that Ollama is down. Restore.

### H. Profile & documents (feed the AI + auto-apply)
- [ ] **Documents:** drag a PDF/Docx resume onto the drop zone → "extracted N
      characters ✓". Star it as default. Download it back. (No text extracted =
      the file is an image-only scan.)
- [ ] **Profile:** fill identity / contact / eligibility / skills, mark default,
      add a source ("linkedin"). Save.
- [ ] **Import from resume:** click it → empty fields fill from your resume.
- [ ] **Learned answers:** after an apply, the qa table shows questions you
      answered; edit/delete inline.

### I. Auto-apply (use a throwaway/test posting first!)
- [ ] **Settings → Auto-apply:** set pacing (e.g. max/day 5), keep **mode =
      review**, flip the **master switch on**.
- [ ] Queue a job (detail → **Queue auto-apply**, or Applications bulk).
- [ ] Within ~1 min a background tab opens, an overlay shows it filling, and it
      **stops at the final submit** ("ready for your review") + a notification.
      You press submit yourself.
- [ ] A weird free-text question routes to AI; an unanswerable/sensitive one
      (work-auth, demographics) is **left for you**, never invented.
- [ ] **Stop everything** button (Queue page) halts instantly + flips the master
      switch off. The daily cap is respected (set max/day 1, queue 2 → second
      waits).
- [ ] A captcha/login page → the task pauses ("awaiting input"), never bypassed.

### J. Lifecycle automation
- [ ] **Gmail (optional, needs Google OAuth desktop creds):** Settings → Gmail →
      enter Client ID/Secret → Connect → approve in browser → **Sync now** shows
      scanned/matched/updated. A real rejection email moves its job to Rejected
      with the email cited in the timeline.
- [ ] **Activity page:** event feed + AI usage meter.

### K. Data safety
- [ ] **Settings → Data:** Backup now (file in `%APPDATA%\jat11-app\backups`),
      Export JSON (downloads), Import JSON (round-trips).
- [ ] **Security check:** open any website's DevTools console and run
      `fetch('http://localhost:7744/jobs').then(r=>r.status)` → it returns
      **401** (no other site can read your data).

---

## PART 3 — Automated tests (run mine anytime)

From `F:\GITHUB\Perosnal\extensions\job-application-tracker\v11`:

```powershell
# Unit tests (pure logic — status FSM, fit scoring, prompts)
node --test "tests/*.test.mjs"

# Extension static validation (manifest, files, message contracts, safety) — no browser
node tools/validate-extension.mjs

# Full app end-to-end (needs the app running in another terminal)
#   exercises every REST/SSE feature: jobs, events, settings, qa, profiles,
#   documents+extraction, queue+pacing, AI (real codex/ollama call), export,
#   backup, SSE, security
node app/e2e-full.cjs
```

Current status (2026-06-12): **unit 14/14 · extension 69/69 · app E2E 40/40**,
both AI providers READY.
