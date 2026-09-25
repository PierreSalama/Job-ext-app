// THE AI LANE'S THREE-HOURLY SELF CHECK.
//
// Everything in here is a failure this project has actually had, not a hypothetical. Each check
// repairs what it can, and anything needing judgement is written to findings.log for a human rather
// than guessed at.
//
// THE RULE FOR EVERY AUTO-FIX: it must be reversible, it must be logged with the evidence that
// triggered it, and it must never cause an application to be sent. Nothing here submits anything.
//
//   node ai-lane-selfcheck.mjs            check and repair
//   node ai-lane-selfcheck.mjs --dry      report only, change nothing
import fs from 'node:fs';
import path from 'node:path';

const ARG = process.argv.slice(2);
const DRY = ARG.includes('--dry');
const val = (f, d) => { const i = ARG.indexOf(f); return i >= 0 && ARG[i + 1] ? ARG[i + 1] : d; };

const ROOT = val('--root', 'C:\\ProgramData\\JAT-Remote');
const CFG = path.join(ROOT, 'ai-lane.json');
// Strip the byte order mark. ai-lane.json is rewritten from PowerShell with Set-Content -Encoding
// UTF8, which prepends one, and JSON.parse refuses it outright.
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8').replace(/^﻿/, ''));
const BASE = cfg.base;
const H = { 'x-jat-token': cfg.token, 'content-type': 'application/json' };

const FINDINGS = path.join(ROOT, 'findings.log');
const out = [];
const fixes = [];
const findings = [];
const say = (s) => { out.push(s); console.log(s); };
const fixed = (s) => { fixes.push(s); say('  FIXED: ' + s); };
const found = (s) => { findings.push(s); say('  NEEDS A HUMAN: ' + s); };

async function api(p, opts = {}) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(BASE + p, { headers: H, ...opts });
      return { s: r.status, j: await r.json().catch(() => ({})) };
    } catch { await new Promise((x) => setTimeout(x, 3000)); }
  }
  return { s: 0, j: {} };
}

const stamp = new Date().toLocaleString('en-CA', { hour12: false });
say(`=== AI lane self check  ${stamp}${DRY ? '  (DRY RUN)' : ''} ===`);

// ---------------------------------------------------------------------------------------------
// 1. IS THE APP EVEN ANSWERING?
// Everything else is meaningless if it is not, and a stale jat.db.lock has 500'd this whole API
// before, which surfaced as "bad host" on every request rather than as an outage.
// ---------------------------------------------------------------------------------------------
const health = await api('/health');
if (health.s !== 200) {
  found(`the app is not answering on ${BASE} (status ${health.s}). Nothing else could be checked.`);
  fs.appendFileSync(FINDINGS, `${stamp}  APP DOWN (${health.s})\n`);
  process.exit(1);
}
say(`app        : v${health.j.version} responding`);

// ---------------------------------------------------------------------------------------------
// 2. A RUN THAT NEVER ENDS BLOCKS THE WHOLE LANE.
// The keeper waits for an in-flight run rather than claiming, so one wedged run means indefinite
// silence. Anything past 25 minutes is past the 20-minute per-application limit and is stuck.
// ---------------------------------------------------------------------------------------------
const st = await api('/ai-apply/status?force=1');
const live = (st.j.running || [])[0];
if (live) {
  const ageMin = live.startedAt ? (Date.now() - Date.parse(live.startedAt)) / 60000 : 0;
  say(`run        : in flight, step ${live.steps}, ${ageMin.toFixed(1)}m old`);
  if (ageMin > 25) {
    if (!DRY) await api('/ai-apply/stop', { method: 'POST', body: JSON.stringify({ profileId: cfg.profileId }) });
    fixed(`stopped a run wedged for ${ageMin.toFixed(0)} minutes (step ${live.steps})`);
  }
} else {
  say('run        : idle');
}

