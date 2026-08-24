// AI RELAY (ai/remote.js) — borrowing another node's model when this node's own AI is dead.
//
// The bug this exists for: the server laptop passed every status probe (`claude --version` ran,
// `codex login status` said "logged in") while every real call failed CLAUDE_RESULT_ERR /
// CODEX_AUTH. Auto-apply charged full budget, 38 applications parked on questions no model saw.
//
// These tests pin the two things that make the relay safe to leave switched on:
//   • it FAILS SOFT — down, slow, malformed, or unauthorised peers fall through to the next
//     provider and ultimately the deterministic floor. It must never hang the applier.
//   • it CANNOT LOOP — the peer endpoint is an endpoint that runs the provider chain, so a node
//     pointed at itself (or two nodes at each other) has three independent brakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const remote = require(path.join(here, '..', 'app', 'src', 'ai', 'remote.js'));
const provider = require(path.join(here, '..', 'app', 'src', 'ai', 'provider.js'));

// A stand-in peer node. `handler(req, body)` returns { status, body } or a raw string body.
async function peer(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let parsed = null;
      try { parsed = JSON.parse(raw || '{}'); } catch {}
      seen.push({ url: req.url, headers: req.headers, body: parsed });
      let out;
      try { out = await handler(req, parsed); } catch (e) { out = { status: 500, body: { ok: false, error: String(e.message) } }; }
      if (out === undefined) { res.writeHead(204); res.end(); return; }
      const status = out.status || 200;
      const payload = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return { url, seen, close: () => new Promise((r) => srv.close(r)) };
}

const cfgFor = (url, extra = {}) => ({ enabled: true, url, token: 'peer-token', timeoutMs: 3000, ...extra });

// ---------------------------------------------------------------- happy path

test('peer answers: the relayed text and JSON come back, tagged with the peer provider', async () => {
  const p = await peer(() => ({ body: { ok: true, text: '{"answer":"Yes","confidence":0.9}', json: { answer: 'Yes', confidence: 0.9 }, provider: 'codex', model: 'gpt-5.4' } }));
  try {
    const r = await remote.generate({ prompt: 'q', schema: { type: 'object' }, cfg: cfgFor(p.url) });
    assert.equal(r.json.answer, 'Yes');
    assert.equal(r.peerProvider, 'codex', 'the model that really answered is reported');
    assert.equal(p.seen[0].url, '/ai/generate', 'relays to the provider-shaped endpoint, not answer-question');
    assert.equal(p.seen[0].headers['x-jat-token'], 'peer-token', 'authenticates with the PEER token');
    assert.equal(p.seen[0].headers[remote.HOP_HEADER], '1', 'marks the request as a relay');
    assert.equal(p.seen[0].headers[remote.ORIGIN_HEADER], remote.selfId(), 'stamps our node id so the peer can spot a loop');
  } finally { await p.close(); }
});

test('the prompt is sent as built here — the peer is only asked to run a model', async () => {
  const p = await peer(() => ({ body: { ok: true, text: 'fine', provider: 'claude-cli' } }));
  try {
    await remote.generate({ prompt: 'PROMPT-BODY', system: 'SYS', cfg: cfgFor(p.url) });
    assert.equal(p.seen[0].body.prompt, 'PROMPT-BODY');
    assert.equal(p.seen[0].body.system, 'SYS');
    assert.equal(p.seen[0].body.model, undefined, 'no local model name is imposed on the peer by default');
    assert.equal(p.seen[0].body.provider, undefined, 'the peer uses its own provider order unless pinned');
  } finally { await p.close(); }
});

// ---------------------------------------------------------------- fail soft

test('peer down: a closed port throws REMOTE_NET, it does not hang', async () => {
  const p = await peer(() => ({ body: { ok: true, text: 'x' } }));
  const url = p.url;
  await p.close();                                    // nothing is listening any more
  const started = Date.now();
  await assert.rejects(
    () => remote.generate({ prompt: 'q', cfg: cfgFor(url) }),
    (e) => e.code === 'REMOTE_NET' || e.code === 'REMOTE_TIMEOUT',
  );
  assert.ok(Date.now() - started < 3500, 'fails fast rather than blocking the applier');
});

