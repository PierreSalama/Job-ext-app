// JAT v11 — Remote peer provider (AI relay).
//
// WHY THIS EXISTS
// A node can be perfectly healthy and still have no working model. The server laptop is the
// case that motivated this: `claude --version` runs, `codex login status` says "logged in",
// /ai/status therefore reported both providers ready — and every real call came back
// claude-cli(CLAUDE_RESULT_ERR), codex(CODEX_AUTH). Its ~/.claude/.credentials.json holds two
// empty-string tokens and its ~/.codex/auth.json access token expired weeks ago. Auto-apply kept
// charging budget, every unfamiliar screening question fell to the deterministic floor, and when
// the floor couldn't ground it the application parked. 38 parked against 31 submitted.
//
// Re-authenticating that machine is not an option (copying credentials rotates the refresh token
// and signs the owner out of his own CLI). But ANOTHER node on the tailnet has a working model.
// So: relay the inference, not the credentials. This provider POSTs the fully-built prompt to a
// peer JAT node's /ai/generate and returns its answer as if a local model had produced it.
//
// WHY /ai/generate AND NOT /ai/answer-question
// /ai/generate is the peer's provider-shaped endpoint: { prompt, system, schema } in,
// { text, json } out — a 1:1 match for every other provider in this directory, so the relay
// works for cover letters and apply-rescue too, not just answers. It also keeps the PROMPT
// local: this node builds it from ITS profile, ITS resume and ITS learned answers, and the peer
// only runs the model. Posting /ai/answer-question instead would make the peer rebuild the
// prompt from the PEER's profile and memory — a different candidate answering the question.
// No secrets, no profile, and no learned memory ever move between machines in this direction.
//
// LOOP GUARD (this is the sharp edge)
// The endpoint this provider calls is an endpoint that itself runs the provider chain. A node
// pointed at itself, or two nodes pointed at each other, would recurse until something died.
// Three independent brakes, any one of which is sufficient:
//   1. HOP HEADER — every relayed request carries X-JAT-AI-Hop. The receiving server puts the
//      request into a relay context (withInbound) for its whole lifetime; a request that is
//      already relayed will not relay again (MAX_HOPS = 1), both here in generate() and in
//      provider.buildAttempts, which omits the remote attempt entirely.
//   2. ORIGIN ID — every relayed request carries X-JAT-AI-Origin: this node's id. A server that
//      sees its OWN id refuses with 508 before doing any work. This catches the tailnet-address
//      self-pointer that a URL comparison cannot see.
//   3. SELF URL — a loopback URL on our own port is refused locally, without a round trip.
//
// FAIL SOFT, ALWAYS
// Every failure here is a plain throw with a code. provider.run() logs it and moves to the next
// attempt, and answer-question still lands on the deterministic floor. An unreachable, slow, or
// malformed peer must never be able to hang the applier: the fetch is bounded by an
// AbortSignal.timeout and the default is well under the executor's patience.

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');
const { scope } = require('../logger');

const log = scope('ai:remote');

const HOP_HEADER = 'x-jat-ai-hop';
const ORIGIN_HEADER = 'x-jat-ai-origin';
// 1 = a relayed request is a leaf. Raising this is how you build a relay chain; don't.
const MAX_HOPS = 1;
// See config.js ai.remote.timeoutMs for the arithmetic: the executor allows 150s for a whole
// answer-question call, and the local chain + deterministic floor must still fit after this.
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_PROBE_MS = 6000;

