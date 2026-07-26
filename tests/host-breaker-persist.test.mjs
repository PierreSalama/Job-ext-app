// The host bot-challenge breaker must (1) key on the registrable domain so a wall on ANY Indeed
// subhost gates ALL Indeed jobs, and (2) PERSIST across MV3 service-worker eviction.
//
// Live 2026-07-25 (Dad's laptop + Pierre's machine): Indeed served Cloudflare on nearly every
// apply. The breaker was an in-memory Map in the MV3 service worker, which evicts every ~30s while
// auto-apply tasks are minutes apart -- so the cooldown was WIPED between tasks and every Indeed
// job re-probed the wall. One task hit Cloudflare 126 times; Indeed "refreshed a lot" showing
// "there's a problem, please try again later"; the reopened-tab pile-up white-screened Firefox.
// Two bugs: an in-memory breaker (doesn't survive eviction) and exact-hostname keying (a wall on
// smartapply.indeed.com never gated the job's ca.indeed.com host).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registrableDomain, shouldDispatchHost, trippedEntry } from '../extension/lib/host-breaker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bg = fs.readFileSync(path.join(here, '..', 'extension', 'background.js'), 'utf8');

test('every Indeed subhost normalizes to one breaker key', () => {
  for (const h of ['ca.indeed.com', 'smartapply.indeed.com', 'www.indeed.com', 'indeed.com', 'apply.ca.indeed.com'])
    assert.equal(registrableDomain(h), 'indeed.com', `${h} → indeed.com`);
  assert.equal(registrableDomain('www.linkedin.com'), 'linkedin.com');
  assert.equal(registrableDomain('boards.greenhouse.io'), 'greenhouse.io');
});

test('multi-part TLDs keep their eTLD+1', () => {
  assert.equal(registrableDomain('jobs.indeed.co.uk'), 'indeed.co.uk');
  assert.equal(registrableDomain('careers.example.com.au'), 'example.com.au');
});

test('a wall on the apply host gates the job host (they share a key)', () => {
  // The bug: challenge on smartapply.indeed.com, job on ca.indeed.com, keyed separately → no gate.
  const now = Date.now();
  const map = {};
  map[registrableDomain('smartapply.indeed.com')] = trippedEntry(null, 'cloudflare', now);
  const gate = shouldDispatchHost(registrableDomain('ca.indeed.com'), now, map);
  assert.equal(gate.dispatch, false, 'ca.indeed.com must be gated by a wall seen on smartapply.indeed.com');
});

test('the breaker is PERSISTED to chrome.storage, not an in-memory Map', () => {
  assert.doesNotMatch(bg, /const hostBreaker = new Map\(\)/, 'regression: in-memory Map is wiped by MV3 eviction');
  assert.match(bg, /HOST_BREAKER_KEY\s*=\s*'jat11\.hostBreaker'/, 'needs a storage key');
  assert.match(bg, /chrome\.storage\.local\.set\(\{ \[HOST_BREAKER_KEY\]/, 'trip must persist');
  assert.match(bg, /chrome\.storage\.local\.get\(HOST_BREAKER_KEY\)/, 'gate must read persisted state');
});

test('trip and gate both normalize the host', () => {
  // Trip normalizes inside tripHostBreaker; the gate normalizes the job host before checking.
  const trip = bg.slice(bg.indexOf('async function tripHostBreaker'), bg.indexOf('async function loadHostBreakerPruned'));
  assert.match(trip, /registrableDomain\(host\)/, 'trip must key on the registrable domain');
  assert.match(bg, /const jobHost = registrableDomain\(hostOfUrl\(/, 'gate must key on the registrable domain');
  assert.match(bg, /const breakerMap = await loadHostBreakerPruned\(\)/, 'gate must load the persisted, pruned breaker');
});

test('an expired cooldown is pruned so dispatch resumes', () => {
  const past = Date.now() - 1000;
  const map = { 'indeed.com': trippedEntry(null, 'cloudflare', past - 21 * 60 * 1000) };  // tripped >20m ago
  const gate = shouldDispatchHost('indeed.com', Date.now(), map);
  assert.equal(gate.dispatch, true, 'an elapsed cooldown must let the host through again');
});