test('peer times out: the configured ceiling is honoured and reported as REMOTE_TIMEOUT', async () => {
  const p = await peer(() => new Promise(() => {}));   // accepts the request, never answers
  try {
    const started = Date.now();
    await assert.rejects(
      () => remote.generate({ prompt: 'q', cfg: cfgFor(p.url, { timeoutMs: 400 }) }),
      (e) => e.code === 'REMOTE_TIMEOUT',
    );
    const took = Date.now() - started;
    assert.ok(took >= 350 && took < 2500, `gave up near the 400ms ceiling (took ${took}ms)`);
  } finally { await p.close(); }
});

test('peer returns malformed JSON: REMOTE_BADJSON, never a crash', async () => {
  const p = await peer(() => ({ body: '{"ok":true,"text":' }));   // truncated
  try {
    await assert.rejects(() => remote.generate({ prompt: 'q', cfg: cfgFor(p.url) }), (e) => e.code === 'REMOTE_BADJSON');
  } finally { await p.close(); }
});

test('peer returns valid JSON whose text is not the requested schema: REMOTE_BADJSON', async () => {
  const p = await peer(() => ({ body: { ok: true, text: 'I am prose, not JSON' } }));
  try {
    await assert.rejects(
      () => remote.generate({ prompt: 'q', schema: { type: 'object' }, cfg: cfgFor(p.url) }),
      (e) => e.code === 'REMOTE_BADJSON',
    );
  } finally { await p.close(); }
});

test('a schema answer wrapped in prose/fences is still recovered', async () => {
  const p = await peer(() => ({ body: { ok: true, text: 'Here you go:\n```json\n{"answer":"5"}\n```' } }));
  try {
    const r = await remote.generate({ prompt: 'q', schema: { type: 'object' }, cfg: cfgFor(p.url) });
    assert.equal(r.json.answer, '5');
  } finally { await p.close(); }
});

test('peer rejects the token / errors / empties: each maps to its own code', async () => {
  const cases = [
    [{ status: 401, body: { ok: false, error: 'unauthorized' } }, 'REMOTE_AUTH'],
    [{ status: 500, body: { ok: false, error: 'internal error' } }, 'REMOTE_HTTP'],
    [{ status: 200, body: { ok: false, error: 'No AI provider is configured.' } }, 'REMOTE_ERR'],
    [{ status: 200, body: { ok: true, text: '   ' } }, 'REMOTE_EMPTY'],
  ];
  for (const [reply, code] of cases) {
    const p = await peer(() => reply);
    try {
      await assert.rejects(() => remote.generate({ prompt: 'q', cfg: cfgFor(p.url) }), (e) => e.code === code, `expected ${code}`);
    } finally { await p.close(); }
  }
});

test('an unconfigured relay never reaches the network', async () => {
  await assert.rejects(() => remote.generate({ prompt: 'q', cfg: { enabled: false, url: 'http://x:1' } }), (e) => e.code === 'REMOTE_OFF');
  await assert.rejects(() => remote.generate({ prompt: 'q', cfg: { enabled: true, url: '  ' } }), (e) => e.code === 'REMOTE_NO_URL');
});

// ---------------------------------------------------------------- loop guard

test('LOOP GUARD 1 — a node addressed at itself is refused without a round trip', async () => {
  remote.setSelfPort(7744);
  for (const u of ['http://127.0.0.1:7744', 'http://localhost:7744/', '127.0.0.1:7744']) {
    assert.equal(remote.isSelfUrl(u), true, `${u} is this node`);
    await assert.rejects(() => remote.generate({ prompt: 'q', cfg: cfgFor(u) }), (e) => e.code === 'REMOTE_SELF');
  }
  // A different port, or another host, is a legitimate peer.
  assert.equal(remote.isSelfUrl('http://127.0.0.1:7799'), false);
  assert.equal(remote.isSelfUrl('http://100.93.122.106:7744'), false);
  remote.setSelfPort(0);
});

test('LOOP GUARD 2 — a request that is already a relay refuses to relay again', async () => {
  const p = await peer(() => ({ body: { ok: true, text: 'should never be reached' } }));
  try {
    // Simulate the server having received a relayed request (hop 1) and running the chain inside it.
    await remote.withInbound({ [remote.HOP_HEADER]: '1', [remote.ORIGIN_HEADER]: 'some-other-node' }, async () => {
      assert.equal(remote.isRelayed(), true);
      await assert.rejects(() => remote.generate({ prompt: 'q', cfg: cfgFor(p.url) }), (e) => e.code === 'REMOTE_RELAY');
    });
    assert.equal(p.seen.length, 0, 'the peer was never contacted — the loop stopped here');
    // Outside the relay context the same call is fine, so this is a scoped brake, not a kill switch.
    const r = await remote.generate({ prompt: 'q', cfg: cfgFor(p.url) });
    assert.equal(r.text, 'should never be reached');
  } finally { await p.close(); }
});

