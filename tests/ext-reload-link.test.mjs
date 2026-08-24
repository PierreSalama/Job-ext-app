// REMOTE SELF-RELOAD + LIVE EXTENSION VERSION.
//
// The applier laptop loads the extension UNPACKED from C:\ProgramData\JAT-Remote\
// chrome-extension-pierre. That copy sat at 11.118.0 while the tree was at 11.121.0 — three days
// of fixes were never live — and nothing surfaced it, because `extVersion` on /auto-apply/live
// was always empty. That Chrome is launched with no --remote-debugging-port and no
// --load-extension, so there is no CDP path in, and it cannot be restarted (it holds the real
// logged-in LinkedIn session).
//
// Two halves, both tested here:
//   • VERSION REPORTING (the more valuable half) — the extension reports its loaded
//     manifest.version on the health probe it already makes every minute.
//   • SELF-RELOAD — the app can arm a request; the extension reloads itself, but NEVER while an
//     application is in flight, and the deferral is observable rather than silent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const R = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const server = R('app/src/server.js');
const background = R('extension/background.js');
const api = R('extension/lib/api.js');

// ---------------------------------------------------------------------------
// version reporting
// ---------------------------------------------------------------------------

test('the extension reports its loaded manifest.version on the health probe', () => {
  const fn = api.slice(api.indexOf('export async function health'), api.indexOf('export async function lastHealthyAt'));
  assert.match(fn, /chrome\.runtime\.getManifest\(\)/, 'must read the LOADED manifest, not a constant');
  assert.match(fn, /extVersion=/, 'the version must go to the app');
  assert.match(fn, /extId=/, 'the runtime id identifies WHICH unpacked copy is loaded');
});

test('the app records it on /health and surfaces it on /auto-apply/live', () => {
  const h = server.slice(server.indexOf("pathname === '/health'"), server.indexOf("pathname === '/pair'"));
  assert.match(h, /extLink\.version = v/, '/health must record the reported version');
  const live = server.slice(server.indexOf("pathname === '/auto-apply/live'"), server.indexOf("pathname === '/auto-apply/intake'"));
  assert.match(live, /extVersion:/, 'the field that was always empty must now be populated');
  assert.match(live, /extLink:\s*extLinkPublic\(\)/);
});

test('the reload request rides the EXISTING health poll — no second transport', () => {
  // /health is polled every minute by the jat11-flush alarm regardless of whether auto-apply is
  // on; /queue/next only runs while auto-apply is ENABLED, which is the wrong way round for a
  // reload channel (an idle node is exactly when reloading is safe).
  const h = server.slice(server.indexOf("pathname === '/health'"), server.indexOf("pathname === '/pair'"));
  assert.match(h, /extReload/, 'the armed token comes back on the health probe');
  assert.match(background, /if \(h\?\.extReload\) await handleExtReload/, 'the flush alarm consumes it');
  assert.equal(/new WebSocket|EventSource|chrome\.sockets/.test(background), false, 'no new transport');
});

// ---------------------------------------------------------------------------
// the guard: never mid-apply
// ---------------------------------------------------------------------------

test('a reload is DEFERRED while an application is in flight, and says so', () => {
  const fn = background.slice(background.indexOf('async function handleExtReload'), background.indexOf('// MV3 evicts the service worker'));
  assert.ok(fn.length, 'handleExtReload must exist');
  assert.match(fn, /const busy = await extReloadInFlightCount\(\)/);
  // the busy check must come BEFORE the reload call
  assert.ok(fn.indexOf('extReloadInFlightCount()') < fn.indexOf('chrome.runtime.reload()'),
    'the in-flight check must gate the reload');
  assert.match(fn, /if \(busy > 0\)[\s\S]{0,400}ackExtReload\(token, 'deferred'/,
    'a deferral must be REPORTED, not silent');
  assert.match(fn, /return;\s*\n\s*}/, 'a deferral must not fall through to the reload');
});

test('the in-flight check FAILS SAFE — unknown counts as busy', () => {
  const fn = background.slice(background.indexOf('async function extReloadInFlightCount'), background.indexOf('async function ackExtReload'));
  assert.match(fn, /return 1;\s*\/\/ cannot tell/, 'an unknown state must be treated as busy');
});

