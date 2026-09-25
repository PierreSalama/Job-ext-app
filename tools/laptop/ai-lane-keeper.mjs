// THE AI APPLY LANE HAS NO HEARTBEAT. THIS IS IT.
//
// The extension lane pumps itself: a Chrome MV3 alarm fires every 60 seconds, calls api.health(),
// and dispatches. It runs forever with nobody watching.
//
// The AI lane has nothing of the kind. `POST /ai-apply/start` is a one-shot, fired by a button on
// the AI Apply page or by whoever is at a terminal. Every one of the 15 runs in its history was
// started by hand. Measured 2026-09-08: 8,291 jobs tracked, 371 submitted, and the AI lane's
// contribution to that number is ZERO — not because it fails, but because nothing ever calls it,
// and because every run so far was `autonomy: 'prepare'`, whose goal text ends "then stop before
// submitting so he can review". It was never permitted to finish an application.
//
// Pierre asked for it to run 24/7 on the laptop alongside the extension lane, submitting for real.
// So: a supervisor that claims work, starts a run, waits for it, records the outcome, and repeats.
//
// HOW IT AVOIDS FIGHTING THE EXTENSION LANE
// queueNext (server.js) builds its candidate list from `db.queueList({ state: 'queued' })` and
// nothing else. So flipping a task to 'running' BEFORE starting the agent removes it from the
// extension's pool atomically, using the same claim primitive the executor itself uses. Two lanes,
// one queue, no double application.
//
// WHAT IT WILL NOT DO
//   * touch a job already resolved (submitted / rejected / offer / hired) — re-applying to a
//     company that has already answered is worse than not applying
//   * start a second run while one is live (the runner refuses anyway, with RUN_IN_PROGRESS)
//   * exceed its own daily cap, which is separate from the extension's — these runs spend Codex
//     and Claude subscription usage, not just page loads
//   * strand a task in 'running' if it crashes: every claim is released in a finally
//
// Usage:
//   node ai-lane-keeper.mjs --dry              plan only, claims nothing, starts nothing
//   node ai-lane-keeper.mjs --once             claim and run exactly ONE job, then exit
//   node ai-lane-keeper.mjs                    run forever
//   node ai-lane-keeper.mjs --audit           classify the whole queue and print it, touch nothing
//   node ai-lane-keeper.mjs --cap 40 --gap 90  daily cap, seconds between runs
//   node ai-lane-keeper.mjs --no-filter        take anything, including the CNC jobs. For testing only.

import { classify } from './role-fit.mjs';

const ARG = process.argv.slice(2);
const has = (f) => ARG.includes(f);
const val = (f, d) => { const i = ARG.indexOf(f); return i >= 0 && ARG[i + 1] ? ARG[i + 1] : d; };

