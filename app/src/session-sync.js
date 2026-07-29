'use strict';
// ============================================================================
//  Session sync (laptop side)
//  Keep Dad's dedicated Chrome logged in as Dad by periodically pulling his LinkedIn
//  session from his own node and injecting it via CDP. Runs inside the laptop's
//  dad-instance. This is the glue that ties A1b (pull) + A1c (inject) into a living
//  thing: LinkedIn rotates cookies, so a one-shot would go stale — this re-feeds it.
// ============================================================================

const sessionBridge = require('./session-bridge');
const cdpInject = require('./cdp-inject');

// createSessionSync({ source:{baseUrl,token}, cdpPort, cdpHost, intervalMs, log, now, deps })
//   source   — Dad's node to pull his session from
//   cdpPort  — the --remote-debugging-port of Dad's Chrome on THIS machine
//   deps     — injectable {pull, inject} for tests; defaults to the real bridge + CDP injector
function createSessionSync(cfg = {}) {
  const {
    source = null,
    cdpPort = null,
    cdpHost = '127.0.0.1',
    intervalMs = 30 * 60 * 1000,      // refresh every 30 min by default
    log = () => {},
    now = Date.now,
    deps = {},
  } = cfg;

  const pull = deps.pull || ((s) => sessionBridge.fetchRemoteLinkedInSession({ baseUrl: s.baseUrl, token: s.token }));
  const inject = deps.inject || ((cookies) => cdpInject.injectLinkedInCookies({ host: cdpHost, port: cdpPort, cookies }));

  let timer = null;
  let running = false;
  let last = null;
  let inFlight = false;

  const stamp = () => new Date(now()).toISOString();

  async function syncOnce() {
    if (inFlight) return last || { ok: false, error: 'busy' };
    inFlight = true;
    try {
      if (!source || !source.baseUrl) { last = { ok: false, phase: 'config', error: 'no source configured', at: stamp() }; return last; }
      if (!cdpPort) { last = { ok: false, phase: 'config', error: 'no CDP port for Dad\'s Chrome', at: stamp() }; return last; }

      const pulled = await pull(source);
      if (!pulled || !pulled.ok) {
        last = { ok: false, phase: 'pull', error: (pulled && pulled.error) || 'pull failed', at: stamp() };
        log('warn', `session-sync pull failed: ${last.error}`);
        return last;
      }
      const inj = await inject(pulled.cookies);
      if (!inj || !inj.ok) {
        last = { ok: false, phase: 'inject', error: (inj && inj.error) || 'inject failed', at: stamp() };
        log('warn', `session-sync inject failed: ${last.error}`);
        return last;
      }
      last = { ok: true, cookies: pulled.count, hasLiAt: inj.hasLiAt !== false, capturedAt: pulled.capturedAt || null, at: stamp() };
      log('info', `session-sync ok — ${last.cookies} LinkedIn cookies live in Dad's Chrome`);
      return last;
    } finally { inFlight = false; }
  }

  function start() {
    if (running) return;
    running = true;
    // fire immediately, then on the interval; never let a rejection escape.
    syncOnce().catch(() => {});
    timer = setInterval(() => { syncOnce().catch(() => {}); }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { syncOnce, start, stop, status: () => ({ running, last }) };
}

// ---- app singleton: start/restart from settings ---------------------------
// The app calls applyFromSettings() at boot and whenever the sessionSync config changes.
// Only the laptop's Dad-instance ever has sessionSync.enabled — everywhere else this no-ops.
let _active = null;

function applyFromSettings(settings, { log = () => {}, deps } = {}) {
  const cfg = (settings && settings.sessionSync) || {};
  if (_active) { _active.stop(); _active = null; }
  if (!cfg.enabled) return { started: false, reason: 'disabled' };
  if (!cfg.sourceBaseUrl || !cfg.cdpPort) return { started: false, reason: 'incomplete config (need sourceBaseUrl + cdpPort)' };
  _active = createSessionSync({
    source: { baseUrl: cfg.sourceBaseUrl, token: cfg.sourceToken || '' },
    cdpPort: Number(cfg.cdpPort),
    intervalMs: Math.max(1, Number(cfg.intervalMinutes) || 30) * 60 * 1000,
    log,
    deps,
  });
  _active.start();
  return { started: true };
}

function active() { return _active; }
function status() { return _active ? _active.status() : { running: false, last: null }; }

module.exports = { createSessionSync, applyFromSettings, active, status };
