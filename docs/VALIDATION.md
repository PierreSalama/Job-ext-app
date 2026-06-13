# JAT v11 — Manual validation script

Run top to bottom after loading `v11\extension` unpacked and starting the app.
Each ✅ is a hard gate — if it fails, stop and report the step number.

## A. Pairing & foundation
1. Start the app (`npm start` in `app/` or the installed build). Tray icon
   appears; closing the window keeps it running (tray → Open dashboard works).
2. Popup → **Connect to app** → app shows consent dialog → Allow → popup says
   `connected · v11.0.0`. ✅
3. From a random website's DevTools console run
   `fetch('http://localhost:7744/jobs').then(r=>r.status)` → **401**. ✅
4. Settings → Data → **Backup now** → file appears in
   `%APPDATA%\jat11-app\backups`. ✅
5. `Ctrl+Shift+J` toggles the dashboard window. ✅

## B. Capture — LinkedIn (the SPA path that v10 missed)
6. Open `linkedin.com/feed` (NOT a job page). Browse to Jobs → open any job
   **without a full page reload**. Console shows `[JAT v11] detected`. ✅
7. No panel appears yet (silent mode). Click **Easy Apply** → panel slides in
   at "Apply opened". ✅
8. Pick a resume, hit Next once → panel shows the resume filename and
   "In progress"; dashboard (live) shows the job as `started`. ✅
9. Complete the application → panel flips to "Submitted · Saved to tracker ✓";
   dashboard status = `submitted`; timeline has created → submitted. ✅
10. Re-open the same job → no duplicate row (dedup). ✅

## C. Capture — cross-tab + iframe
11. Indeed: apply to a job that opens smartapply.indeed.com in a new tab →
    the capture carries title/company over (handoff) and submits correctly. ✅
12. A Greenhouse-embedded application (company careers page with the form in
    an iframe) → capture works (check the row's source/needsReview). ✅
13. Close the app entirely; submit an application → toolbar badge shows `1`
    (queued); start the app → within a minute the badge clears and the job
    appears. ✅

## D. Manual fallback & false-positive guards
14. On any weird ATS page: popup → **📌 Track this page** → row appears
    (possibly flagged "needs review"). ✅
15. Right-click a job page → **Track this job in JAT** → same. ✅
16. Open a random site's **sign-up page** → no JAT UI of any kind. If an
    "unsure" card ever appears wrongly: click **Not a job** → never again on
    that host (check `chrome.storage.local` `jat11.suppressHosts`). ✅

## E. AI layer
17. Settings → AI: both provider chips green (codex logged in, ollama up).
    "Test" on each returns text. ✅
18. Kill Ollama (tray → quit) → ollama chip red; cover letter still generates
    (codex). Set order `local-only` → graceful error telling you Ollama is
    down. Restore. ✅
19. Job detail → **Fit score** → score + strengths/gaps appear and persist on
    the row. **Cover letter** → modal, no invented employers. **Tailor
    resume** (needs an uploaded resume in Documents) → same employers/dates,
    reordered content. ✅

## F. Auto-apply (use a sandbox/test posting first)
20. Documents: upload your resume (PDF) → "extracted N chars" > 0. Profile:
    fill identity/contact/eligibility. ✅
21. Queue a job (detail → Queue for auto-apply). Settings → Auto-apply →
    enable master switch (review mode). Within ~1 min a background tab opens;
    overlay shows fill progress; it STOPS at the final submit with
    `awaiting_review` + a native notification. You press submit yourself →
    capture pipeline records `submitted`. ✅
22. Queue page: transcript readable; Stop-all works mid-run; daily cap
    respected (set maxPerDay=1 and queue 2 jobs → second stays queued with
    reason `daily-cap` in /queue/next). ✅
23. A job with a captcha → task flips `awaiting_input`, nothing bypassed. ✅

## G. Dashboard & themes
24. Switch theme in Settings → Appearance → instant, persists after reload,
    and the Electron app shows the same theme. ✅
25. Type in the notes field of a job while a capture happens in another tab →
    your text is NOT wiped (no auto-refresh during edit); a "data changed"
    pill appears instead. ✅
26. Kanban drag a card `submitted → contacted` → status + timeline update. ✅

## H. Gmail (optional — needs Google OAuth desktop creds)
27. Settings → Gmail: enter clientId/secret → Connect → browser consent →
    "connected". **Sync now** → scanned/matched/updated counts; a real
    rejection email moves its job to `rejected` with the email cited in the
    timeline. ✅

## I. Update loop (after first v11 release is tagged)
28. Install an older build, tag a newer one → app auto-downloads, prompts
    restart; popup shows the gold update banner with working "Update now". ✅
