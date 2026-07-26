// One-off recovery for the anchor-opener bug (fixed in 11.88.8).
//
// findEasyApplyButton() scanned only buttons and role="button", so LinkedIn job views whose Easy
// Apply control is a plain <a> matched NOTHING and hit the executor's TERMINAL "no opener on a
// visible tab" branch: state=skipped, non-retriable, never re-dispatched. Those are real Easy
// Apply jobs that were thrown away. This requeues them so the fixed executor gets a second look.
//
// Hand-verified 4 of them live in Chrome (old selector 0 matches / new selector 1 anchor):
//   4420497662 Paymentus            -> Easy Apply anchor present   RECOVERABLE
//   4441351444 Hawk Consulting      -> Easy Apply anchor present   RECOVERABLE
//   4440635465 RHP Properties       -> Easy Apply anchor present   RECOVERABLE
//   4425263780 MDI Worldwide        -> no apply control at all     genuinely not Easy Apply
//
// It requeues ALL of them rather than only a verified subset, on purpose. The costs are asymmetric:
// re-checking a genuinely-external posting costs one fast skip (the executor still has its positive
// external signals and its terminal branch), while leaving a real one skipped loses the job for
// good. Hand-verifying all 67 would mean 67 more LinkedIn page loads, which is its own risk.
//
// RUN ORDER MATTERS. Do not run this until BOTH are true, or it just re-burns the same jobs:
//   1. the extension has been reloaded so 11.88.8 is actually live (content-script fixes do NOT
//      reach a running Chrome on their own -- verified: the 11.88.6 and 11.88.7 fixes sat inert);
//   2. LinkedIn's daily Easy Apply cap has reset (rolling ~24h; the cap modal was confirmed live
//      on 2026-07-20 after 32 submissions).
//
// Usage:  node tools/requeue-anchor-skips.mjs <token-file>          # dry run (default)
//         node tools/requeue-anchor-skips.mjs <token-file> --go     # actually requeue
import fs from 'node:fs';

const TOKEN = fs.readFileSync(process.argv[2], 'utf8').trim();
const DRY = process.argv[3] !== '--go';
const api = async (p, opts = {}) => (await fetch('http://127.0.0.1:7744' + p, {
  ...opts,
  headers: { 'X-JAT-Token': TOKEN, 'content-type': 'application/json', ...(opts.headers || {}) },
})).json();

const health = await api('/health').catch(() => null);
if (!health?.ok) { console.error('app is not reachable on 127.0.0.1:7744 — start it first'); process.exit(1); }

const q = await api('/queue?state=skipped');
const candidates = (q.items || []).filter((t) => {
  const src = String(t?.job?.source || '').toLowerCase();
  const err = String(t?.lastError || '');
  return src === 'linkedin' && /no Easy Apply on this posting/i.test(err);
});

// NEVER requeue an application that was already SENT. A row can carry verified submission evidence
// while sitting in a non-done state (2026-07-20: a pause and an earlier recovery script rewrote five
// real submissions to 'skipped'), and requeuing one of those re-applies to that employer. The lean
// /queue payload omits submissionEvidence, so each candidate is re-fetched individually — checking
// the list payload alone would silently pass them through.
//
// db.js now refuses to move a verified submission out of 'done' at the storage boundary, so this is
// the second line of defence, not the only one. It stays because a tool that mass-patches the queue
// should not depend on a guard living somewhere else.
const targets = [];
let alreadySent = 0;
for (const t of candidates) {
  const full = await api('/queue/' + encodeURIComponent(t.id));
  const ev = full?.task?.submissionEvidence;
  const evStr = typeof ev === 'string' ? ev : JSON.stringify(ev || '');
  if (/"type"\s*:\s*"verified"/.test(evStr)) { alreadySent++; continue; }
  targets.push(t);
}
if (alreadySent) console.log(`skipping ${alreadySent} row(s) that already carry a VERIFIED submission — those applications were sent`);

console.log(DRY ? '=== DRY RUN (pass --go to apply) ===' : '=== REQUEUEING ===');
console.log('LinkedIn postings terminal-skipped as "external":', targets.length);
for (const t of targets.slice(0, 8)) console.log('  ', t.job?.company, '|', t.job?.jobUrl);
if (targets.length > 8) console.log('   … and', targets.length - 8, 'more');

if (!DRY) {
  let ok = 0;
  for (const t of targets) {
    const r = await api('/queue/' + encodeURIComponent(t.id), {
      method: 'PATCH',
      body: JSON.stringify({
        state: 'queued',
        lastError: null,
        parkReason: null,
        attempts: 0,   // the old terminal skip should not count against the retry cap
        transcriptAppend: {
          note: 'requeued: skipped as "external" by the anchor-opener bug (LinkedIn renders Easy Apply '
              + 'as an <a> with no role/aria-label, which findEasyApplyButton did not scan) — fixed in 11.88.8',
        },
      }),
    });
    if (r?.ok) ok++;
  }
  console.log('requeued:', ok, '/', targets.length);
}
