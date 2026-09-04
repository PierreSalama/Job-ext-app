'use strict';
// ============================================================================
//  JAT v11 — alert bridge (AI Apply chunk 9)
//
//  A CAPTCHA on the server laptop is worth nothing to Pierre if he is at his desk and never hears
//  about it. This watches for blocks that STOP a run — a human check, an account wall, a password,
//  a lapsed CLI login — on THIS machine and on every peer node, and hands them to the desktop.
//
//  POLL, DO NOT PUSH
//  The laptop cannot rely on the PC being awake, and the PC cannot rely on the laptop being
//  reachable. A poll from the machine that wants to be told is the arrangement that recovers by
//  itself: miss a cycle, catch it on the next one. A push would need retries, an outbox, and a
//  delivery guarantee for a notification whose whole value is being timely.
//
//  ALERT ONCE, EVER
//  Delivered ids are remembered in kv, so restarting the app does not re-announce every open block
//  — which is exactly how a useful alert becomes noise that gets ignored.
//
//  SAY WHICH MACHINE AND WHICH PERSON
//  "Human check needed" is useless when two people are applying on a machine in another room. The
//  message names the node, the person, the employer and the action.
// ============================================================================

const KV_KEY = 'aiAlertedBlockIds';
const MAX_REMEMBERED = 500;

let log = { info() {}, warn() {}, error() {} };
try { log = require('../logger').scope('ai:alerts'); } catch { /* usable outside the app */ }

const ACTION = {
  captcha: 'Tick the human check and press Submit.',
  account: 'Create the account once, then it can finish.',
  password: 'Sign in on that machine.',
  auth_lapsed: 'Run `claude auth login` on that machine.',
  payment: 'This one wants money. Look before doing anything.',
  awaiting_submit: 'The form is filled and waiting for you to press Submit.',
};

function describe(block, nodeName) {
  const who = block.profileName || block.profile_name || null;
  const where = [block.company, block.title].filter(Boolean).join(' — ');
  const title = `${block.kind === 'captcha' ? 'Human check' : block.kind === 'account' ? 'Account needed'
    : block.kind === 'password' ? 'Password needed' : block.kind === 'auth_lapsed' ? 'Sign-in expired'
      : 'AI Apply needs you'} — ${nodeName}`;
  const body = [
    who ? `${who}` : null,
    where || null,
    ACTION[block.kind] || block.question,
  ].filter(Boolean).join(' · ');
  return { title, body: body.slice(0, 240) };
}

function makeAlertWatcher(opts = {}) {
  const {
    db,
    fetchPeer,                    // async (node) => [blocks]  — injected so this is testable offline
    onAlert = () => {},
    nodes = () => [],
    selfName = 'this machine',
    intervalMs = 20000,
  } = opts;
  if (!db) throw new Error('the alert watcher needs a db');

  let timer = null;
  let running = false;

  const remembered = () => {
    try { return new Set(JSON.parse(db.kvGet(KV_KEY) || '[]')); } catch { return new Set(); }
  };
  const remember = (ids) => {
    const keep = [...ids].slice(-MAX_REMEMBERED);
    try { db.kvSet(KV_KEY, JSON.stringify(keep)); } catch (e) { log.warn('could not persist alert ids', e.message); }
  };

  // One pass. Returns the alerts it delivered, so a caller (or a test) can see the effect.
  async function tick() {
    if (running) return [];                 // a slow peer must not stack up overlapping polls
    running = true;
    const seen = remembered();
    const delivered = [];
    try {
      const sources = [{ node: null, name: selfName }];
      for (const n of nodes()) sources.push({ node: n, name: n.name || n.baseUrl || 'peer' });

      for (const src of sources) {
        let blocks = [];
        try {
          blocks = src.node
            ? await fetchPeer(src.node)
            : db.aiBlockList({ status: 'open', limit: 100 });
        } catch (e) {
          // A peer being asleep is normal, not an error worth shouting about.
          log.info(`peer ${src.name} unreachable: ${e.message}`);
          continue;
        }
        for (const b of blocks || []) {
          if (!b || b.urgency !== 'alert' || b.status !== 'open') continue;
          const key = `${src.name}:${b.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const msg = describe(b, src.name);
          try { onAlert({ ...msg, block: b, node: src.name }); delivered.push({ ...msg, id: b.id, node: src.name }); }
          catch (e) { log.warn('alert delivery failed', e.message); }
        }
      }
      remember(seen);
    } finally {
      running = false;
    }
    if (delivered.length) log.info(`delivered ${delivered.length} alert(s)`);
    return delivered;
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch((e) => log.warn('alert tick failed', e.message)); }, intervalMs);
      if (timer.unref) timer.unref();
      log.info(`alert watcher started (every ${Math.round(intervalMs / 1000)}s)`);
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    isRunning: () => !!timer,
    _forget() { try { db.kvSet(KV_KEY, '[]'); } catch { /* fine */ } },
  };
}

// The default peer reader: another JAT node's own blocks endpoint.
function peerFetcher(httpJson) {
  return async (node) => {
    const base = String(node.baseUrl || '').replace(/\/+$/, '');
    if (!base) return [];
    const r = await httpJson(`${base}/ai-apply/blocks?status=open`, node.token);
    return (r && r.items) || [];
  };
}

module.exports = { makeAlertWatcher, peerFetcher, describe, KV_KEY };
