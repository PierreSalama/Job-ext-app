# v11.19.0 Teach & Correct — live-test bugs (Pierre, 2026-06-16)

Reported from the first hands-on test of the Teach & Correct release. **Likely
linked: B1 (connection) may root-cause B2 and B3** — no app connection ⇒ Watch &
teach can't pull a job ⇒ recorder can't post captures.

## B1 — Extension keeps asking to connect the app
The popup keeps showing the Connect/pairing prompt even after connecting — the
paired/connected state isn't sticking. Suspects: app crashing/restarting on a new
v10/route (health check then fails → re-prompt), a version mismatch (extension
auto-updated to 11.19.0 via CWS while the app may be older), or the pairing token
not persisting. **Diagnose first — probably the cascade root.**

## B2 — "Watch & teach" enters "watching" then reverts to "Start"
The button shows a working state then flips back to Start — the supervised run
doesn't actually start. Likely: `watchAndTeachOne` pulls `/queue/next?force=1`
and gets NOTHING (empty queue / app down) so it returns immediately. Fixes:
(a) if connection is the cause, B1 fixes it; (b) make Watch & teach supervise the
job in the CURRENT active tab when the queue is empty (more useful than requiring
a queued job); (c) surface a clear "no job queued — open a job posting first"
instead of a silent revert.

## B3 — Teach Mode on, but no visible difference
Toggle on (popup or floating `● Teaching`), but no "captured ✓" toasts / nothing
recorded. Suspects: recorder only boots inside a `detectApplyForm`-detected apply
context (detection misses the page → never boots), the teachMode flag not read,
or B1 (posts dropped when disconnected so nothing persists — though the toast is
client-side and should fire on capture). Verify the recorder boots + the toast
fires independent of the app being up.

## B4 — Glassdoor didn't attach the résumé (a couple of times)
On Glassdoor applies the résumé wasn't picked up. Suspects: the Glassdoor
adapter's `resumeNameSelectors` / the executor's file-upload detection doesn't
match Glassdoor's upload control, or the résumé file isn't passed for the
glassdoor source/external-ATS handoff. Verify the upload path on Glassdoor + the
external-redirect case.

---
Fix all four → ship a new version (auto-publish to CWS).
