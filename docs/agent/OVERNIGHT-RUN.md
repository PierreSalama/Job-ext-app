# The overnight run — 2026-09-07

Set up at 02:50 laptop time, unattended, on `pierre-laptop`. Nothing here depends on a Claude
session staying alive: the run is driven by the laptop's own scheduled tasks and records itself
to disk.

## Read the result in the morning

```
node tools/overnight-report.mjs
```

Outcomes, per-provider AI deltas, continuity (gaps, app/extension downtime) and where the time went.

## What was changed to make the run possible

| setting | was | now | why |
|---|---|---|---|
| `ai.order` | `remote, chatgpt, claude, local` | `claude, chatgpt, local, remote` | **remote had 0 successes in 23,386 calls** and cost 11.0s on every one. It is Pierre's PC, which is not running JAT. Moving it last removed ~11s from every AI call. Measured before/after in `/ai/usage.recent`. |
| Codex | quota-blocked | working | The block was real but **cached in memory with `until: Oct 5`**, so it could never self-clear. The CLI was tested directly (`codex exec` returned `PONG`) and the app was restarted to drop the stale block. |
| `dailyCap` / `maxPerDay` | 5 | 40 | 5 was a smoke test. |
| `maxPerHour` | 5 | 8 | At 5/hr the pacer spread dispatches to one per 12 minutes and the first test looked dead when it was only waiting. |
| `safety.*.quiet` | 23:00–07:00 | 04:00–06:00 | An 8-hour quiet window makes an overnight test impossible. **The per-platform limits — the actual anti-ban protection — were left untouched**: LinkedIn 35/day, 6/hr, 2-min gap; Indeed 60/day, 10/hr, 1-min gap. |

## Moving parts on the laptop

| task | what it does |
|---|---|
| `JAT App Keeper (7744)` | keeps the app up against `jat11-app-pierre`, verified by token |
| `JAT Chrome Keeper (real profile)` | restarts Chrome if it dies; never kills a live one (it holds the LinkedIn session) |
| `JAT-Remote-Bridge` | session-1 control surface on :7749 |
| `JAT Overnight Monitor` | **new** — one JSON line every 5 min, and restarts the app if it finds it down |

### The monitor died silently on its first install

A `-Once` trigger with a `RepetitionInterval` and **no `RepetitionDuration`** expired after three
samples and Windows deleted the task. The log stopped at 02:53 and nothing reported it. Caught only
because the task list was re-checked; had it not been, the overnight test would have produced
fifteen minutes of data and looked complete. It now uses a **daily** trigger with an explicit
`PT5M for P1D` repetition plus a logon trigger, so an expiry can cost at most one day.

## First results, 02:49–02:51

- `Bevertec — Software Engineer` **submitted and verified**
- `Barber-OS Technologies — Full Stack Developer` **parked, "needs 1 answer(s)"** — correct escalation
- AI: `claude-cli` only, 2 calls, 2 ok. No remote hop, no codex hop.

## Dad's lane — prepared, not started

Simultaneous running needs a second, fully separate stack. Most of it already exists:

| piece | state |
|---|---|
| app instance on **:7745**, data dir `jat11-app-dad` | exists, not running |
| Chrome profile `cft-profile-dad` | exists |
| extension `chrome-extension-dad` | **updated 11.89.1 → 11.154.0** (backup `.bak-11.89.1`) |
| `run-supervisor.ps1`, `login-dad.ps1` | exist |
| `JAT Dad Instance` scheduled task | **Disabled** |

Pierre's lane uses the **real default-profile Chrome**; Dad's cannot share that, so his runs on the
Chrome-for-Testing binary with its own `--user-data-dir` and `--load-extension`. That path is proven
on this box.

**The one thing no agent can do: log Dad into LinkedIn.** A real one-time interactive login is the
only session that survives (`run-supervisor-pierre.ps1` says so explicitly). Do that with
`login-dad.ps1` on the laptop, then enable `JAT Dad Instance`.

It was deliberately not started tonight — a second Chrome and a second app competing for the same
machine during the first real overnight test would make the results unreadable.