function err(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

// ---------- relay context ----------
// The server enters this once per request (see server.js). Everything downstream — the endpoint
// handler, provider.run, this module — can then ask "am I servicing a relayed call?" without any
// parameter threading, and the answer survives every await in between.
const als = new AsyncLocalStorage();

function readInboundHeaders(headers) {
  const h = headers || {};
  const rawHop = h[HOP_HEADER] != null ? h[HOP_HEADER] : h[HOP_HEADER.toUpperCase()];
  const hop = Math.max(0, Math.floor(Number(rawHop) || 0));
  const rawOrigin = h[ORIGIN_HEADER] != null ? h[ORIGIN_HEADER] : h[ORIGIN_HEADER.toUpperCase()];
  const origin = String(rawOrigin == null ? '' : rawOrigin).slice(0, 120);
  // A bare origin header with no hop count is still a relayed request — treat it as hop 1 so a
  // malformed/stripped hop header cannot re-open the recursion.
  return { hop: hop || (origin ? 1 : 0), origin };
}

function withInbound(headers, fn) { return als.run(readInboundHeaders(headers), fn); }
function inbound() { return als.getStore() || { hop: 0, origin: '' }; }
function isRelayed() { return inbound().hop > 0; }

// ---------- identity ----------
// Stable per-install id, persisted so it survives restarts and reads sensibly in logs. Falls back
// to a process-lifetime random when the DB isn't open (tests, early boot) — that is still enough
// for the self-loop check, which only has to survive one request round trip.
let cachedSelfId = null;
let selfIdPersisted = false;
function selfId() {
  // Once chosen, the id NEVER changes for the life of the process: an outbound relay is only
  // recognised as ours if the id we sent is still the id we compare against when it comes back.
  if (!cachedSelfId) {
    // First call prefers the persisted id, so a node keeps one identity across restarts.
    try {
      const db = require('../db');
      const stored = db.kvGet && db.kvGet('aiNodeId');
      if (stored) { cachedSelfId = String(stored); selfIdPersisted = true; }
    } catch {}
    if (!cachedSelfId) cachedSelfId = crypto.randomBytes(8).toString('hex');
  }
  if (!selfIdPersisted) {
    // The DB wasn't open yet on the first call. Persist OURS rather than adopting a stored one
    // later: an id already handed to a peer must still be the id we compare against on the way back.
    try {
      const db = require('../db');
      if (db.kvSet) { db.kvSet('aiNodeId', cachedSelfId); selfIdPersisted = !!(db.kvGet && db.kvGet('aiNodeId')); }
    } catch {}
  }
  return cachedSelfId;
}
function _resetSelfId(id) { cachedSelfId = id || null; selfIdPersisted = !!id; }   // tests only

// The port we are listening on. server.js reports the REAL bound port (which can differ from the
// configured one); the settings value is the fallback.
let selfPort = 0;
function setSelfPort(p) { selfPort = Number(p) || 0; }
function currentPort() {
  if (selfPort) return selfPort;
  try { return Number(require('../db').getSettings().server.port) || 7744; } catch { return 7744; }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '::']);

// Trim a trailing slash so `${base}/ai/generate` never doubles up.
function normalizeBase(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  const withScheme = /^https?:\/\//i.test(s) ? s : `http://${s}`;
  return withScheme.replace(/\/+$/, '');
}

// Brake 3: a loopback URL on our own port is unambiguously this node.
function isSelfUrl(u) {
  try {
    const p = new URL(normalizeBase(u));
    const host = p.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const port = Number(p.port || (p.protocol === 'https:' ? 443 : 80));
    return LOOPBACK.has(host) && port === currentPort();
  } catch { return false; }
}

// Brake 2, server side: does this inbound request originate from us?
function isSelfOrigin(headers) {
  const { origin } = readInboundHeaders(headers);
  return !!origin && origin === selfId();
}
// Brake 1, server side: has this request already been relayed as far as it may go?
function hopExceeded(headers) {
  return readInboundHeaders(headers).hop > MAX_HOPS;
}

function relayHeaders(cfg) {
  const h = {
    'Content-Type': 'application/json',
    [HOP_HEADER]: String(inbound().hop + 1),
    [ORIGIN_HEADER]: selfId(),
  };
  if (cfg && cfg.token) h['X-JAT-Token'] = String(cfg.token);
  return h;
}

// ---------- status ----------
// A capability probe, not a liveness ping: "is the peer reachable AND does it say it can actually
// answer". The peer's own /ai/status carries canAnswer (see provider.statusAll) — an older peer
// without that field falls back to its per-provider availability.
async function status(cfg) {
  const c = cfg || {};
  if (!c.enabled) return { available: false, reason: 'AI relay is off — turn it on in Settings to use another computer’s model.', disabled: true };
  const url = normalizeBase(c.url);
  if (!url) return { available: false, reason: 'no peer address set' };
  if (isSelfUrl(url)) return { available: false, reason: `peer address ${url} points at this computer`, code: 'REMOTE_SELF' };
  if (isRelayed()) return { available: false, reason: 'this request is already a relay — not chaining further', code: 'REMOTE_RELAY' };

  const started = Date.now();
  try {
    const r = await fetch(`${url}/ai/status`, {
      headers: relayHeaders(c),
      signal: AbortSignal.timeout(Number(c.probeTimeoutMs) || DEFAULT_PROBE_MS),
    });
    const ms = Date.now() - started;
    if (r.status === 508) return { available: false, reason: 'relay loop — that address is this computer', code: 'REMOTE_LOOP', peer: url, ms };
    if (r.status === 401 || r.status === 403) return { available: false, reason: 'the peer rejected this token', code: 'REMOTE_AUTH', peer: url, ms };
    if (!r.ok) return { available: false, reason: `peer answered HTTP ${r.status}`, code: 'REMOTE_HTTP', peer: url, ms };
    let body = null;
    try { body = await r.json(); } catch { return { available: false, reason: 'peer sent a non-JSON status', code: 'REMOTE_BADJSON', peer: url, ms }; }
    const canAnswer = typeof body.canAnswer === 'boolean'
      ? body.canAnswer
      : !!(body.claude?.available || body.chatgpt?.available || body.local?.available);
    return {
      available: canAnswer,
      reason: canAnswer ? null : 'the peer is reachable but has no working model either',
      peer: url, ms, peerCanAnswer: canAnswer,
      peerOrder: Array.isArray(body.order) ? body.order : undefined,
    };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return {
      available: false,
      code: timedOut ? 'REMOTE_TIMEOUT' : 'REMOTE_NET',
      reason: timedOut ? `peer did not answer within ${Number(c.probeTimeoutMs) || DEFAULT_PROBE_MS}ms` : `cannot reach the peer (${String(e && e.message || e).slice(0, 120)})`,
      peer: url, ms: Date.now() - started,
    };
  }
}

