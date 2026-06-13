# JAT v11 — Architecture

One source of truth: the Electron app owns all data (SQLite) and all AI calls.
The extension captures and executes in pages; both dashboards are pure REST/SSE
clients of the app.

```
┌────────────────────────── Chrome ───────────────────────────┐
│ content/loader.js (every frame, permanent, tiny)            │
│   └─ lazy → detector.js ── signals/* ── sites/* ── panel.js │
│              └─ executor.js (auto-apply) ── autofill.js     │
│ background.js (SW): RPC, webNavigation reboots, offline     │
│   queue, badge, update checks, auto-apply dispatcher        │
│ app/ (dashboard SPA — also mirrored into the desktop app)   │
└──────────────┬───────────────────────────────────────────────┘
               │ REST + SSE on 127.0.0.1:7744 (X-JAT-Token)
┌──────────────┴───────────────────────────────────────────────┐
│ Electron app: main.js (tray, hotkey, updater, notifications) │
│   server.js (routes, SSE broadcast, pairing, pacing)         │
│   db.js (SQLite: jobs/events/settings/qa/profiles/documents/ │
│          auto_apply_tasks/ai_log/kv; migrations; backups)    │
│   ai/ (provider chain: codex → ollama; prompts; extract)     │
│   gmail.js (OAuth loopback, watermark sync, classifier)      │
└───────────────────────────────────────────────────────────────┘
```

## Ports & security

- `127.0.0.1:7744` — only network surface. Host-header checked (anti
  DNS-rebinding). Every route except `GET /health` and `POST /pair` requires
  `X-JAT-Token` (or `?token=` for `/stream` EventSource).
- Token: generated at first run (kv table). Electron renderer gets it via
  preload IPC (`window.jatDesktop.boot()`); the extension gets it once via
  `POST /pair`, which pops a native consent dialog.
- Ollama on `:11434` and the Codex CLI are reached only from the app process.

## REST contract (server.js)

| Route | Notes |
|---|---|
| `GET /health` | unauthenticated; `{ok, version, ts}` |
| `POST /pair` | consent dialog → `{token}` |
| `GET/POST /jobs`, `GET/PATCH/DELETE /jobs/:id` | upsert dedups by (source,externalId) → normalized URL → normalized title+company; `_manual:true` bypasses dedup; PATCH: `null` clears, missing keeps |
| `GET /events?jobId=`, `GET /events/recent`, `POST /events` | timeline |
| `GET /stats` | totals, byStatus, bySource, needsReview |
| `GET/PATCH /settings` | sections deep-merged over config.js defaults |
| `GET/POST /qa`, `POST /qa/lookup`, `DELETE /qa/:id` | learned answers (fuzzy ≥0.6) |
| `GET/POST /profiles`, `GET /profiles/for-source`, `DELETE /profiles/:id` | named profiles w/ per-source assignment |
| `GET/POST/PATCH/DELETE /documents`, `GET /documents/:id?raw=1\|?text=1` | base64 upload → file in userData/documents + extracted text (pdf-parse/mammoth) |
| `GET /queue`, `GET /queue/next`, `POST /queue`, `PATCH/DELETE /queue/:id` | auto-apply tasks; `/queue/next` runs the pacing gate |
| `GET /ai/status`, `GET /ai/usage`, `POST /ai/generate` | provider chain health/meter/raw |
| `POST /ai/{fit-score,cover-letter,tailor-resume,answer-question,classify-email,summarize,follow-up,resume-parse,validate-capture}` | feature endpoints |
| `GET/POST /gmail/*` | status / auth-url / sync |
| `GET /export`, `POST /import`, `POST /backup` | data lifecycle |
| `GET /stream` | SSE: `jobs.updated`, `queue.updated`, `documents.updated`, `settings.updated` |

## Extension message types

SW ⇄ pages: `ping`, `app-health`, `pair-app`, `popup-state`, `check-app-update`,
`check-ext-update`, `download-app-installer`, `capture-now`, `pipeline-event`,
`qa-record`, `api-call` (generic authenticated proxy), `task-progress`,
`get-token`, `get-document` (binary→base64 for resume upload).
SW → tabs: `jat11.reboot` (webNavigation SPA fix), `jat11.capture-now`,
`jat11.run-task`.

## Capture pipeline

loader (plausibility sentinel, suppress list) → detector `evaluate()`
(JSON-LD + URL/title/DOM scores + site-pack overlay + cross-tab handoff) →
stages `detected → started (Apply click) → progressing (resume/answers) →
submitted (click/pointerdown/success-text/success-URL/ticker)` → SW
`pipeline-event` → `POST /jobs` (offline → storage queue, badge shows count).
Panel is invisible until `started` unless `capture.panelOnDetect`. Mid-confidence
pages ask once; "Not a job" suppresses the host forever. Captures missing
title+company persist with hostname fallbacks + `needsReview`.

## AI chain

`provider.run({kind, prompt, system, schema, prose})`:
order `cloud-first` → codex (`codex exec --json --ephemeral
--ignore-user-config --output-schema …`, CLI discovered via
`~\.codex\chrome-native-hosts.json`, auth = ChatGPT subscription) → on
failure → ollama (`POST /api/chat` with the same JSON Schema in `format`;
spawns `ollama serve` once if down) → error. Every call logged to `ai_log`.
Defaults hardcoded in `config.js`, overridable in Settings → AI.

## Auto-apply queue

States: `queued → scheduled → running → awaiting_review | awaiting_input |
done | failed | skipped`.
The app's `/queue/next` enforces pacing (master switch, active window, daily/
hourly caps, randomized 8–25 min gaps). The SW polls it once a minute, opens
the job's tab in the background, and hands the task to executor.js, which:
fills from profile → learned qa → AI (`/ai/answer-question`, confidence-gated,
refusal-aware; legal/EEO questions never AI-answered) → attaches the default
resume via DataTransfer → advances steps (synthetic pointer chain + DOM-hash
wait) → **review mode (default)**: stops at the final submit and notifies;
auto mode submits. CAPTCHA/login → `awaiting_input`. Everything lands in the
task transcript; overlay always shows Pause/Stop/Esc.

## Mirror & release

Dashboard authored in `extension/app/**` → `tools/mirror.mjs` copies to
`app/src/app/**`; CI `--check` gate. `tools/release.ps1` bumps both versions
in lockstep, mirrors, syncs to `..\.v10-publish`, tags `v11.x.y` → CI builds
installers → electron-updater + popup download distribute them.
