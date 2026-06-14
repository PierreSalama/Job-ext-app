# Privacy Policy — Job Application Tracker (JAT)

_Last updated: 2026-06-14_

Job Application Tracker ("JAT", "the extension") is a **local-first** tool. Your data
stays on your own computer. This policy explains what the extension handles and where (if
anywhere) it goes.

## Summary

- Your job-application data is stored **locally** on your machine — in a companion desktop
  app (a local SQLite database) and in the browser's local extension storage.
- **None of your data is sent to the developer.** There is no analytics, tracking, or
  telemetry.
- The only network connections the extension makes are to (1) your own local companion
  app, and (2) GitHub, to check for and download updates.

## What the extension accesses

- **Job-application details you capture** — e.g. role title, company, job URL,
  application status, and answers you provide — as you use job boards. This is stored in
  your local companion app.
- **Browser tabs and navigation**, only to detect job/application pages and to open/manage
  tabs during assisted form-filling. The extension does **not** read or collect the
  contents of unrelated pages, and it excludes sensitive domains (Google, mail, GitHub,
  ChatGPT, Claude).
- **Local extension storage** — a pairing token and your settings.

## Where data goes

- **Your local companion app** (`127.0.0.1:7744`, token-authenticated) — stores everything
  on your machine.
- **GitHub** (`github.com`, `api.github.com`) — only to check for and download new versions
  of the app/extension. No personal data is sent.
- **Services you configure yourself** — if *you* enable AI assistance or email sync in the
  companion app, the app connects to the provider *you* chose (e.g. your own Anthropic/
  OpenAI API key, a local model, or your email provider via your own credentials). That
  traffic uses your credentials and goes directly to those providers; the developer never
  receives it. You control whether these are enabled.

## What we do NOT do

- We do **not** sell or share your data.
- We do **not** send your data to the developer or any third party of ours.
- We do **not** run analytics or tracking.

## Your control

- All data lives on your machine; you can export or delete it from the companion app.
- Removing the extension and uninstalling the companion app removes its data from your
  computer. (If you connected an email account via an app password, revoke that password
  in your email provider's settings — uninstalling JAT does not revoke it for you.)

## Permissions

The extension requests broad host access (`<all_urls>`) because job postings exist on an
open-ended set of domains; it activates only on pages it detects as job/application pages.
See the extension's store listing for a per-permission explanation.

## Contact

Questions about this policy: **pierresalama1152@gmail.com**.
