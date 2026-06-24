# JAT v11 — Feature Map

_Full audit of the app + extension. Generated 2026-06-24 at v11.42.0._

Legend: **✅ fully working + tested** · **🟡 works, with caveats / partial** · **⬜ documented, not built**

Tally: **~62 ✅ · 14 🟡 · 7 ⬜**

---

## 1. Capture & detection — extension content scripts
| Feature | Status | Notes |
|---|---|---|
| Job-page detection | ✅ | `detector.js` + `signals/{forms,intent,json-ld,success}`, `lib/jobpage.js`; tests `detection`, `detector-flow` |
| SPA-navigation re-detect | ✅ | `background.js` webNavigation history/fragment events |
| Manual capture | ✅ | popup + context menu → `/jobs` |
| Applied-sync to app | ✅ | `applied-sync.js` |

## 2. Auto-apply executor — `extension/content/executor.js`
| Feature | Status | Notes |
|---|---|---|
| LinkedIn Easy Apply (full-page + modal) | ✅ | `lib/linkedin-apply.js`; tests `linkedin-apply`, harness |
| Form autofill (profile + learned) | ✅ | `autofill.js`; tests `fill-scope`, `fuzzy-option` |
| Screening answers (deterministic + AI) | ✅ | tests `screening-answer` |
| Submit success-truth verification | ✅ | `signals/success.js`; tests `submit-truth`, `submit-quarantine` |
| Interstitial + opener-stall breakers | ✅ | `lib/interstitial.js`, `lib/opener-stall.js`; test `opener-stall` |
| AI apply-rescue (token-bounded) | ✅ | escalation gate + 60s dedup + prompt-size cap |

## 3. External handoff — LinkedIn/Indeed → company site
| Feature | Status | Notes |
|---|---|---|
| Same-tab handoff (host/path detect) | ✅ | `background.js` `waitForExternalTarget` + `replay.externalTargetFromNav`; test `breaker-reset-nav` |
| New-tab child adoption | ✅ | SW `runExternalHandoff`; harness `linkedin-handoff` |
| Popup `window.open` URL recovery | ✅ | MAIN-world hook → `chrome.tabs.create`; harness `indeed-popup` |
| Live LinkedIn→offsite handoff | 🟡 | harness-proven; real throttle/cross-origin is a post-deploy watch item |

## 4. ATS adapters — `extension/content/sites/`
| Feature | Status | Notes |
|---|---|---|
| Lever · Greenhouse · Ashby (auto-submit) | ✅ | tests `external-ats`, harness |
| BambooHR (fill + park) | 🟡 | CAPTCHA-gated → parks `awaiting_review` |
| Workday · iCIMS · Taleo (park) | 🟡 | account/login wall → parks before fill |
| Generic unknown-ATS drive | 🟡 | account-wall/form-root/honeypot hardening partially spec'd |

## 5. Worker pool & windows — `extension/background.js`
| Feature | Status | Notes |
|---|---|---|
| Serial + parallel pool (concurrency 1–3) | ✅ | site-spread keeps workers on distinct sites |
| Window tiling (no occlusion-throttle) | ✅ | `lib/window-place.js`; test `window-placement` |
| Front-to-hydrate + tab reaper | ✅ | reactive, self-releasing |
| Per-host circuit breaker | ✅ | `lib/host-breaker.js` |

## 6. Discovery — `app/src/discovery/` (JobSpy) + `extension/lib/search-url.js`
| Feature | Status | Notes |
|---|---|---|
| JobSpy: LinkedIn · Indeed | ✅ | test `discovery-provider` |
| Google Jobs | 🟡 | `google_search_term` fixed; JobSpy scraper often returns empty live |
| Glassdoor · ZipRecruiter | 🟡 | supported but bot-walled / IP-blocked → empty without residential proxies |
| Self-throttle (anti-freeze) | ✅ | `runTick` time-gate; fixed the subprocess storm |
| Keyword×location rotation + freshness | ✅ | `lib/freshness.js`; tests `search-url`, `freshness-ramp` |

## 7. Apply engine (queue/pump) — `app/src/server.js`
| Feature | Status | Notes |
|---|---|---|
| Pacing + caps + daily soft-cap | ✅ | tests `apply-cap`, `daily-cap` |
| Relevance filter (whole-word excludes) | ✅ | `jobFit`; test `autoapply-policy` |
| Site-spread concurrency | ✅ | `taskSiteKey` + active-site dedup |
| Retry-stale self-heal | ✅ | watchdog re-queues retriable failures |
| Terminal-integrity + submit quarantine | ✅ | tests `terminal-integrity`, `submit-quarantine` |

