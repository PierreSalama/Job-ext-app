#!/usr/bin/env node
/*
 * Exactly ONE machine applies at a time.
 *
 * Both the PC and the server laptop apply as the SAME LinkedIn account, but each only counts its own
 * submissions. Measured live: the laptop read 36/40 while the PC read 12/40 — ~50 real applies against
 * a ~40 cap, which is why LinkedIn throttled the laptop. Running both roughly doubles the odds of a
 * harder block for no extra throughput, since the cap is per-account, not per-machine.
 *
 * Rule (laptop is the always-on default):
 *   laptop has Easy-Apply headroom      → LAPTOP applies, PC stands down
 *   laptop is capped but the PC is not  → PC applies, laptop stands down
 *   both capped / laptop unreachable    → whichever can still run keeps the flag, never both
 *
 * Only ever flips autoApply.enabled. Never touches queues, settings or sessions.
 */
const args = process.argv.slice(2);
const arg = (k, d = null) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');

const NODES = {
  laptop: { base: arg('laptop', 'http://127.0.0.1:7746'), token: arg('laptop-token', '') },
  pc:     { base: arg('pc', ''),                          token: arg('pc-token', '') },
};

const call = async (n, path, opts = {}) => {
  const r = await fetch(n.base + path, {
    headers: { 'X-JAT-Token': n.token, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000), ...opts,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

const probe = async (n) => {
  try {
    const [live, ea] = await Promise.all([call(n, '/auto-apply/live'), call(n, '/auto-apply/easyapply-status')]);
    return { up: true, enabled: !!live.enabled, capped: !!ea.cooledDown, used: ea.submitted24h, limit: ea.observedLimit };
  } catch (e) { return { up: false, err: e.message }; }
};

const setEnabled = async (n, on) => {
  if (DRY) return;
  await call(n, '/settings', {
    method: 'PATCH',
    body: JSON.stringify({ autoApply: on ? { enabled: true, startedAt: new Date().toISOString() } : { enabled: false } }),
  });
};

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

const main = async () => {
  const [lap, pc] = await Promise.all([probe(NODES.laptop), probe(NODES.pc)]);
  console.log(`${stamp()} laptop=${JSON.stringify(lap)} pc=${JSON.stringify(pc)}`);

  // Decide who should be the single active applier.
  let winner = null;
  if (lap.up && !lap.capped) winner = 'laptop';
  else if (pc.up && !pc.capped) winner = 'pc';
  else if (lap.up) winner = 'laptop';           // both capped → park the flag on the always-on box
  else if (pc.up) winner = 'pc';
  if (!winner) { console.log(`${stamp()} neither node reachable — nothing to do`); return; }

  for (const [name, n, st] of [['laptop', NODES.laptop, lap], ['pc', NODES.pc, pc]]) {
    if (!st.up) continue;
    const should = name === winner;
    if (st.enabled === should) continue;
    console.log(`${stamp()} ${name}: ${st.enabled ? 'ON' : 'off'} → ${should ? 'ON' : 'off'}${should ? '' : ' (standing down: same LinkedIn account)'}`);
    try { await setEnabled(n, should); } catch (e) { console.log(`${stamp()} ${name} patch failed: ${e.message}`); }
  }
  console.log(`${stamp()} active applier = ${winner}`);
};

main().catch((e) => { console.error(`${stamp()} FATAL ${e.message}`); process.exit(1); });