// ---------- generate ----------
// generate({ prompt, system, schema, prose, model, timeoutMs, cfg }) → { text, json, peerProvider }
async function generate({ prompt, system, schema, prose = false, model = null, timeoutMs, cfg }) {
  const c = cfg || {};
  if (!c.enabled) throw err('REMOTE_OFF', 'AI relay is off');
  const url = normalizeBase(c.url);
  if (!url) throw err('REMOTE_NO_URL', 'AI relay has no peer address configured');

  // --- loop guard, before any network I/O ---
  const inb = inbound();
  if (inb.hop >= MAX_HOPS) throw err('REMOTE_RELAY', `refusing to relay a request that is already a relay (hop ${inb.hop})`);
  if (isSelfUrl(url)) throw err('REMOTE_SELF', `peer address ${url} points at this node — refusing to call myself`);

  const ms = Number(timeoutMs) || Number(c.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const payload = {
    // Namespaced so the peer's ai_log shows plainly that the work came from another machine.
    kind: 'relay',
    prompt, system: system || undefined, schema: schema || undefined, prose: !!prose,
  };
  // Only pin the peer's model/provider when explicitly configured — our local model names mean
  // nothing over there, so by default the peer uses its own order and its own default model.
  if (c.model || model) payload.model = c.model || model;
  if (c.peerProvider) payload.provider = c.peerProvider;

  let r;
  const started = Date.now();
  try {
    r = await fetch(`${url}/ai/generate`, {
      method: 'POST',
      headers: relayHeaders(c),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw err('REMOTE_TIMEOUT', `peer did not answer within ${ms}ms`);
    }
    throw err('REMOTE_NET', `cannot reach the peer at ${url}: ${String(e && e.message || e).slice(0, 160)}`);
  }

  if (r.status === 508) throw err('REMOTE_LOOP', 'relay loop detected by the peer — that address resolves back to this node');
  if (r.status === 401 || r.status === 403) throw err('REMOTE_AUTH', `the peer rejected this token (HTTP ${r.status})`);
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw err('REMOTE_HTTP', `peer HTTP ${r.status}: ${t.slice(0, 200)}`);
  }

  let body;
  try { body = await r.json(); }
  catch { throw err('REMOTE_BADJSON', 'peer response was not JSON'); }
  if (!body || typeof body !== 'object') throw err('REMOTE_BADJSON', 'peer response was not a JSON object');
  if (body.ok === false) throw err('REMOTE_ERR', `peer refused: ${String(body.error || body.code || 'unknown').slice(0, 200)}`);

  const text = String(body.text == null ? '' : body.text).trim();
  if (!text) throw err('REMOTE_EMPTY', 'peer returned an empty answer');

  let json = body.json && typeof body.json === 'object' ? body.json : null;
  if (schema && !json) {
    // Same tolerance as ollama.js: a peer running a CLI provider may hand back fenced JSON.
    try { json = JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { json = JSON.parse(m[0]); } catch {} }
    }
    if (!json) throw err('REMOTE_BADJSON', 'peer output did not parse as JSON');
  }

  log.info(`relayed to ${url} in ${Date.now() - started}ms (peer provider: ${body.provider || '?'})`);
  return { text, json, peerProvider: body.provider || null, peerModel: body.model || null };
}

module.exports = {
  status, generate, name: 'remote',
  // loop guard surface (server.js + provider.js + tests)
  HOP_HEADER, ORIGIN_HEADER, MAX_HOPS,
  withInbound, inbound, isRelayed, readInboundHeaders,
  selfId, isSelfOrigin, hopExceeded, isSelfUrl, normalizeBase, setSelfPort,
  _resetSelfId,
};
