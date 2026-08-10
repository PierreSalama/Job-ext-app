# Moving the applier off Chrome-for-Testing onto Pierre's real Chrome

Status: **investigated 2026-08-10, not shipped.** Everything below was measured on `pierre-laptop`,
not assumed. One failure is unresolved and it is the blocker.

## Why we tried

Pierre's instruction: stop juggling separate browser profiles (an artefact of running Dad's search
on the same laptop) and just use the Chrome he is already signed into.

It is also the right instinct for the ban problem. An unbranded testing build driving a throwaway
profile is close to the platonic shape of "bot"; real Chrome with a real profile is not.

## The four constraints, all verified

| # | Constraint | Evidence |
|---|---|---|
| 1 | **App-Bound Encryption** (Chrome 127+) seals cookies to the branded binary. A copied profile decrypts to **nothing**. | All 1,656 cookies are `v20`, `app_bound_encrypted_key` present. After copying, Chrome reported `CHROME_SEES_TOTAL_COOKIES=0`. |
| 2 | **No CDP on the default profile** (Chrome 136+), over port *and* pipe. | Port: never attached. Pipe: `Target.setDiscoverTargets timed out`. |
| 3 | `--load-extension` was dropped in branded Chrome 137+, but `--disable-features=DisableLoadExtensionCommandLineSwitch` re-enables it. | JAT service worker `fignfifoniblkonapihmkfakmlgkbkcf` loaded into branded 151. |
| 4 | A **fresh** profile does not honour `--load-extension` at all. | `service_workers=0` headless *and* headful on a new profile; a profile seeded with Pierre's `Preferences`/`Secure Preferences` did load it. Chrome 137+ requires developer mode, which a new profile lacks. |

Together, (1) and (2) mean the existing session **cannot be moved or driven in place** — it can only
be created inside a profile the applier owns. That is why "just use the cookies that are already
there" cannot work, however many times one signs in.

## The blocker

Extension loading is **not stable across launches of the same profile**:

```
run 1   A(spawn+port)        service_workers=1   loaded
        B(puppeteer+pipe)    service_workers=0   missing
run 2   A(spawn+port)        service_workers=0   missing      <- same profile, same flags
        B(puppeteer+pipe)    service_workers=0   missing
```

The first hypothesis — that puppeteer's own `--disable-features` overrides ours, since Chrome keeps
only one such list — is plausible and matches run 1, but run 2 falsifies it as the whole story:
`ignoreDefaultArgs: ['--disable-features', '--disable-extensions']` did not restore loading, and the
spawn+port path that had worked stopped working too.

The remaining hypothesis, untested: **Chrome persists an extension-disable decision into the profile
on exit** (the developer-mode/unpacked-extension lockdown), so a profile loads the extension once
and never again. If true, the fix is to reset the relevant `extensions.*` preference state before
each launch, or to force-install the extension by policy instead of `--load-extension`.

## What to do next

1. Diff the profile's `Preferences` / `Secure Preferences` before and after a launch to find the key
   that flips. That single diff decides the whole approach.
2. If it is a preference: reset it pre-launch, or set the `ExtensionInstallForcelist` policy with a
   locally-hosted CRX, which sidesteps developer mode entirely.
3. Only then switch `run-supervisor-pierre.ps1` to `chrome.exe` +
   `C:\ProgramData\JAT-Remote\chrome-profile-pierre`, and have Pierre sign in **once** in that
   profile via `login-pierre-chrome.ps1`.

Until step 1 is answered, the node stays on Chrome-for-Testing, which works.

## Assets already in place on the laptop

- `C:\ProgramData\JAT-Remote\chrome-profile-pierre` — preference-seeded, extension-ready, no session
- `C:\ProgramData\JAT-Remote\cft-supervisor\login-pierre-chrome.ps1` — one-time sign-in for it
- `isolate-launch.mjs`, `headless-ext-test.mjs`, `abe-check.ps1`, `find-profiles.ps1` — the probes
  behind every number above