test('LOOP GUARD 2b — the relay attempt is absent from the chain while servicing a relay', async () => {
  const s = { order: ['chatgpt'], chatgpt: { useSubscription: true }, remote: { enabled: true, url: 'http://peer:7744' } };
  assert.deepEqual(provider.buildAttempts(s, {}).map((a) => a.name), ['remote', 'codex'], 'normally the relay leads');
  remote.withInbound({ [remote.HOP_HEADER]: '1' }, () => {
    assert.deepEqual(provider.buildAttempts(s, {}).map((a) => a.name), ['codex'], 'while relaying, the relay is gone');
    assert.deepEqual(provider.buildAttempts(s, { providerOverride: 'remote' }).map((a) => a.name), [], 'even an explicit override cannot re-enter');
  });
});

test('LOOP GUARD 3 — a server recognises its own node id coming back and a hop past the max', () => {
  const me = remote.selfId();
  assert.equal(remote.isSelfOrigin({ [remote.ORIGIN_HEADER]: me }), true, 'our own id bouncing back is a loop');
  assert.equal(remote.isSelfOrigin({ [remote.ORIGIN_HEADER]: 'another-node' }), false);
  assert.equal(remote.isSelfOrigin({}), false, 'an ordinary request is not a loop');
  assert.equal(remote.hopExceeded({ [remote.HOP_HEADER]: '1' }), false, 'one hop is allowed');
  assert.equal(remote.hopExceeded({ [remote.HOP_HEADER]: '2' }), true, 'two is a chain');
  // A stripped hop count must not re-open the recursion: an origin stamp alone still means relayed.
  assert.equal(remote.readInboundHeaders({ [remote.ORIGIN_HEADER]: 'n' }).hop, 1);
  assert.equal(remote.readInboundHeaders({}).hop, 0);
});

test('LOOP GUARD — a peer answering 508 is treated as a loop, not a hang', async () => {
  const p = await peer(() => ({ status: 508, body: { ok: false, code: 'AI_LOOP' } }));
  try {
    await assert.rejects(() => remote.generate({ prompt: 'q', cfg: cfgFor(p.url) }), (e) => e.code === 'REMOTE_LOOP');
  } finally { await p.close(); }
});

test('two nodes addressed at each other terminate after exactly one hop', async () => {
  // B relays onward only if it is allowed to; it runs its own chain inside the relay context the
  // way the server does, so this is the real two-node ping-pong, not a mock of it.
  let bTried = 0;
  const a = await peer(() => ({ body: { ok: true, text: 'A answered' } }));
  const b = await peer((req, body) => remote.withInbound(req.headers, async () => {
    bTried++;
    try {
      const r = await remote.generate({ prompt: body.prompt, cfg: cfgFor(a.url) });   // B tries to bounce it back to A
      return { body: { ok: true, text: r.text } };
    } catch (e) {
      return { body: { ok: true, text: `B answered locally (relay refused: ${e.code})`, provider: 'local-model' } };
    }
  }));
  try {
    const r = await remote.generate({ prompt: 'q', cfg: cfgFor(b.url) });
    assert.equal(bTried, 1);
    assert.match(r.text, /relay refused: REMOTE_RELAY/, 'B did not bounce it back to A');
    assert.equal(a.seen.length, 0, 'A was never re-entered');
  } finally { await a.close(); await b.close(); }
});

// ---------------------------------------------------------------- chain integration

test('default settings build the SAME chain as before the relay existed', () => {
  const s = { order: ['chatgpt', 'claude', 'local'], claude: {}, chatgpt: { useSubscription: true }, local: { enabled: false } };
  const before = ['codex', 'claude-cli'];
  assert.deepEqual(provider.buildAttempts(s, {}).map((a) => a.name), before, 'no remote key at all');
  assert.deepEqual(provider.buildAttempts({ ...s, remote: { enabled: false, url: 'http://peer:7744' } }, {}).map((a) => a.name), before, 'configured but off');
  assert.deepEqual(provider.buildAttempts({ ...s, remote: { enabled: true, url: '' } }, {}).map((a) => a.name), before, 'on but no address');
});

