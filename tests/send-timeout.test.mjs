// Every executor↔service-worker call must have a ceiling.
//
// send() was a bare chrome.runtime.sendMessage wrapped in a Promise that settles ONLY when the
// callback fires. Under MV3 the service worker can be evicted or stalled mid-call, the callback
// never runs, and the promise never settles — the executor then waits forever holding a worker slot.
//
// Live 2026-08-09 on the laptop, one Machine Learning Engineer application:
//   trace:resume saved=100 selected=true fileInput=false uploadBtn=true required=true haveBytes=true
//     ↓ 2602 seconds (43 MINUTES) with no transcript entry
//   trace:scan already-has-value ← input:radio
// The task ran 50.4 minutes against a nominal 5.5-minute apply budget. Timeouts were 51% of all
// outcomes, and the per-apply timeout could not contain them because the hang is BELOW it — in an
// await with no ceiling of its own. The resume step reaches it via send({type:'get-document'}).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const executor = fs.readFileSync(path.join(here, '..', 'extension', 'content', 'executor.js'), 'utf8');
const SEND_TIMEOUT_MS = Number(executor.match(/export const SEND_TIMEOUT_MS = (\d+);/)[1]);

// Rebuild send() against a fake chrome so the BEHAVIOUR — not just the source — is tested.
// `defaultMs` mirrors SEND_TIMEOUT_MS and is parameterised only so the hang cases can run fast; the
// real constant is asserted separately below. Note the budget uses Math.max, so a caller cannot
// shorten the floor — only raise it.
function makeSend(sendMessageImpl, defaultMs = SEND_TIMEOUT_MS) {
  const chrome = { runtime: { sendMessage: sendMessageImpl, lastError: null } };
  return (msg) => new Promise((res) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; res(v); } };
    const budget = Math.max(Number(msg && msg.timeoutMs) || 0, defaultMs) + 5000;
    const timer = setTimeout(() => finish(null), budget);
    try {
      chrome.runtime.sendMessage(msg, (r) => { clearTimeout(timer); void chrome.runtime.lastError; finish(r); });
    } catch { clearTimeout(timer); finish(null); }
  });
}

test('a service worker that NEVER answers resolves null instead of hanging forever', async () => {
  const send = makeSend(() => { /* evicted SW: callback never fires */ }, 20);
  const p = send({ type: 'get-document', documentId: 'doc_1' });
  const raced = await Promise.race([p, new Promise((r) => setTimeout(() => r('STILL-PENDING'), 6500))]);
  assert.equal(raced, null, 'the live 43-minute hang — this must settle, not wait');
});

test('a normal reply is passed straight through', async () => {
  const send = makeSend((msg, cb) => cb({ ok: true, dataBase64: 'abc', echo: msg.type }));
  assert.deepEqual(await send({ type: 'get-document' }), { ok: true, dataBase64: 'abc', echo: 'get-document' });
});

test('a throwing sendMessage resolves null rather than rejecting', async () => {
  const send = makeSend(() => { throw new Error('Extension context invalidated'); });
  assert.equal(await send({ type: 'api-call' }), null, 'callers handle null; an unhandled rejection kills the run');
});

test('the timeout never double-settles a call that answers late', async () => {
  let cb = null;
  const send = makeSend((_m, c) => { cb = c; }, 20);
  const p = send({ type: 'slow' });
  const first = await Promise.race([p, new Promise((r) => setTimeout(() => r('PENDING'), 6500))]);
  assert.equal(first, null, 'timed out first');
  cb({ ok: true });                       // SW finally answers — must not throw or change the result
  assert.equal(await p, null, 'the settled value stands');
});

test('a caller cannot shorten the floor, only raise it', () => {
  const budget = (msg) => Math.max(Number(msg && msg.timeoutMs) || 0, SEND_TIMEOUT_MS) + 5000;
  assert.equal(budget({ timeoutMs: 5 }), SEND_TIMEOUT_MS + 5000,
    'a tiny timeoutMs must not make ordinary SW round-trips fail spuriously');
});

test('an explicit longer budget is honoured, with headroom over the background timeout', () => {
  const budget = (msg) => Math.max(Number(msg && msg.timeoutMs) || 0, SEND_TIMEOUT_MS) + 5000;
  assert.equal(budget({ type: 'api-call', timeoutMs: 150000 }), 155000,
    'the AI rescue asks for 150s — cutting it at 30s would break a working feature');
  assert.ok(budget({ type: 'api-call', timeoutMs: 150000 }) > 150000,
    'the background must time out first so we never truncate a legitimate slow call');
});

test('a message with no explicit budget gets the default ceiling', () => {
  const budget = (msg) => Math.max(Number(msg && msg.timeoutMs) || 0, SEND_TIMEOUT_MS) + 5000;
  assert.equal(budget({ type: 'get-document' }), SEND_TIMEOUT_MS + 5000);
  assert.ok(SEND_TIMEOUT_MS <= 60000, 'a hang must not be able to eat a meaningful slice of the apply budget');
});

test('the real send() is bounded and clears its timer on reply', () => {
  const fn = executor.slice(executor.indexOf('const send = (msg) =>'), executor.indexOf('// In-tab alert'));
  assert.match(fn, /setTimeout\(\(\) => finish\(null\)/, 'must have a ceiling');
  assert.match(fn, /clearTimeout\(timer\)/, 'a prompt reply must cancel the timer');
  assert.match(fn, /settled/, 'must guard against double-settling');
});