## 8. AI provider chain — `app/src/ai/`
| Feature | Status | Notes |
|---|---|---|
| Codex CLI (ChatGPT subscription) | ✅ | `ai/codex.js`, secure subprocess |
| OpenAI / Anthropic API fallback | ✅ | `ai/openai.js`, `ai/anthropic.js` |
| Deterministic floor | ✅ | `ai/deterministic.js`; test `ai-deterministic` |
| Prompt library | ✅ | fitScore, answerQuestion, applyRescue, classifyEmail, pickEmailJob, coverLetter, tailorResume, followUp, resumeParse; test `prompts` |
| Claude Code CLI | 🟡 | 401 on this machine (not signed in) — falls through |
| Ollama (local) | 🟡 | not installed → skipped |
| Vision (screenshot→AI) | ⬜ | deferred; only working provider is text-only |

## 9. Apprenticeship engine — learn from the user
| Feature | Status | Notes |
|---|---|---|
| Observer (nav recorder) | ✅ | tests `observer-nav`, `observer-answers` |
| Distiller → Replayer (recipes) | ✅ | tests `distill-selectors`, `recipe-replay`, `recipe-transfer` |
| Reward engine + ranking | ✅ | tests `reward-match`, `rank-punish` |
| Teach & Correct (Control Studio) | ✅ | tests `teach-*`, `control-studio`, `recorder` |
| GGUF weight assets | ⬜ | design complete; weights not published |

## 10. Profile & memory — `app/src/db.js`, `resumefields.js`
| Feature | Status | Notes |
|---|---|---|
| Profile + documents library | ✅ | folder watch, default résumé |
| Learned memory (fields + Q&A, per-profile) | ✅ | test `profile-memory` |
| Profile ↔ memory bridges | ✅ | `/profile/from-memory`, `/to-memory` |
| Résumé field extraction | ✅ | tests `resume`, `resume-page` |

## 11. Email → pipeline — `app/src/{email,gmail}.js` (new this build)
| Feature | Status | Notes |
|---|---|---|
| Gmail OAuth + IMAP (app-password) sync | ✅ | live-connected; loopback desktop OAuth |
| Match: sender-domain · time · title | ✅ | test `email-match` |
| Thread / reply-chain trace-back | ✅ | `findJobByThread`; traces a reply to its original submission |
| AI disambiguation (bounded) | ✅ | `pickEmailJob`; never forces a match |
| Stage elevation + auto-create job | ✅ | `elevateJobFromEmail`, `ensureJobForConfirmation` |
| Classification (confirmation/assessment/interview/offer/rejection) | ✅ | reorder + whole-word fixes |
| Reprocess stored inbox | ✅ | `/emails/reprocess` one-shot |

## 12. Pipeline & dashboard — `app/src/app/app.js` (9 views)
| Feature | Status | Notes |
|---|---|---|
| Kanban pipeline (drag to change) | ✅ | + new Assessment stage |
| Status FSM | ✅ | `lib/status.js`; test `status` |
| Applications · Activity · Documents · Queue · Procedures · Profile · Settings | ✅ | mirrored extension/app ↔ app/src/app (byte-identical) |
| Punishments (skip job/company/type) | ✅ | test `rank-punish` |

## 13. Infra & distribution
| Feature | Status | Notes |
|---|---|---|
| REST + SSE server (:7744, token-auth) | ✅ | test `secrets` |
| SQLite (node-sqlite3-wasm) + migrations | ✅ | zero native deps |
| App auto-update (electron-updater + CI) | ✅ | GitHub Actions release pipeline |
| Backup · export · import · wipe | ✅ | `/backup`, `/export`, `/import`, `/wipe` |
| Extension CWS publish | 🟡 | blocked on the one-time Privacy-practices tab (manual, Pierre) |
| Firefox parity | 🟡 | capability-guarded, not exercised |

## 14. Safety & privacy
| Feature | Status | Notes |
|---|---|---|
| Secret sealing (safeStorage) | ✅ | tests `secrets`, `data-safety` |
| Credential write-boundary rail | ✅ | never persists passwords/EEO/payment to memory |
| Redaction in traces/exports | ✅ | test `redact-trace` |
| Never blind-submits | ✅ | submit only on verified-required-satisfied |

---

## Roadmap — documented, not built
1. **Playwright desktop-owned worker** (`AUTO-APPLY-EXTERNAL-RELIABILITY-PLAN.md` §5.1) — deliberately NOT pursued; chose surgical recovery (`CODEX-PLAN-REVIEW.md`).
2. **Vision rescue** (screenshot→AI) — `AUTO-APPLY-IMPROVEMENT-PLAN.md` §6; build only if live data shows visual-only failures.
3. **Workday / iCIMS / Taleo full automation** — currently park-only (account walls).
4. **Residential proxies** — revive Glassdoor / ZipRecruiter discovery.
5. **Long-tail ATS adapters** — reliability plan §6.8.
6. **GGUF weight assets** — apprenticeship engine.

## Standing caveats
- **Supply-bound**: LinkedIn + Indeed are the only reliable boards; throughput is limited by how many distinct postings discovery finds, not by pacing.
- **CWS auto-update dead until the Privacy-practices tab is filled once** — extension fixes reach Pierre via reload / the desktop app's own auto-update for app-side changes.