test('an enabled relay leads the chain, and an explicit order is respected as written', () => {
  const base = { claude: {}, chatgpt: { useSubscription: true }, local: { enabled: false }, remote: { enabled: true, url: 'http://peer:7744' } };
  assert.deepEqual(
    provider.buildAttempts({ ...base, order: ['chatgpt', 'claude'] }, {}).map((a) => a.name),
    ['remote', 'codex', 'claude-cli'],
    'switching the relay on is enough — it does not need the order reordered too',
  );
  assert.deepEqual(
    provider.buildAttempts({ ...base, order: ['chatgpt', 'remote', 'claude'] }, {}).map((a) => a.name),
    ['codex', 'remote', 'claude-cli'],
    'an order that names remote is honoured exactly',
  );
  assert.deepEqual(provider.buildAttempts({ ...base, order: ['claude'] }, { providerOverride: 'remote' }).map((a) => a.name), ['remote']);
});

test('a dead peer still lands on the deterministic floor rather than stranding the run', async () => {
  // The whole point: relay first, local providers next, rules last. Nothing here may throw past
  // the floor for a grounded question.
  const s = { order: ['chatgpt'], chatgpt: { useSubscription: false }, claude: { useSubscription: false }, local: { enabled: false }, remote: { enabled: true, url: 'http://127.0.0.1:9/' } };
  const attempts = provider.buildAttempts(s, {});
  assert.deepEqual(attempts.map((a) => a.name), ['remote']);
  await assert.rejects(() => attempts[0].run({ prompt: 'q' }));   // it fails…
  // …and provider.run's floor is what catches it (covered end-to-end in ai-deterministic.test.mjs).
});

// ---------------------------------------------------------------- honest status

test('status: off, self-addressed, and unreachable each report an honest reason', async () => {
  assert.equal((await remote.status({ enabled: false })).available, false);
  assert.equal((await remote.status({ enabled: true, url: '' })).reason, 'no peer address set');
  remote.setSelfPort(7744);
  assert.equal((await remote.status({ enabled: true, url: 'http://127.0.0.1:7744' })).code, 'REMOTE_SELF');
  remote.setSelfPort(0);
  const down = await remote.status({ enabled: true, url: 'http://127.0.0.1:9', probeTimeoutMs: 500 });
  assert.equal(down.available, false);
  assert.ok(['REMOTE_NET', 'REMOTE_TIMEOUT'].includes(down.code), `got ${down.code}`);
});

test('status: reachable is not enough — the peer must say it can actually answer', async () => {
  const dead = await peer(() => ({ body: { ok: true, canAnswer: false, claude: { available: true } } }));
  const live = await peer(() => ({ body: { ok: true, canAnswer: true, order: ['chatgpt'] } }));
  try {
    const d = await remote.status({ enabled: true, url: dead.url, token: 't' });
    assert.equal(d.available, false, 'a peer whose own AI is dead is not a usable relay');
    assert.match(d.reason, /no working model/);
    const l = await remote.status({ enabled: true, url: live.url, token: 't' });
    assert.equal(l.available, true);
    assert.deepEqual(l.peerOrder, ['chatgpt']);
  } finally { await dead.close(); await live.close(); }
});

test('HONESTY — a probe that says "ready" is overruled by the last real call that failed', () => {
  provider._clearOutcomes();
  const probeSaysReady = { available: true, cli: 'C:\\claude.exe', version: '2.1.220' };
  assert.equal(provider.honest(probeSaysReady, 'claudeSub').available, true, 'no history yet → trust the probe');

  // This is exactly what the laptop did for weeks: binary fine, every real call CLAUDE_RESULT_ERR.
  provider.noteOutcome('claude-cli', false, Object.assign(new Error('claude returned is_error'), { code: 'CLAUDE_RESULT_ERR' }));
  const h = provider.honest(probeSaysReady, 'claudeSub');
  assert.equal(h.available, false, '"the binary runs" no longer counts as "it can answer"');
  assert.equal(h.code, 'CLAUDE_RESULT_ERR');
  assert.match(h.reason, /last real request failed/);

  // A later success clears it — a provider that is working must be able to say so.
  provider.noteOutcome('claude-cli', true);
  assert.equal(provider.honest(probeSaysReady, 'claudeSub').available, true);
  assert.equal(provider.honest(probeSaysReady, 'claudeSub').proven, true);
  provider._clearOutcomes();
});