// These two assert on CALL SITES, so line comments (which discuss chrome.runtime.reload by name)
// must be stripped first or the comment text is counted as a call.
const stripComments = (s) => s.replace(/^\s*\/\/.*$/gm, '');

test('the ack is sent BEFORE reloading (the reload kills any in-flight fetch)', () => {
  const fn = stripComments(background.slice(
    background.indexOf('async function handleExtReload'), background.indexOf('// MV3 evicts the service worker')));
  assert.ok(fn.indexOf("ackExtReload(token, 'reloading'") < fn.indexOf('chrome.runtime.reload()'),
    'an ack sent after chrome.runtime.reload() would never arrive');
});

test('chrome.runtime.reload is called exactly once, and only there', () => {
  const hits = stripComments(background).match(/chrome\.runtime\.reload\(\)/g) || [];
  assert.equal(hits.length, 1, `expected one reload call site, found ${hits.length}`);
  // and it lives inside handleExtReload, not anywhere else
  const fn = stripComments(background.slice(
    background.indexOf('async function handleExtReload'), background.indexOf('// MV3 evicts the service worker')));
  assert.equal((fn.match(/chrome\.runtime\.reload\(\)/g) || []).length, 1);
});

// ---------------------------------------------------------------------------
// idempotency + rate limiting
// ---------------------------------------------------------------------------

test('a token is acted on at most once, across service-worker evictions', () => {
  const fn = background.slice(background.indexOf('async function handleExtReload'), background.indexOf('// MV3 evicts the service worker'));
  assert.match(fn, /acted\.includes\(token\)/, 'a repeated token must be ignored');
  assert.match(fn, /chrome\.storage\.local/, 'the record must survive MV3 evicting the worker');
  assert.match(fn, /acted\.slice\(-20\)/, 'the record must be bounded');
});

test('both sides rate-limit, so a stuck caller cannot reload-loop the extension', () => {
  assert.match(background, /EXT_RELOAD_MIN_GAP_MS\s*=\s*5 \* 60 \* 1000/, 'client-side limit');
  assert.match(server, /EXT_RELOAD_MIN_INTERVAL_MS\s*=\s*5 \* 60 \* 1000/, 'server-side limit');
  const arm = server.slice(server.indexOf("pathname === '/ext/reload'"), server.indexOf("pathname === '/ext/reload-ack'"));
  assert.match(arm, /429/, 'arming too soon must be refused');
  assert.match(arm, /already: true/, 'arming twice must return the SAME token, not a second one');
  assert.match(arm, /409/, 'arming with no extension connected must fail loudly');
});

test('a deferred ack keeps the token armed; a terminal ack clears it', () => {
  const ack = server.slice(server.indexOf("pathname === '/ext/reload-ack'"), server.indexOf("pathname === '/ext/link'"));
  assert.match(ack, /if \(state !== 'deferred'\) \{ extLink\.reloadToken = ''/,
    'deferred must stay armed so the node is asked again when it goes idle');
  assert.match(ack, /stale: true/, 'an old token must be ignored');
});

// ---------------------------------------------------------------------------
// the version bump that makes a deployed copy identifiable
// ---------------------------------------------------------------------------

test('the manifest version was bumped and all three sources agree', () => {
  const v = (p) => JSON.parse(R(p)).version;
  const m = v('extension/manifest.json');
  // A FLOOR, not an equality. This guard used to pin the exact version of the release it shipped
  // with (11.122.0), which meant every subsequent bump failed the suite for no reason and the
  // number had to be hand-edited as a release chore. What it actually guards is "the deployed copy
  // is identifiable and the three sources are in step" — so check the shape, the floor, and the
  // agreement, and let the number move.
  const parts = String(m).split('.').map(Number);
  assert.match(String(m), /^11\.\d+\.\d+$/, 'manifest carries an 11.x.y version');
  assert.ok(parts[1] >= 122, `manifest at or past the 11.122 floor (got ${m})`);
  assert.equal(v('app/package.json'), m, 'app/package.json in sync');
  assert.equal(v('package.json'), m, 'root package.json in sync');
});
