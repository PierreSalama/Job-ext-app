# Code signing & the Windows SmartScreen warning

## The honest situation

When someone downloads `JAT-v11-setup.exe` and runs it, Windows SmartScreen shows
**"Windows protected your PC … unknown publisher"** and they have to click
*More info → Run anyway*. That warning exists because the installer is **not
code-signed**.

There is **no purely-free, instant way to remove it.** A trusted signature
fundamentally requires a code-signing certificate issued to a verified identity,
and the CAs that issue them (DigiCert, Sectigo, etc.) charge money. Anyone who tells
you otherwise is either describing a self-signed certificate (which does **not** help
— see below) or a paid product.

What *is* achievable for free, and what this repo is now set up for:

| Option | Cost | Removes "unknown publisher"? | Clears SmartScreen instantly? |
|---|---|---|---|
| **SignPath Foundation** (free OSS cert) | Free (OSS only) | ✅ Yes | ❌ Reputation builds over downloads/time |
| Self-signed cert | Free | ❌ No (not a trusted CA) | ❌ No |
| Paid OV cert | ~$200/yr | ✅ Yes | ❌ Builds over time |
| Paid **EV** cert | ~$300–500/yr | ✅ Yes | ✅ Yes, day one |
| Do nothing (unsigned) | Free | ❌ No | ❌ No |

**Self-signing is a trap for this use-case:** a self-signed certificate is not chained
to a trusted root on other people's machines, so SmartScreen still flags it (and the
publisher still shows as untrusted). It only helps if each user manually installs your
certificate into their Trusted Root store — which no real user will do. So we do **not**
ship a self-signed installer.

## The recommended free route: SignPath Foundation

[SignPath Foundation](https://signpath.org/) issues **free code-signing certificates to
open-source projects** and signs your release artifacts in their cloud. The signature
chains to a trusted CA, so the **"unknown publisher" line goes away**. SmartScreen
*reputation* still accrues over downloads (only a paid EV cert skips that), but signing
is the prerequisite for reputation to build at all, and it removes the scariest part of
the warning immediately.

**What only you can do (I can't do these for you):**

1. **Make the source repo public + open-source.** SignPath Foundation only covers OSS.
   The app is already MIT-licensed (`app/package.json`), so the licensing is fine — the
   repository just has to be public and reviewable.
2. **Apply at <https://signpath.org/apply>** for the Foundation (free) tier. They review
   the project; approval is manual and not instant.
3. Once approved, create a SignPath **project** + **signing policy** (release-signing),
   and add the project/organization/policy slugs + an API token as GitHub repo secrets.

> ⚠️ **electron-updater + SignPath ordering caveat:** `electron-updater` verifies the
> installer's SHA-512 against `latest.yml`. If SignPath signs the `.exe` *after*
> electron-builder has already written `latest.yml`, the hash won't match and
> auto-update will reject the download. With SignPath you must either sign via
> electron-builder's `win.sign` hook (so `latest.yml` is generated from the signed
> binary) or regenerate `latest.yml` after signing. See SignPath's electron-builder
> guide. This is why SignPath is documented here but not wired live yet — it needs the
> approved project before it can be set up and tested end-to-end.

## If you ever do hold a certificate file (.pfx)

The CI is **already wired** for the standard electron-builder signing path. The moment
these two GitHub **repository secrets** exist, the Windows build signs itself with no
code change (see `.github/workflows/release.yml`):

- `CSC_LINK` — the certificate, base64-encoded: `base64 -w0 cert.pfx` (or
  `[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx'))` in PowerShell).
- `CSC_KEY_PASSWORD` — the password that unlocks the `.pfx`.

Signing is scoped to the Windows build leg, so a Windows cert is never handed to the
mac/linux signers. With the secrets absent, the build is simply unsigned (no error).
Timestamping is handled automatically by electron-builder, so signatures stay valid
after the certificate expires.

This same path works with an EV cert delivered as a cloud-HSM `.pfx`/token if you ever
decide the instant-trust day-one experience is worth paying for.

## Free trust measures already shipped (no cert needed)

- **SHA-256 checksums.** Every release publishes `SHA256SUMS.txt`. A cautious user can
  verify the download with `Get-FileHash JAT-v11-setup.exe -Algorithm SHA256` (PowerShell)
  and compare — proof the binary wasn't tampered with in transit.
- **Stable publisher identity + consistent installer name** across releases, so whatever
  SmartScreen reputation does accrue sticks to one identity instead of resetting.
- **Submit the installer to Microsoft** for analysis at
  <https://www.microsoft.com/en-us/wdsi/filesubmission> — a free way to nudge SmartScreen
  reputation along for a clean unsigned/signed binary.

## Bottom line

Until you complete SignPath enrollment (or buy a cert), the installer stays unsigned and
testers will see the SmartScreen prompt — that part is outside what the code can fix. The
pipeline is built so that the day a certificate exists, signing turns on by dropping in
secrets, with no further changes.