const BASE = val('--base', process.env.JAT_BASE || 'http://127.0.0.1:7744');
const TOKEN = val('--token', process.env.JAT_TOKEN || '');
const PROFILE = val('--profile', process.env.JAT_PROFILE || '');
const DRY = has('--dry');
const ONCE = has('--once');
const AUDIT = has('--audit');
const FILTER = !has('--no-filter');
const DAILY_CAP = Number(val('--cap', '40'));
const GAP_S = Number(val('--gap', '90'));
const MAX_ATTEMPTS = Number(val('--max-attempts', '3'));
// HOSTS THAT WILL NOT LET THE AGENT IN. Measured 2026-09-08: the very first supervised run opened
// an Indeed posting and got Cloudflare "Additional Verification Required" (Ray ID a38248948c17ec72)
// before it could read a single field. The extension lane's breaker already holds indeed.com; this
// is the same refusal for the lane that has no breaker, so a queue that is 39/51 Indeed does not
// burn 39 Codex runs discovering the same wall 39 times.
const SKIP_HOSTS = new Set(String(val('--skip-hosts', ''))
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const RUN_TIMEOUT_MS = Number(val('--run-timeout', '1200')) * 1000;  // 20 minutes per application
// THE CHARACTER BUDGET IS WHAT WAS KILLING THE RUNS, NOT THE STEP CAP.
//
// Measured over 8 to 11 September: six runs completed, zero submitted, and FOUR of them ended
// stop=budget_chars at step 40 or 41 with the step cap set to 55. The app's default for an apply
// run is 750,000 characters and the agent was spending roughly nineteen thousand a step on these
// Ashby and Greenhouse forms, so it ran out of budget fifteen steps before it ran out of permission.
// The transcript renderer is already frugal (older steps condensed to one line, results clipped, one
// copy of any reference), so the fix is not to trim further, it is to stop cutting the run off
// mid-form. Passed as a limit from here so it needs no app release.
const MAX_CHARS = Number(val('--max-chars', '1400000'));
const POLL_MS = 15000;

// A job that has already been answered is off limits, whatever the queue still says.
const RESOLVED = new Set(['submitted', 'rejected', 'offer', 'hired', 'interview_1']);

const H = { 'x-jat-token': TOKEN, 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleString('en-CA', { hour12: false });
const log = (...a) => console.log(stamp(), ...a);

async function api(path, opts = {}) {
  // The laptop drops connections while Chrome is thrashing; a single refused socket is not an
  // outage and must not end a 24/7 supervisor.
  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(BASE + path, { headers: H, ...opts });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    } catch (e) { lastErr = e; await sleep(3000 * (i + 1)); }
  }
  throw new Error(`unreachable after 5 tries: ${path} (${lastErr && lastErr.message})`);
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

// The goal is the entire instruction the agent gets, so it carries the two things that have gone
// wrong before: inventing an answer it cannot support, and reporting a submission it did not make.
function buildGoal(job) {
  return [
    `Apply to this job posting for Pierre: ${job.jobUrl}`,
    '',
    `Role: ${job.title || '(unknown)'} at ${job.company || '(unknown)'}.`,
    '',
    'Fill every required field truthfully from his profile and answer bank. Where a question has no',
    'grounded answer in either, do not invent one — record a block and stop, rather than writing',
    'something he would have to defend in an interview.',
    '',
    // A DIFFERENT ROLE AT AN EMPLOYER Pierre has already touched is not a duplicate. The keeper's
    // own gate already dropped true repeats (same normalised title, or the same URL) before this
    // run was ever started. Without this paragraph the agent runs its own check_duplicate, sees any
    // row for the company, and refuses: 34 of 41 runs on 20 Sep ended 'Did not apply, duplicate
    // employer' after a full Chrome launch. Stating the policy here costs nothing and recovers them.
    'A duplicate means the SAME role: the same posting URL, or the same job title at the same',
    'employer. A different role at a company Pierre has already applied to is NOT a duplicate and',
    'you should apply to it normally. Only skip when check_duplicate shows the same title or URL.',
    '',
    'Then submit the application, and verify it actually went through by reading the page after the',
    'click. Do not report a submission you cannot see confirmed on the page.',
  ].join('\n');
}

// THE TWO LANES ARE NOT COMPETITORS, AND TREATING THEM AS ONE STARVED THIS ONE FOR THREE DAYS.
//
// Measured 8 to 11 September: the keeper looked only at state='queued' and picked nothing at all,
// while logging 735 idle ticks. The reason was not a bug in the filters. The extension lane pumps
// every 60 seconds and this keeper polls every five minutes, so the extension took every fresh job
// before the agent saw it, and the only thing left in 'queued' was Indeed, which walls the agent's
// browser. The AI lane was permanently eating the extension's leftovers, and the extension has no
// leftovers except the ones it cannot do.
//
// Which is the whole point it had been missing. The extension is fast, cheap and scripted, so it
// should have the easy forms. The agent is slow, expensive and reasons, so it should have the hard
// ones. On 11 September there were 370 non-Indeed tasks under three attempts sitting unresolved:
// 221 missing_info (a question with no grounded answer), 80 transient_page, 70 unknown_failure.
// That is a backlog of precisely the cases a reasoning agent is for.
//
// So: fresh work first if any is going, and otherwise the pile the executor could not finish.
const RETRYABLE = new Set(['missing_info', 'transient_page', 'unknown_failure']);
// Deliberately NOT retried here:
//   review_gate    — "probably submitted". Re-applying risks a duplicate under his own name.
//   submit_rejected — the page refused it; until the cause is known a retry just repeats it.
//   external_site  — the application is not on this page at all.

async function poolRows(which) {
  if (which === 'queued') {
    const r = await api('/queue?state=queued&limit=200');
    return r.body.items || r.body.tasks || [];
  }
  const rows = [];
  for (const state of ['failed', 'parked']) {
    const r = await api(`/queue?state=${state}&limit=400`);
    rows.push(...(r.body.items || r.body.tasks || []));
  }
  const retryable = rows.filter((t) => RETRYABLE.has(String(t.failureClass || t.lastFailureClass || '')));
  // Oldest failure first, so nothing sits at the back of the pile forever.
  retryable.sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
  return retryable;
}

// Try each pool in turn and fall through when a pool yields nothing USABLE, not merely when it is
// empty. The first version returned the queued pool whenever it had rows, so 36 Indeed tasks that
// were all going to be skipped stopped it ever reaching the 370-job retry backlog behind them.
async function pickTask() {
  const skipped = { noUrl: 0, attempts: 0, resolved: 0, wrongRole: 0, walledHost: 0, duplicate: 0 };
  let lastPool = 'queued';
  let lastCount = 0;

  for (const which of ['queued', 'retry']) {
    const rows = await poolRows(which);
    lastPool = which;
    lastCount = rows.length;
    // Oldest first: the queued list comes back newest-first, and a task that has waited longest
    // should go first for the same reason the extension lane works oldest-first.
    const ordered = which === 'queued' ? [...rows].reverse() : rows;

    for (const t of ordered) {
      const job = t.job || {};
      if (!job.jobUrl) { skipped.noUrl++; continue; }
      const host = hostOf(job.jobUrl);
      if (host && [...SKIP_HOSTS].some((h) => host === h || host.endsWith('.' + h))) { skipped.walledHost++; continue; }
      if ((t.attempts || 0) >= MAX_ATTEMPTS) { skipped.attempts++; continue; }
      if (RESOLVED.has(String(job.status))) { skipped.resolved++; continue; }
      // THE ROLE GATE. A run and Pierre's name are both finite; do not spend either on a structural
      // engineering posting that a search only surfaced because the title said "engineer".
      if (FILTER) {
        const fit = classify(job);
        if (!fit.fit) { skipped.wrongRole++; continue; }
      }
      // ASK THE LEDGER BEFORE SPENDING A RUN, NOT AFTER. Two of the first three live runs burned a
      // model call, a Chrome launch and two minutes each only to end with "already recorded as a
      // duplicate application". /ai-apply/engaged answers the same question in milliseconds.
      const q = new URLSearchParams({ company: job.company || '', url: job.jobUrl || '', title: job.title || '' });
      const dup = await api(`/ai-apply/engaged?${q}`).catch(() => null);
      // A SECOND ROLE AT THE SAME EMPLOYER IS NOT A DUPLICATE. This skipped on ANY hit for the
      // company, which on 17 Sep was dropping 100 of the 122 live retryable jobs - /ai-apply/engaged
      // flags every one of those sameRole:false. Skip only a true repeat: the same normalised title,
      // or the very same URL. ai-lane-selfcheck already uses sameRole as the real duplicate test.
      const dupHit = (dup && dup.body && Array.isArray(dup.body.items) ? dup.body.items : [])
        .find((x) => x.sameRole || String(x.matchedOn) === 'url');
      if (dupHit) { skipped.duplicate++; continue; }

      return { task: t, job, skipped, pool: which, count: rows.length };
    }
  }
  return { task: null, job: null, skipped, pool: lastPool, count: lastCount };
}

async function claim(taskId) {
  const { body } = await api(`/queue/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      state: 'running',
      transcriptAppend: { kind: 'claim', note: 'claimed by the AI apply lane (ai-lane-keeper)' },
    }),
  });
  return !!body.ok;
}

async function release(taskId, patch) {
  try {
    await api(`/queue/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  } catch (e) { log('  ! could not release the claim:', e.message); }
}

async function runsToday() {
  const { body } = await api('/ai-apply/status');
  const today = new Date().toLocaleDateString('en-CA');
  return (body.recent || []).filter((r) => r.started_at
    && new Date(r.started_at).toLocaleDateString('en-CA') === today).length;
}

async function waitForRun(startedAtMs) {
  // Poll until the runner reports no active run, or the per-application timeout expires. The run
  // record is the source of truth for what happened; `active` only says whether it is still going.
  while (Date.now() - startedAtMs < RUN_TIMEOUT_MS) {
    await sleep(POLL_MS);
    const { body } = await api('/ai-apply/status');
    const active = body.run || (body.running || [])[0] || null;
    if (!active) return (body.recent || [])[0] || null;
  }
  return { status: 'timeout', stop_reason: `no result within ${RUN_TIMEOUT_MS / 1000}s` };
}

// IS THE RUNNER FREE? ASK BEFORE CLAIMING, NOT AFTER.
//
// The header of this file claimed the keeper would never start a second run while one was live,
// "the runner refuses anyway". It does refuse — with a 409 — but by then the task has already been
// claimed and has to be released, and the next cycle does the identical thing sixty seconds later.
// Observed live 2026-09-08 22:04-22:06: three consecutive cycles claiming the same 7shifts task,
// getting 409, and releasing it, because a run orphaned by a previous supervisor was still in
// flight inside the app. A loop that makes no progress and logs an error every minute is worse than
// one that waits, so wait.
async function runnerBusy() {
  const { body } = await api('/ai-apply/status');
  const live = body.run || (body.running || [])[0] || null;
  return live || null;
}

// CAN ANY PROVIDER ANSWER RIGHT NOW, REALLY?
//
// /ai-apply/status serves a cached provider verdict. On 11 September that cache said
// codex=false claude=false canAnswer=false while a forced refresh one minute later said Claude was
// available and proven, and that Codex was merely quota-blocked until 3:43pm. Always force.
async function canAnswerNow() {
  const { body } = await api('/ai-apply/status?force=1');
  const p = body.providers || {};
  return {
    ok: !!p.canAnswer && !p.disabled,
    why: [
      p.codex && p.codex.available ? 'codex' : `codex:${(p.codex && (p.codex.quotaBlocked ? 'quota' : p.codex.lastError)) || 'down'}`,
      p.claude && p.claude.available ? 'claude' : `claude:${(p.claude && p.claude.reason) || 'down'}`,
    ].join(' '),
  };
}

// A run that never ends would make the wait above permanent, and a 24/7 service that waits forever
// is just a stopped service that logs. Anything older than the per-application timeout gets stopped
// so the lane can move on. Deliberately generous: a real application legitimately takes minutes,
// and killing a working run costs more than waiting out a stuck one.
let busySince = null;
// STOPPING A WEDGED RUN, FOR REAL.
//
// POST /ai-apply/stop only sets signal.aborted, which the agent loop reads at the TOP OF A TURN.
// A run blocked inside a turn (its provider died mid-call) never reaches another turn, so the flag
// is never read and the endpoint keeps returning {ok:true, stopping:true}. On 17 Sep that produced
// a 274-minute wedge during which the lane claimed nothing at all, while the keeper logged
// "stopping it" every 45 seconds.
//
// So: ask, wait, VERIFY, and escalate to an app restart if the run is still there. Restarting the
// app clears the runner active map, which is the only thing that reliably frees it.
async function escalateStop() {
  await api('/ai-apply/stop', { method: 'POST', body: JSON.stringify({ profileId: PROFILE }) }).catch(() => {});
  await sleep(15000);
  if (!(await runnerBusy())) { log('  stop took effect'); return true; }

  log('  stop did NOT take effect after 15s, the abort flag is not being read. Restarting the app.');
  try {
    const { execSync } = await import('node:child_process');
    execSync('schtasks /End /TN "JAT App Keeper (7744)"', { stdio: 'ignore' });
    execSync('powershell -NoProfile -Command "Get-Process electron -EA SilentlyContinue | Stop-Process -Force"', { stdio: 'ignore' });
    await sleep(5000);
    execSync('schtasks /Run /TN "JAT App Keeper (7744)"', { stdio: 'ignore' });
  } catch (e) { log(`  app restart failed: ${e.message}`); return false; }

  for (let i = 0; i < 20; i++) {
    await sleep(5000);
    const h = await api('/health').catch(() => null);
    if (h && h.j && h.j.ok) {
      const stillBusy = await runnerBusy();
      log(stillBusy ? '  app is back but a run is STILL in flight, this needs a human' : '  app restarted, the wedge is cleared');
      return !stillBusy;
    }
  }
  log('  app did not come back within 100s after the restart');
  return false;
}

async function applyOne() {
  // Checked every cycle, not once at startup. Quota comes back on its own (Codex said "try again at
  // 3:43 PM"), so a provider outage is a reason to wait, never a reason to stop.
  const prov = await canAnswerNow();
  if (!prov.ok) { log(`no provider can answer right now (${prov.why}), holding`); return 'noprovider'; }

  const live = await runnerBusy();
  if (live) {
    const startedMs = live.startedAt ? Date.parse(live.startedAt) : (busySince || Date.now());
    if (!busySince) busySince = startedMs;
    const ageMs = Date.now() - startedMs;
    if (ageMs > RUN_TIMEOUT_MS) {
      log(`a run has been in flight for ${(ageMs / 60000).toFixed(1)}m, past the ${RUN_TIMEOUT_MS / 60000}m limit — stopping it`);
      await escalateStop();
      busySince = null;
      return 'busy';
    }
    log(`the runner is busy (step ${live.steps ?? '?'}, ${(ageMs / 60000).toFixed(1)}m in), waiting rather than claiming`);
    return 'busy';
  }
  busySince = null;
  const { task, job, skipped, pool, count } = await pickTask();
  if (!task) {
    log(`nothing to claim (${pool}=${count}, skipped: walled-host=${skipped.walledHost} `
      + `wrong-role=${skipped.wrongRole} duplicate=${skipped.duplicate} no-url=${skipped.noUrl} attempts=${skipped.attempts} `
      + `already-resolved=${skipped.resolved})`);
    return 'idle';
  }

  const label = `${job.company || '?'} — ${String(job.title || '?').slice(0, 46)}`;
  log(`picked [${pool}] ${label}`);
  log(`  ${hostOf(job.jobUrl)}  attempts=${task.attempts || 0}  task=${task.id}`);

  if (DRY) { log('  [dry] would claim, start with autonomy=auto, and wait'); return 'dry'; }

  if (!(await claim(task.id))) { log('  ! claim refused, leaving it alone'); return 'skip'; }

  let outcome = 'failed';
  try {
    const started = Date.now();
    const { status, body } = await api('/ai-apply/start', {
      method: 'POST',
      body: JSON.stringify({
        profileId: PROFILE,
        autonomy: 'auto',        // it is allowed to finish the application
        toolset: 'apply',        // browser + ledger + documents + escalation, all policy-wrapped
        goal: buildGoal(job),
        headless: false,
        limits: { maxChars: MAX_CHARS },
      }),
    });
    if (status !== 200) {
      log(`  ! start refused (${status}): ${body.error || body.code || 'unknown'}`);
      await release(task.id, { state: 'queued', lastError: `ai lane could not start: ${body.error || status}` });
      return 'skip';
    }
    log('  run started, waiting');

    const run = await waitForRun(started);
    const mins = ((Date.now() - started) / 60000).toFixed(1);

    // THE RUN'S OWN STATUS IS NOT PROOF. Ask the ledger. But ask it in BOTH the places a submission
    // can land, because checking only one produced a false negative on 11 September that was worse
    // than the thing it was guarding against.
    //
    // What happened: the agent applied to Tenstorrent, read "Thank you for applying" off the page,
    // and logged it — honestly and correctly. But `log_application` records against a job it
    // resolves from company, title and url, and that was job_da9ad831..., NOT the jobId on the queue
    // task. So the task's own job still read 'started', this check called a real submission a
    // failure, and marked the task retryable. One more cycle and it would have applied twice under
    // his name. The verifier I wrote to catch false success produced a false failure instead.
    const { body: jb } = await api(`/jobs/${encodeURIComponent(task.jobId || job.id)}`);
    const nowStatus = String((jb.job || jb || {}).status || '');
    let submitted = nowStatus === 'submitted';
    let via = 'task job';
    if (!submitted) {
      // The same duplicate endpoint used before the run. If it now reports an engagement for this
      // company and posting, the agent's log_application landed somewhere this check can see.
      const q = new URLSearchParams({ company: job.company || '', url: job.jobUrl || '', title: job.title || '' });
      const eng = await api(`/ai-apply/engaged?${q}`).catch(() => null);
      const hit = eng && eng.body && Array.isArray(eng.body.items)
        // COMPANY IS NOT ENOUGH. On 17 Sep this reported tenstorrent's "Acceleration Kernel
        // Development" as SUBMITTED on the strength of the TT-Distributed application he made in
        // August — a different posting entirely, while the queue row sat in 'awaiting_review' with
        // "submit was reported without confirmation evidence". Require the SAME role or the SAME
        // url, which is the test ai-lane-selfcheck already uses. The Sep 11 false negative this
        // fallback was written for is still covered: that one matches on url and on title.
        ? eng.body.items.find((x) => String(x.status) === 'submitted'
            && (x.sameRole || String(x.matchedOn) === 'url'))
        : null;
      if (hit) { submitted = true; via = 'ledger lookup'; }
    }

    log(`  run ${run && run.status} in ${mins}m, steps=${run && run.steps}, `
      + `stop=${(run && run.stop_reason) || '?'} — job is now '${nowStatus}'`
      + (submitted && via !== 'task job' ? ` (but the ledger DOES show it submitted, via ${via})` : ''));

    if (submitted) {
      outcome = 'submitted';
      await release(task.id, { state: 'done', lastError: null });
      log(`  SUBMITTED  ${label}  (confirmed via ${via})`);
    } else {
      outcome = 'failed';
      await release(task.id, {
        state: 'failed',
        attemptsDelta: 1,
        lastError: `ai lane: run ${run && run.status}, ${(run && run.stop_reason) || 'no reason given'}`,
      });
    }
  } catch (e) {
    log('  ! run blew up:', e.message);
    // Back to 'queued' rather than 'failed': the application was never attempted, so it should not
    // burn an attempt. reconcileStaleRunning would free it after 8 minutes anyway, but leaving a
    // task stranded because this process died is exactly the failure this file exists to prevent.
    await release(task.id, { state: 'queued', lastError: `ai lane crashed: ${e.message}` });
  }
  return outcome;
}

(async () => {
  if (!TOKEN) { console.error('need --token or JAT_TOKEN'); process.exit(2); }

  const { body: h } = await api('/health');
  const { body: st } = await api('/ai-apply/status?force=1');
  const p = st.providers || {};
  log(`app v${h.version} at ${BASE}`);
  log(`providers: codex=${!!(p.codex && p.codex.available)} claude=${!!(p.claude && p.claude.available)} `
    + `canAnswer=${p.canAnswer} disabled=${p.disabled}`);
  // NOT FATAL. A cached status said nothing could answer while Claude was in fact available, and a
  // service that exits on that never comes back until someone notices. Warn and carry on; every
  // cycle re-checks with a forced refresh anyway.
  if (p.disabled || !p.canAnswer) {
    log('WARNING: no provider looks available at startup. Continuing anyway and re-checking each cycle.');
  }
  // AUDIT: show the role gate's verdict on the whole queue. A filter nobody can see the workings of
  // is a filter nobody can correct, and this one is a pile of regexes that WILL get things wrong.
  if (AUDIT) {
    const { body } = await api('/queue?state=queued&limit=200');
    const rows = (body.items || body.tasks || []);
    const take = [];
    const drop = new Map();
    for (const t of rows) {
      const job = t.job || {};
      const v = classify(job);
      if (v.fit) take.push(job);
      else {
        if (!drop.has(v.reason)) drop.set(v.reason, []);
        drop.get(v.reason).push(job);
      }
    }
    console.log(`\nWOULD APPLY TO  ${take.length} of ${rows.length}\n`);
    take.forEach((j) => console.log(`  + ${String(j.company || '?').slice(0, 26).padEnd(27)} ${String(j.title || '').slice(0, 52)}`));
    console.log(`\nWOULD SKIP  ${rows.length - take.length}\n`);
    for (const [reason, jobs] of [...drop.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${reason} (${jobs.length})`);
      jobs.forEach((j) => console.log(`      - ${String(j.title || '').slice(0, 60)}`));
    }
    process.exit(0);
  }

  log(`mode: ${DRY ? 'DRY RUN' : ONCE ? 'ONE JOB' : '24/7'}  cap=${DAILY_CAP}/day  gap=${GAP_S}s  `
    + `autonomy=auto  role-filter=${FILTER ? 'on' : 'OFF'}  maxChars=${MAX_CHARS.toLocaleString()}`);

  for (;;) {
    let done = 0;
    try { done = await runsToday(); } catch (e) { log('! cap check failed:', e.message); }
    if (done >= DAILY_CAP) {
      log(`daily cap reached (${done}/${DAILY_CAP}), holding`);
      if (ONCE || DRY) break;
      await sleep(15 * 60000);
      continue;
    }

    let result = 'idle';
    try { result = await applyOne(); } catch (e) { log('! cycle failed:', e.message); }

    if (ONCE || DRY) break;
    // An empty queue is not an error, it is a supply problem, and hammering it does not create work.
    // 'busy' polls faster than 'idle' because the wait ends the moment the other run finishes.
    await sleep(result === 'idle' ? 5 * 60000
      : result === 'busy' ? 30000
      : result === 'noprovider' ? 10 * 60000
      : GAP_S * 1000);
  }
  log('keeper exiting');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
