# JAT v11.0.1 — Guided onboarding (extension → app)

The goal: someone installs **only the extension** and is walked, hand-held,
through getting the desktop app running and connected — ideally one or two
clicks.

## What ships in 11.0.1

- **`extension/onboarding/`** — a full-page setup wizard that opens
  automatically the first time the extension is installed
  (`chrome.runtime.onInstalled`, reason `install`). Stages:
  1. **Welcome** — what the app is, why it's private (data stays on the PC).
  2. **Download & install** — one button downloads the OS-matched installer
     (`chrome.downloads`), shows a progress bar, then a prominent **▶ Run
     installer** button (`chrome.downloads.open`, with **Show in folder**
     fallback). Handles Chrome's "dangerous file" prompt via `acceptDanger`.
  3. **Connect** — a live poller detects the moment the app is running and
     **auto-starts pairing**; the user just clicks **Allow** in the app once.
  4. **Done** — links to the dashboard / "go apply to a job".
- The wizard's poller drives everything: no matter *how* the app gets installed
  (our button, or the user runs the file themselves), the page auto-advances to
  Connect → Done the instant the app is up.
- **Popup** routes not-yet-connected users to the wizard with a prominent
  **"Set up the app →"** card (and **"Open the app"** when it's installed but
  closed).
- **`jat11://` protocol** — the desktop app registers it
  (`setAsDefaultProtocolClient` + electron-builder `protocols`), so the
  extension can *launch* the installed app (popup/wizard "Open the app"),
  instead of telling the user to find it in the Start Menu.
- New SW messages: `get-installer-url`, `launch-app`, `open-onboarding`.
- New permission: `downloads.open` (lets the extension run the downloaded
  installer).

## The one honest limit

A Chrome extension **cannot silently execute an .exe** — that's a hard browser
security boundary. The flow gets as close as the platform allows: one click to
download, one click to run the installer, then fully automatic detect + pair.

## Distribution prerequisite (for the cloud download button to fetch bytes)

The wizard's **Download** button pulls the installer from a **public** GitHub
Release (`chrome.downloads` of `JAT-v11-setup.exe`). For that to work for other
people:

1. A **v11 release must be published** with the installer asset.
2. The release repo must be **public** (private-repo assets aren't anonymously
   downloadable).

Until then the wizard degrades gracefully: it shows a "couldn't fetch — open
the downloads page" fallback and still auto-connects once the app is installed
by any means.

### Building the installer locally
`npm run build:win` (from `app/`) produces `dist/JAT-v11-setup.exe`. On this
machine it currently needs **Windows Developer Mode ON** (Settings → Privacy &
security → For developers) **or** an **Administrator** PowerShell — electron-
builder's bundled signing helper extracts macOS symlinks, which a normal user
can't create. In CI (GitHub Actions) it builds with no such issue.
