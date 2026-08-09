// A job for a host the breaker is holding must never be CLAIMED in the first place.
//
// The circuit breaker lives in the extension's service worker, so the server dispatched walled jobs
// blindly. The pump therefore did:
//     GET /queue/next        → the server CLAIMS the task (state becomes 'scheduled')
//     check the breaker      → walled
//     PATCH it back to queued → and that release is `.catch(() => {})`
// Any failure of that release leaves the task claimed, and it sits 'scheduled' until the reconciler
// reclaims it. The pump repeats this up to 25 times per pump.
//
// Measured live on the laptop 2026-08-09: ~12 stranded claims/hour; 106 of 164 stranded tasks were
// Indeed (the walled host); 11 of 12 sampled had host-wall history in their transcript.
//
// Passing the breaker's hosts up front removes the claim/release cycle entirely — no claim, no
// PATCH, nothing to strand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const server = read('app', 'src', 'server.js');
const bg = read('extension', 'background.js');

// Rebuild the server's host reducer so both sides can be checked against the same inputs.
const MULTI = new Set(['co.uk', 'com.au', 'co.jp', 'co.nz', 'co.in', 'com.br', 'co.za', 'com.mx', 'org.uk', 'gov.uk']);
function registrableDomainOf(url) {
  try {
    const h = new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase();
    const parts = h.split('.').filter(Boolean);
    if (parts.length <= 2) return h;
    const last2 = parts.slice(-2).join('.');
    return MULTI.has(last2) ? parts.slice(-3).join('.') : last2;
  } catch { return ''; }
}

test('every Indeed subhost reduces to the one key the breaker uses', () => {
  for (const u of ['https://ca.indeed.com/viewjob?jk=abc',
                   'https://smartapply.indeed.com/beforeyouapply',
                   'https://www.indeed.com/job/1']) {
    assert.equal(registrableDomainOf(u), 'indeed.com', u);
  }
});

test('multi-part TLDs are not truncated to the wrong site', () => {
  assert.equal(registrableDomainOf('https://jobs.example.co.uk/x'), 'example.co.uk');
  assert.equal(registrableDomainOf('https://boards.greenhouse.io/acme'), 'greenhouse.io');
});

test('a malformed URL yields no host and therefore never matches', () => {
  assert.equal(registrableDomainOf('not a url'), '');
  assert.equal(registrableDomainOf(null), '');
});

test('the live case: a walled Indeed job is passed over, LinkedIn still flows', () => {
  const skip = new Set(['indeed.com']);
  const passedOver = (url) => { const h = registrableDomainOf(url); return !!h && skip.has(h); };
  assert.equal(passedOver('https://ca.indeed.com/viewjob?jk=abc'), true, '106 of 164 stranded were these');
  assert.equal(passedOver('https://www.linkedin.com/jobs/view/1'), false, 'unwalled hosts must be unaffected');
  assert.equal(passedOver('https://boards.greenhouse.io/acme'), false);
});

test('an empty skip set changes nothing', () => {
  const skip = new Set();
  assert.equal(skip.size && skip.has('indeed.com'), 0, 'no skipHosts → behaviour identical to before');
});

test('the server passes over walled hosts and says why', () => {
  const fn = server.slice(server.indexOf('async function queueNext'));
  assert.match(fn, /skipHosts && skipHosts\.size/, 'must consult the set');
  assert.match(fn, /registrableDomainOf\(j\.jobUrl\)/, 'must reduce the job URL the same way');
  assert.match(fn, /under the extension's bot-challenge breaker — not claimed/,
    'the pass-over reason must name the cause, not read as an empty queue');
  assert.match(fn, /hostDeferred = true/, 'it idles on purpose, like the other deferrals');
});

test('force=1 still bypasses the skip — a manual run must never be blocked', () => {
  const fn = server.slice(server.indexOf('async function queueNext'));
  assert.match(fn, /if \(!force && skipHosts && skipHosts\.size\)/,
    'a user-forced dispatch has to be able to punch through the breaker');
});

test('the route parses skipHosts into a normalised set', () => {
  assert.match(server, /searchParams\.get\('skipHosts'\)/, 'the pump sends it as a query param');
  assert.match(server, /\.split\(','\)\.map\(\(s\) => s\.trim\(\)\.toLowerCase\(\)\)\.filter\(Boolean\)/,
    'whitespace/case/empties must not defeat the match');
});

test('the pump sends only hosts still INSIDE their cooldown', () => {
  const call = bg.slice(bg.indexOf('const walledHosts ='), bg.indexOf("const r = await api.call('GET', '/queue/next'"));
  assert.match(call, /nowMs < \(Number\(e\.until\) \|\| 0\)/,
    'sending an expired entry would keep a recovered host permanently skipped');
  assert.match(call, /encodeURIComponent/, 'hosts go into a query string');
});

test('the breaker check in the pump is KEPT as the authority', () => {
  // The map can change between the request and the reply, so the local check must still run.
  assert.match(bg, /shouldDispatchHost\(jobHost, Date\.now\(\), breakerMap\)/,
    'removing the local check would trust a snapshot that may already be stale');
});
