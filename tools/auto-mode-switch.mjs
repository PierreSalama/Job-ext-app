#!/usr/bin/env node
/*
 * Keep the applier working even after LinkedIn's Easy-Apply allowance is spent.
 *
 * LinkedIn caps Easy-Apply at roughly 40/day. Before this, hitting that cap meant the applier simply
 * idled for hours: every queued job needed Easy Apply, none could run, and nothing switched. This
 * flips the search into WIDE mode when the cap is reached — external/ATS postings, which have no
 * LinkedIn cap — and flips back to the (much higher-converting) Easy-Apply mode the moment the
 * allowance resets.
 *
 *   EASY mode : easyApplyOnly=true,  boards=[linkedin],          atsBoards=off
 *               → best conversion; used whenever Easy-Apply headroom exists
 *   WIDE mode : easyApplyOnly=false, boards=[linkedin,indeed],   atsBoards=on
 *               → lower conversion (external forms ask many custom questions) but it KEEPS APPLYING
 *
 * Deliberately asymmetric: switch to WIDE as soon as we're capped, but only return to EASY once
 * usage has fallen well under the cap, so it can't oscillate on the boundary.
 *
 * Usage: node tools/auto-mode-switch.mjs --base http://host:port --token XXX [--dry]
 */
const args = process.argv.slice(2);
const arg = (k, d = null) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const BASE = (arg('base', 'http://127.0.0.1:7746')).replace(/\/$/, '');
const TOKEN = arg('token', '');
const DRY = args.includes('--dry');

const H = { 'X-JAT-Token': TOKEN, 'Content-Type': 'application/json' };
const api = async (p, opts = {}) => {
  const r = await fetch(BASE + p, { headers: H, ...opts });
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`);
  return r.json();
};

const EASY = {
  easyApplyOnly: true,
  boards: ['linkedin'],
  discovery: { atsBoardsEnabled: false },
};
const WIDE = {
  easyApplyOnly: false,
  boards: ['linkedin', 'indeed'],
  discovery: { atsBoardsEnabled: true },
};

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

const main = async () => {
  const [status, settings] = await Promise.all([
    api('/auto-apply/easyapply-status'),
    api('/settings'),
  ]);
  const aa = settings.settings.autoApply;
  const mode = aa.easyApplyOnly ? 'EASY' : 'WIDE';

  const limit = Number(status.observedLimit) || 40;
  const used = Number(status.submitted24h) || 0;
  const capped = !!status.cooledDown || used >= limit;
  // Only go back to EASY with real headroom left (70% of the cap), so a single submission landing
  // right at the boundary can't flap the mode back and forth.
  const hasHeadroom = !status.cooledDown && used < Math.floor(limit * 0.7);

  console.log(`${stamp()} mode=${mode} easyApply=${used}/${limit} cooledDown=${status.cooledDown} capped=${capped}`);

  let target = null;
  if (mode === 'EASY' && capped) target = { name: 'WIDE', patch: WIDE, why: `Easy-Apply spent (${used}/${limit}) — opening up to external postings so it keeps applying` };
  else if (mode === 'WIDE' && hasHeadroom) target = { name: 'EASY', patch: EASY, why: `Easy-Apply available again (${used}/${limit}) — returning to the high-conversion path` };

  if (!target) { console.log(`${stamp()} no change needed`); return; }
  console.log(`${stamp()} SWITCHING ${mode} → ${target.name}: ${target.why}`);
  if (DRY) { console.log('DRY RUN — not applied'); return; }

  const r = await api('/settings', { method: 'PATCH', body: JSON.stringify({ autoApply: target.patch }) });
  const now = r.settings.autoApply;
  console.log(`${stamp()} now: easyApplyOnly=${now.easyApplyOnly} boards=${JSON.stringify(now.boards)} atsBoards=${now.discovery.atsBoardsEnabled}`);
  // Refill immediately so the new mode has work to do rather than waiting for the next discovery tick.
  try { await api('/auto-apply/discover-now', { method: 'POST' }); console.log(`${stamp()} discovery kicked for the new mode`); } catch {}
};

main().catch((e) => { console.error(`${stamp()} FATAL ${e.message}`); process.exit(1); });
