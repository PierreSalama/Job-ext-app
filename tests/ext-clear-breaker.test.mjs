// FORGET THE WALLS: an operator lever for the extension's bot-challenge breaker.
//
// The breaker is persisted inside the extension's own storage, so nothing outside can reach it.
// On 2026-09-08 that became a deadlock. indeed.com was held by an escalated wall-count; the entire
// 42-job runnable queue was on indeed.com; and the rule that clears the count only fires when a run
// reaches an application form, which the wall prevents. Meanwhile a run HAD reached that site's form
// an hour earlier with no challenge at all, so the breaker was holding the node idle on evidence
// already known to be stale. The count escalates 20m → 40m → 80m → 160m → 320m → 6h, so on a
// single-host queue that gap is the difference between a working night and a silent one.
//
// Clearing is safe in the only direction that matters: if the host really is still walling us, the
// next job meets the wall, trips the breaker again, and we are where we started having spent one
// page load.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = fs.readFileSync(path.join(here, '..', 'app', 'src', 'server.js'), 'utf8');
const bg = fs.readFileSync(path.join(here, '..', 'extension', 'background.js'), 'utf8');

test('the app can arm the request, and only offers it while unacknowledged', () => {
  assert.match(server, /pathname === '\/ext\/clear-breaker'/, 'an endpoint must arm the request');
  assert.match(server, /extClearBreaker: \{ token: extLink\.clearBreakerToken, armedAt: extLink\.clearBreakerArmedAt \}/,
    '/health is the channel the extension already polls, so the command rides on it');
  // Advertised ONLY while a token is armed, exactly like extReload. A command that is always present
  // would be re-executed on every poll forever.
  assert.match(server, /\.\.\.\(extLink\.clearBreakerToken \? \{ extClearBreaker/);
});

test('arming twice returns the SAME token rather than a second command', () => {
  assert.match(server, /if \(extLink\.clearBreakerToken\) \{[\s\S]{0,160}already: true, token: extLink\.clearBreakerToken/,
    'a repeated arm must not queue a second clear');
});

test('the ack rejects a stale token and disarms on a good one', () => {
  assert.match(server, /token !== extLink\.clearBreakerToken\) return sendJson\(res, 409/,
    'an ack for a token we did not arm must not disarm anything');
  assert.match(server, /extLink\.clearBreakerToken = '';/);
});

test('the extension acts once per token, then acknowledges', () => {
  assert.match(bg, /if \(h\?\.extClearBreaker\) await handleClearBreaker/,
    'the flush alarm is what polls /health, so that is where the command is consumed');
  assert.match(bg, /if \(acted\.includes\(token\)\) return;/,
    'health re-offers the command until acked, so it must be idempotent on the token');
  assert.match(bg, /api\.call\('POST', '\/ext\/clear-breaker-ack'/);
});

test('it clears the whole map and then immediately asks for work', () => {
  assert.match(bg, /await saveHostBreaker\(\{\}\);/, 'the point is to forget every held host');
  // Without this the node stays idle until the next alarm tick, which is the state the request was
  // made to escape.
  assert.match(bg, /await pump\(true\);/);
});

test('the acted-token list is bounded, so storage cannot grow forever', () => {
  assert.match(bg, /\.slice\(-20\)/);
});

test('one failing step in the flush alarm cannot silence the command channel', () => {
  // The listener is an async arrow with NO try/catch, and it carries the only channel the app has
  // for commanding this extension. flushQueue() used to run unguarded ahead of the command
  // handlers, so a rejection there skipped the reload request, the clear-breaker request AND the
  // badge, silently.
  //
  // It also looked healthy from outside: /health is called by pump() every minute as well, so
  // extLink.seenAt kept ticking and the dashboard kept saying connected. Freshness of seenAt is
  // NOT evidence that this alarm is running - a mistake worth one wasted diagnosis, not two.
  const flush = bg.slice(bg.indexOf("if (a.name === 'jat11-flush')"), bg.indexOf("if (a.name === 'jat11-autoapply')"));
  assert.ok(flush.length > 0, 'expected to find the flush alarm branch');
  assert.match(flush, /await api\.flushQueue\(\); \} catch/, 'flushQueue must not be able to throw past itself');
  assert.match(flush, /handleExtReload\(h\.extReload\)\.catch/);
  assert.match(flush, /handleClearBreaker\(h\.extClearBreaker\)\.catch/);
  assert.match(flush, /paintBadge\(\)\.catch/);
  // Every line-initial await in the branch carries its own .catch, so no single failure can starve
  // the rest. (api.health is exempt: it is awaited into a variable and already has .catch.)
  const unguarded = flush.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('await '))
    .filter((line) => !line.startsWith('await api.health'))
    .filter((line) => !line.includes('.catch('));
  assert.deepEqual(unguarded, [], `every await in the flush branch must carry its own catch: ${unguarded.join(' | ')}`);
});
