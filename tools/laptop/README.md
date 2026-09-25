# Laptop control surface

Everything needed to drive the applier laptop (`pierre-laptop`, 100.104.86.34) without touching it
by hand. Built 2026-09-06.

## What was already there

SSH is open on :22 and the key is `~/.ssh/jat_nodes` — `laptop@100.104.86.34`, Administrator. Earlier
sessions described copying files "over Tailscale SSH" as a chore; it is one command and always was.

## What SSH cannot do

A Windows SSH session is **session 0**, which has no desktop. Measured:

- a screenshot returns a blank 1024x768 buffer and a `Win32Exception`
- Chrome launched from there starts, fails to create a window, and exits within seconds

Anything touching the screen or the browser has to run in **session 1**. That is what the bridge is.

## The pieces

| file | runs where | what it does |
|---|---|---|
| `jat-bridge.ps1` | laptop, session 1 | token-gated HTTP on :7749 — `/health` `/screen` `/exec` `/click` `/type` `/shutdown` |
| `install-bridge.ps1` | laptop | registers the bridge as a logon task (interactive, highest) and firewalls :7749 to `100.64.0.0/10` |
| `deploy-ext.ps1` | laptop, **via the bridge** | backs up, installs `ext-stage` into `chrome-extension-pierre`, restarts Chrome from session 1, verifies |
| `cdp-chrome.ps1` | laptop, via the bridge | a dedicated Chrome-for-Testing on its own profile with CDP on :9223 and the JAT extension loaded |
| `cdp.mjs` | laptop | dependency-free CDP driver (Node 24 has a global `WebSocket`): `targets`, `open`, `title`, `shot`, `eval` |
| `../deploy-ext-laptop.mjs` | this PC | the one command: stage → install → prove |

## Ports

| port | owner |
|---|---|
| 7744 | JAT app, **Pierre's** data dir (`jat11-app-pierre`), verified by token in `laptop-app-keeper.ps1` |
| 7745 | Dad's JAT app — **do not bind here**, the bridge squatted on it once |
| 7746 | Pierre's old CfT-lane app (that lane is dead) |
| 7749 | the bridge |
| 9223 | CDP Chrome, loopback only |

## Chrome facts that cost time to learn

- **Chrome 152 ignores `--load-extension` outright.** Measured: only its 3 built-in component
  extensions install. Use the Chrome-for-Testing binary in `.cft-cache` for anything that needs it.
- **Chrome 136+ refuses `--remote-debugging-port` on the default profile.** Passing the default path
  explicitly does not help; the check is on the path.
- **Moving a profile destroys its Secure Preferences MACs.** Chrome strips the protected values —
  `developer_mode`, the extension's `location=4` — and disables the unpacked extension with
  `disable_reasons=16777216`. So the real profile cannot be moved to gain CDP. Use a second profile.
- The live applier is Pierre's **real default-profile Chrome** with the extension registered
  in-profile (`location=4`), kept alive by `C:\Users\laptop\chrome-keeper.ps1`. The Chrome-for-Testing
  lane and its `sync-extension.ps1` are **dead** — "JAT Pierre Applier" has been Disabled since
  2026-08-22.