test('HONESTY — transient failures do NOT flip a provider to unavailable', () => {
  provider._clearOutcomes();
  const ready = { available: true };
  for (const code of ['CODEX_TIMEOUT', 'CODEX_EXIT', 'REMOTE_NET', 'REMOTE_TIMEOUT', 'OLLAMA_DOWN']) {
    provider.noteOutcome('codex', false, Object.assign(new Error('blip'), { code }));
    const h = provider.honest(ready, 'chatgptSub');
    assert.equal(h.available, true, `${code} is noise, not a verdict`);
    assert.equal(h.lastError, code, 'but it is still recorded');
  }
  // Auth failures are the ones that mean "a human has to fix this".
  provider.noteOutcome('codex', false, Object.assign(new Error('not logged in'), { code: 'CODEX_AUTH' }));
  assert.equal(provider.honest(ready, 'chatgptSub').available, false);
  provider._clearOutcomes();
});

// The two cheap credential probes, pinned against the ACTUAL files from both machines
// (shapes captured 2026-08-24: Pierre's PC, which works, and the server laptop, which doesn't).
// The whole point is that these two states must be told apart — the old probes could not.
test('HONESTY — the Claude credential probe separates "signed out" from "merely expired"', () => {
  const claude = require(path.join(here, '..', 'app', 'src', 'ai', 'claude.js'));
  const os = require('node:os'); const fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-cred-'));
  const write = (name, obj) => { const p = path.join(dir, name); fs.writeFileSync(p, JSON.stringify(obj)); return p; };

  // THE LAPTOP: the exact shape that reported "● ready" for weeks while every call failed.
  const dead = claude.credentialsCheck(write('dead.json', { mcpOAuth: {}, claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } }));
  assert.equal(dead.signedIn, false);
  assert.match(dead.reason, /signed out/);

  // THE PC: access token already past expiry, refresh token present — a NORMAL working machine.
  // Calling this dead would be a worse lie than the one being fixed.
  const live = claude.credentialsCheck(write('live.json', { claudeAiOauth: { accessToken: 'a'.repeat(108), refreshToken: 'r'.repeat(108), expiresAt: Date.now() - 3 * 86400000 } }));
  assert.deepEqual(live, { signedIn: true });

  // No opinion where there is no evidence — a missing/odd file must not downgrade anyone
  // (other platforms keep these in an OS keychain).
  assert.equal(claude.credentialsCheck(path.join(dir, 'nope.json')), null);
  assert.equal(claude.credentialsCheck(write('other.json', { somethingElse: 1 })), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('HONESTY — the Codex probe reads the token expiry `login status` never checks', () => {
  const codex = require(path.join(here, '..', 'app', 'src', 'ai', 'codex.js'));
  const os = require('node:os'); const fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-codex-auth-'));
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = (exp) => `${b64({ alg: 'RS256' })}.${b64({ exp })}.sig`;
  const write = (name, obj) => { const p = path.join(dir, name); fs.writeFileSync(p, JSON.stringify(obj)); return p; };

  // THE LAPTOP: expired 2026-08-01, `codex login status` still printed "Logged in".
  const expired = Math.floor(new Date('2026-08-01T06:37:12Z').getTime() / 1000);
  const dead = codex.tokenExpiry(write('dead.json', { auth_mode: 'oauth', tokens: { access_token: jwt(expired) }, last_refresh: '2026-07-22T06:37:12Z' }));
  assert.equal(dead.ok, false);
  assert.match(dead.reason, /expired on 2026-08-01/);

  // THE PC: expiry still in the future.
  const live = codex.tokenExpiry(write('live.json', { tokens: { access_token: jwt(Math.floor(Date.now() / 1000) + 7 * 86400) } }));
  assert.equal(live.ok, true);

  // API-key mode has no expiry, and anything unreadable yields no opinion rather than a verdict.
  assert.deepEqual(codex.tokenExpiry(write('key.json', { OPENAI_API_KEY: 'sk-x', tokens: {} })), { ok: true });
  assert.equal(codex.tokenExpiry(write('garbage.json', { tokens: { access_token: 'not-a-jwt' } })), null);
  assert.equal(codex.tokenExpiry(path.join(dir, 'nope.json')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('HONESTY — a proven-dead provider is not hidden behind the 30s status cache', () => {
  provider._clearOutcomes();
  provider.noteOutcome('codex', false, Object.assign(new Error('x'), { code: 'CODEX_AUTH' }));
  const first = provider.outcomes().codex;
  assert.equal(first.ok, false);
  assert.equal(first.code, 'CODEX_AUTH');
  provider._clearOutcomes();
});
