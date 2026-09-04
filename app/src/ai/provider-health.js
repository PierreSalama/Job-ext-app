'use strict';
// ============================================================================
//  JAT v11 — provider health watch
//
//  WHY THIS EXISTS
//  On 2026-09-04 AI Apply was deployed to the server laptop and could not take a single step. Both
//  CLIs were installed, neither was signed in, and the Codex token had expired on 2026-08-01. Five
//  weeks of silence. Nothing was watching, so nothing said anything.
//
//  The alert path for this was already built: `auth_lapsed` had copy in the alert bridge, a label
//  on the dashboard, and a place in the urgency rules. It had no source. This is the source.
//
//  TWO DIFFERENT FACTS, TWO DIFFERENT NOISES
//  · No model can answer at all. Work has stopped. That is an ALERT.
//  · The preferred model is signed out and a fallback is quietly covering. Work continues, and
//    Pierre is not getting the setup he designed. That is worth telling him. It is not worth
//    waking him. It goes on the queue.
//  Collapsing those two into one urgency is how an alert becomes something people learn to ignore.
//
//  IT CLEARS UP AFTER ITSELF
//  When a provider comes back, its open block is dismissed rather than left for a human to tidy.
//  A stale "sign-in expired" sitting under a working model teaches Pierre to distrust the page.
// ============================================================================

let log = { info() {}, warn() {}, error() {} };
try { log = require('../logger').scope('ai:provider-health'); } catch { /* usable outside the app */ }

// The providers a person signs into. An API key that is missing is a settings question, not a
// lapsed login, and it must never be reported as one.
const SIGN_IN_PROVIDERS = ['chatgpt', 'claude'];
const LABEL = { chatgpt: 'Codex (ChatGPT)', claude: 'Claude' };
const COMMAND = { chatgpt: 'codex login', claude: 'claude auth login' };

// The subscription card is where a CLI login lives. `chatgpt.subscription` is Codex, whatever the
// key is called; the API-key card next to it is a different thing entirely.
function signedOut(status, name) {
  const card = status && status[name];
  if (!card) return null;
  if (card.available) return null;                       // it works, by key or by login
  const sub = card.subscription || card;
  if (!sub || !sub.needsLogin) return null;              // broken, but not for want of a sign-in
  return { reason: sub.reason || 'the CLI is signed out', expiredAt: sub.expiredAt || null };
}

function makeProviderHealth(opts = {}) {
  const {
    db,
    statusAll,                       // injected: () => Promise<status>
    profileId = null,
    machine = 'this machine',
    onBlock = () => {},
    intervalMs = 10 * 60 * 1000,     // a lapsed token is a slow fact. Ten minutes is plenty.
  } = opts;

  let timer = null;

  const openAuthBlocks = () => db.aiBlockList({ status: 'open', limit: 200 })
    .filter((b) => b.kind === 'auth_lapsed');

  // The signature is what makes this idempotent across restarts: one open block per provider per
  // machine, no matter how many times the check runs.
  const signature = (name) => `provider:${name}@${machine}`;

  async function check() {
    let status;
    try { status = await statusAll(true); }
    catch (e) { log.warn(`could not read provider status: ${e.message}`); return { raised: [], cleared: [] }; }

    if (status.disabled) return { raised: [], cleared: [] };

    const lapsed = SIGN_IN_PROVIDERS
      .map((name) => ({ name, info: signedOut(status, name) }))
      .filter((x) => x.info);

    const existing = new Map(openAuthBlocks().map((b) => [b.detail && b.detail.split('\n')[0], b]));
    const raised = [];
    const cleared = [];

    for (const { name, info } of lapsed) {
      const sig = signature(name);
      if (existing.has(sig)) { existing.delete(sig); continue; }   // already reported, still true
      // Stopped means no model at all can answer. Anything else is a fallback quietly covering.
      const stopped = !status.canAnswer;
      const expired = info.expiredAt ? ` It expired on ${new Date(info.expiredAt).toISOString().slice(0, 10)}.` : '';
      const block = db.aiBlockCreate({
        profileId,
        kind: 'auth_lapsed',
        urgency: stopped ? 'alert' : 'queue',
        question: stopped
          ? `AI Apply cannot run on ${machine}: no model is signed in.`
          : `${LABEL[name]} is signed out on ${machine}, so a fallback is doing the work.`,
        detail: `${sig}\n${info.reason}${expired}\nRun \`${COMMAND[name]}\` on ${machine}.`,
      });
      raised.push(block);
      try { onBlock(block); } catch (e) { log.warn(`block notify failed: ${e.message}`); }
      log.info(`${name} signed out on ${machine} (${stopped ? 'alert' : 'queue'}): block ${block.id}`);
    }

    // Whatever is LEFT in `existing` describes a provider that is working again.
    for (const [sig, block] of existing) {
      if (!sig || !sig.startsWith('provider:') || !sig.endsWith(`@${machine}`)) continue;
      db.aiBlockDismiss(block.id);
      cleared.push(block);
      log.info(`sign-in recovered, dismissed block ${block.id} (${sig})`);
    }

    return { raised, cleared, canAnswer: !!status.canAnswer, lapsed: lapsed.map((x) => x.name) };
  }

  function start() {
    if (timer) return;
    // Check on boot, then on a timer. The boot check is the one that would have caught the laptop.
    check().catch((e) => log.warn(`first check failed: ${e.message}`));
    timer = setInterval(() => check().catch((e) => log.warn(`check failed: ${e.message}`)), intervalMs);
    if (timer.unref) timer.unref();
    log.info(`watching provider sign-ins on ${machine} every ${Math.round(intervalMs / 60000)} min`);
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { check, start, stop, signature };
}

module.exports = { makeProviderHealth, signedOut, SIGN_IN_PROVIDERS, COMMAND, LABEL };