// ---------------------------------------------------------------------------------------------
// 3. PROVIDERS.
// Quota is normal and self-healing, so it is reported rather than repaired. Both being down at
// once is worth a human knowing about.
// ---------------------------------------------------------------------------------------------
const p = st.j.providers || {};
const codexOk = !!(p.codex && p.codex.available);
const claudeOk = !!(p.claude && p.claude.available);
say(`providers  : codex=${codexOk} claude=${claudeOk} canAnswer=${!!p.canAnswer}`);
if (!p.canAnswer) {
  found(`no provider can answer. codex: ${(p.codex && p.codex.reason) || 'n/a'} | claude: ${(p.claude && p.claude.reason) || 'n/a'}`);
}

// ---------------------------------------------------------------------------------------------
// 4. THE FALSE NEGATIVE THAT NEARLY CAUSED A DUPLICATE APPLICATION.
// On 11 September the agent submitted to Tenstorrent, read "Thank you for applying", and logged it
// correctly — but log_application records against a job it resolves from company/title/url, which
// was NOT the jobId on the queue task. The keeper checked one place, saw 'started', and marked a
// successful application as failed and therefore retryable. This finds any task in that state and
// corrects it, which is the difference between a tidy ledger and applying twice under his name.
// ---------------------------------------------------------------------------------------------
const failedQ = await api('/queue?state=failed&limit=400');
const failedRows = failedQ.j.items || [];
let corrected = 0;
for (const t of failedRows.slice(0, 120)) {
  const job = t.job || {};
  if (!job.company || !job.jobUrl) continue;
  const q = new URLSearchParams({ company: job.company, url: job.jobUrl, title: job.title || '' });
  const eng = await api(`/ai-apply/engaged?${q}`);
  const hit = (eng.j.items || []).find((x) => String(x.status) === 'submitted' && x.sameRole);
  if (!hit) continue;
  corrected++;
  if (!DRY) {
    await api(`/queue/${encodeURIComponent(t.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        state: 'done',
        lastError: null,
        transcriptAppend: { kind: 'selfcheck', note: 'the ledger shows this role already submitted; the task was wrongly left failed and could have been retried into a duplicate' },
      }),
    });
  }
}
if (corrected) fixed(`${corrected} task(s) were marked failed while the ledger showed them submitted — corrected, duplicate risk removed`);
else say('ledger     : no failed-but-submitted mismatches');

// ---------------------------------------------------------------------------------------------
// 5. HOSTS THAT ALWAYS END IN A CAPTCHA.
// The agent must never solve one, so a host that always presents one is a host that can only ever
// waste a ten-minute run. Measured 11-12 September: hCaptcha on Lever and some Greenhouse forms.
// Anything at or above 3 captcha blocks gets proposed for the skip list.
// ---------------------------------------------------------------------------------------------
const blocks = await api('/ai-apply/blocks?limit=400');
const items = blocks.j.items || [];
const capHosts = {};
for (const b of items.filter((x) => x.kind === 'captcha')) {
  try { const h = new URL(b.url).hostname.replace(/^www\./, ''); capHosts[h] = (capHosts[h] || 0) + 1; } catch {}
}
const skip = new Set(String(cfg.skipHosts || '').split(',').map((s) => s.trim()).filter(Boolean));
// A host Pierre has decided to keep working stays workable. Open captcha blocks never resolve on
// their own, so the count above only ever grows and would otherwise ban a host permanently after
// three unsolved captchas. Measured 2026-09-16: this ratcheted jobs.lever.co - the only host with
// any supply at all - back onto the skip list hours after it was deliberately removed.
const never = new Set(String(cfg.neverSkip || '').split(',').map((s) => s.trim()).filter(Boolean));
for (const h of never) skip.delete(h);
const newSkips = Object.entries(capHosts).filter(([h, n]) => n >= 3 && !skip.has(h) && !never.has(h));
if (never.size) cfg.skipHosts = [...skip].join(',');
say(`blocks     : ${items.length} open (${items.filter((x) => x.kind === 'captcha').length} captcha, ${items.filter((x) => x.kind === 'needs_answer').length} need an answer)`);
if (newSkips.length) {
  for (const [h, n] of newSkips) skip.add(h);
  if (!DRY) {
    cfg.skipHosts = [...skip].join(',');
    fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2), 'utf8');   // no BOM, unlike Set-Content
  }
  fixed(`added to the skip list, every run there ends in a captcha: ${newSkips.map(([h, n]) => `${h} (${n})`).join(', ')}`);
}

// ---------------------------------------------------------------------------------------------
// 6. SUPPLY, MEASURED THE WAY THE KEEPER ACTUALLY SEES IT.
// The first version counted only state='queued' and so reported "0 workable" on every single cycle
// while the keeper was busily working the retry backlog, and triggered the ATS feed pointlessly
// every three hours. A metric that does not match what the consumer consumes is worse than none.
// ---------------------------------------------------------------------------------------------
const countable = async (state) => {
  const r = await api(`/queue?state=${state}&limit=400`);
  return (r.j.items || []).filter((t) => {
    const u = String((t.job && t.job.jobUrl) || '');
    if (!u) return false;
    if ((t.attempts || 0) >= 3) return false;
    return ![...skip].some((h) => u.includes(h));
  }).length;
};
const RETRYABLE_CLASSES = new Set(['missing_info', 'transient_page', 'unknown_failure']);
const retryPool = async () => {
  let n = 0;
  for (const st2 of ['failed', 'parked']) {
    const r = await api(`/queue?state=${st2}&limit=400`);
    n += (r.j.items || []).filter((t) => {
      if (!RETRYABLE_CLASSES.has(String(t.failureClass || t.lastFailureClass || ''))) return false;
      const u = String((t.job && t.job.jobUrl) || '');
      if (!u || (t.attempts || 0) >= 3) return false;
      return ![...skip].some((h) => u.includes(h));
    }).length;
  }
  return n;
};
const freshWorkable = await countable('queued');
const retryWorkable = await retryPool();
let claimable = freshWorkable + retryWorkable;

// KEEPER IS THE AUTHORITY ON ITS OWN SUPPLY.
//
// On 13 September this line read "121 the keeper can actually claim" while the keeper's own log said
// "nothing to claim" every six minutes for five hours straight. The estimate above applies three of
// the keeper's filters (url, attempts, skip-hosts) and none of the other three (role fit, the
// duplicate ledger, already-resolved), so it overcounts by exactly the jobs the keeper throws away.
// Rather than reimplement the filter here and let the two drift apart again, read what the keeper
// itself last reported. Its number is the real one by definition, because it is the thing claiming.
let keeperLine = null, keeperAgeMin = null;
try {
  const logs = fs.readdirSync(ROOT)
    .filter((n) => /^ai-lane-\d{8}\.log$/.test(n))
    .map((n) => ({ n, t: fs.statSync(path.join(ROOT, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (logs.length) {
    keeperAgeMin = Math.round((Date.now() - logs[0].t) / 60000);
    const lines = fs.readFileSync(path.join(ROOT, logs[0].n), 'utf8').trim().split(/\r?\n/);
    keeperLine = lines[lines.length - 1] || null;
  }
} catch {}

if (keeperLine && keeperAgeMin !== null && keeperAgeMin <= 20) {
  const m = /nothing to claim \(([a-z]+)=(\d+), skipped: (.+)\)/.exec(keeperLine);
  if (m) {
    say(`supply     : the keeper reports NOTHING claimable from ${m[2]} ${m[1]} rows (${m[3]})`);
    if (claimable > 0) {
      found(`supply metrics disagree: this check estimates ${claimable} claimable, the keeper claims 0. `
        + `The keeper is right. The gap is role fit, the duplicate ledger and already-resolved rows, `
        + `which this estimate does not apply. Skipped breakdown: ${m[3]}`);
    }
    claimable = 0;
  } else {
    say(`supply     : ${freshWorkable} fresh + ${retryWorkable} retry estimated | keeper last said: ${keeperLine.slice(0, 120)}`);
  }
} else {
  say(`supply     : ${freshWorkable} fresh + ${retryWorkable} retry = ${claimable} estimated claimable`);
  if (keeperAgeMin === null) found('no keeper log found, so its real supply could not be confirmed');
  else found(`the keeper log has not been written for ${keeperAgeMin} minutes. It heartbeats every ~6, so it is stalled.`);
}
// Triggering the ATS feed here fired for 20 consecutive cycles and changed nothing, because an
// empty claimable pool is a SUPPLY CEILING and not a stale feed: most of the retry backlog is
// walled hosts and duplicates, and most Canadian ATS postings sit above the seniority cap. Pulling
// the feed again cannot invent a posting that fits, so it is no longer called. Report and move on.
if (claimable === 0) {
  say('  no claimable work. This is the supply ceiling, not a stale feed, so the feed is NOT triggered.');
} else if (claimable < 5) {
  found(`only ${claimable} claimable job(s) left. The lane will idle within hours.`);
}

// 7. THE RECURRING QUESTIONS.
// Every needs_answer block is an application that stopped one field short. They are reported here
// with their counts so the answer bank can be filled deliberately. NOT auto-answered: inventing an
// answer on his behalf is the one thing this whole system exists to avoid.
// ---------------------------------------------------------------------------------------------
const needs = items.filter((x) => x.kind === 'needs_answer');
if (needs.length) {
  const byQ = {};
  needs.forEach((b) => { const k = String(b.question || '').slice(0, 90); byQ[k] = (byQ[k] || 0) + 1; });
  const top = Object.entries(byQ).sort((a, b) => b[1] - a[1]).slice(0, 5);
  found(`${needs.length} application(s) stopped one answer short. Most common: ${top.map(([q, n]) => `"${q}" (${n})`).join(' | ')}`);
}

// ---------------------------------------------------------------------------------------------
// 8. LOG HYGIENE. A 7.9 MB bridge.log was found on 12 September on a box with 118 GB free, so this
// is about keeping the logs readable rather than about disk.
// ---------------------------------------------------------------------------------------------
for (const f of fs.readdirSync(ROOT).filter((f) => f.endsWith('.log'))) {
  const full = path.join(ROOT, f);
  const mb = fs.statSync(full).size / 1048576;
  if (mb > 5) {
    if (!DRY) {
      const keep = fs.readFileSync(full, 'utf8').split('\n').slice(-2000).join('\n');
      fs.writeFileSync(full + '.trimmed', keep, 'utf8');
      fs.writeFileSync(full, keep, 'utf8');
      try { fs.unlinkSync(full + '.trimmed'); } catch {}
    }
    fixed(`trimmed ${f} (${mb.toFixed(1)} MB) to its last 2000 lines`);
  }
}

// ---------------------------------------------------------------------------------------------
// 9. THE SCOREBOARD. Reported every time so a slide is visible rather than inferred.
// ---------------------------------------------------------------------------------------------
const stats = await api('/stats');
say(`scoreboard : ${stats.j.total} tracked, ${stats.j.byStatus && stats.j.byStatus.submitted} currently in submitted status (rows move out to ghosted/rejected as they age), ${stats.j.thisWeek} this week`);

// GROUNDHOG DAY DETECTOR.
//
// Six consecutive runs on 12 and 13 September reported the same two "fixes" while the scoreboard
// moved by exactly one submission. A fix that fires every cycle is not repairing anything, and
// saying so plainly once is worth more than a green tick every three hours. Numbers are stripped
// from the key so "trimmed bridge.log (7.7 MB)" and "(7.9 MB)" count as the same claim.
const REPEAT_STATE = path.join(ROOT, 'selfcheck-repeats.json');
let seen = {};
try { seen = JSON.parse(fs.readFileSync(REPEAT_STATE, 'utf8').replace(/^﻿/, '')); } catch {}
const next = {};
for (const f of fixes) {
  const k = f.replace(/[0-9.]+/g, '#');
  next[k] = (seen[k] || 0) + 1;
}
for (const [k, n] of Object.entries(next)) {
  if (n >= 3) {
    found(`this "fix" has fired ${n} cycles running and the problem is still here: ${k} — it is being papered over, not repaired`);
  }
}
if (!DRY) { try { fs.writeFileSync(REPEAT_STATE, JSON.stringify(next), 'utf8'); } catch {} }

say(`\n${fixes.length} fixed, ${findings.length} need a human`);
const line = `${stamp}  fixed=${fixes.length} needsHuman=${findings.length}`
  + (fixes.length ? `\n    FIXED: ${fixes.join('\n    FIXED: ')}` : '')
  + (findings.length ? `\n    HUMAN: ${findings.join('\n    HUMAN: ')}` : '');
if (!DRY) fs.appendFileSync(FINDINGS, line + '\n');
