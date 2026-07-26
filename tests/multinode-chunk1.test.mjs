// Multi-node dashboard — Chunk 1: node registry + Auto-Apply node switcher (view-only).
//
// Pierre runs auto-apply on several machines (his main PC, a dedicated server laptop, his dad's
// laptop) and wants to view each machine's auto-apply from one dashboard: a switcher on the
// Auto-Apply page that re-points the whole page at the selected machine. Reads go DIRECT from the
// browser to the node's tailnet address (CORS + remoteAccess already allow it, the token is the
// access control). Chunk 1 is strictly view-only — remote Start/Stop is Chunk 2.
//
// These guard the two halves that unit-test cleanly:
//   1. BACKEND — the `nodes` registry lives in settings, defaults to empty, and round-trips.
//   2. CLIENT CONTRACT — the app.js plumbing invariants that make the switch safe: api() targets
//      self by default (so every existing call is unchanged), only the Auto-Apply route may target
//      a remote node, an unknown node falls back to self, boot loads the registry BEFORE the first
//      navigate (the race we hit and fixed), and a remote view is forced read-only.
// The live end-to-end switch (This PC / Laptop / Dad, real per-node numbers, read-only) was
// verified by driving the actual dashboard in a browser against the live laptop + dad nodes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));
const { DEFAULTS } = require(path.join(here, '..', 'app', 'src', 'config.js'));

// ---------------- BACKEND: the node registry ----------------
test('the node registry defaults to empty (single-machine setups see no switcher)', () => {
  assert.ok(Array.isArray(DEFAULTS.nodes), 'settings.nodes must exist and be an array');
  assert.equal(DEFAULTS.nodes.length, 0);
});

test('nodes round-trip through the DB and merge over the default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-mn-'));
  try {
    db.open(dir);
    assert.deepEqual(db.getSettings().nodes, [], 'fresh DB inherits the empty default');
    const nodes = [
      { id: 'laptop', name: 'Laptop (server)', baseUrl: 'http://100.104.86.34:7744', token: 'tok-a' },
      { id: 'dad', name: 'Dad', baseUrl: 'http://100.105.39.32:7744', token: 'tok-b' },
    ];
    db.patchSettings({ nodes });
    const got = db.getSettings().nodes;
    assert.equal(got.length, 2);
    assert.equal(got[0].id, 'laptop');
    assert.equal(got[0].baseUrl, 'http://100.104.86.34:7744');
    assert.equal(got[1].name, 'Dad');
    // the token is stored (the dashboard needs it to reach the node) and survives a re-read
    assert.equal(got[0].token, 'tok-a');
  } finally {
    try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// ---------------- CLIENT CONTRACT: app.js plumbing ----------------
// app.js is browser code (uses window/DOM), so we assert the invariants against its source — the
// same approach the repo already uses for park-label / eligibility guards. Each of these is a bug
// we would otherwise have shipped (two were caught live during this build).
const appJs = fs.readFileSync(path.join(here, '..', 'extension', 'app', 'app.js'), 'utf8');
const appJsMirror = fs.readFileSync(path.join(here, '..', 'app', 'src', 'app', 'app.js'), 'utf8');

test('the two dashboard copies stay byte-identical (mirror invariant)', () => {
  assert.equal(appJs, appJsMirror, 'extension/app/app.js and app/src/app/app.js must match exactly');
});

test('api() targets self by default — every existing call is unchanged', () => {
  // The resolved target is `opts.node || apiTarget || selfTarget()`; apiTarget starts null.
  assert.match(appJs, /let apiTarget = null;/, 'apiTarget must default to null (self)');
  assert.match(appJs, /const tgt = opts\.node \|\| apiTarget \|\| selfTarget\(\);/);
  assert.match(appJs, /function selfTarget\(\)\s*\{\s*return \{ base: state\.base, token: state\.token, isSelf: true/);
});

test('only the Auto-Apply route may point at a remote node', () => {
  // navigate() sets apiTarget for /queue and clears it (null → self) for every other route.
  assert.match(appJs, /apiTarget = \(path === '\/queue'\) \? \(aaTarget\(\)\.isSelf \? null : aaTarget\(\)\) : null;/);
});

test('an unknown / removed node falls back to self, never a dead target', () => {
  const body = appJs.slice(appJs.indexOf('function aaTarget()'));
  assert.match(body.slice(0, 400), /if \(!n \|\| !n\.baseUrl\) return selfTarget\(\);/);
});

test('boot loads the node registry BEFORE the first navigate (the race we fixed)', () => {
  // A page persisted on a remote node can only resolve it if state.nodes is already loaded, so the
  // first settings fetch must be AWAITED, not fire-and-forget, ahead of navigate().
  const bootStart = appJs.indexOf('async function boot(');
  const boot = appJs.slice(bootStart, appJs.indexOf('\n}', bootStart));
  assert.match(boot, /await getSettings\(true\)/, 'boot must await the first settings load');
  assert.ok(boot.indexOf('await getSettings(true)') < boot.indexOf('navigate();'),
    'settings (and thus state.nodes) must load before the first navigate()');
});

test('getSettings does not pollute the self cache while viewing a remote node', () => {
  const gs = appJs.slice(appJs.indexOf('async function getSettings('));
  assert.match(gs.slice(0, 600), /const remote = apiTarget && !apiTarget\.isSelf;/);
  assert.match(gs.slice(0, 600), /if \(remote\) \{ const rr = await api\('\/settings'\); return rr\.settings/);
});

test('a remote view disables the controls, always excluding the switcher', () => {
  assert.match(appJs, /if \(viewingRemote\)/);
  // every control is disabled, except the switcher (Chunk 2 also excludes the power button)
  assert.match(appJs, /v\.querySelectorAll\('button, input, select, textarea'\)\.forEach/);
  assert.match(appJs, /if \(elm === nodeSwitch/);
});

test('a 401 from a REMOTE node does not tear down the local dashboard', () => {
  // renderNotConnected() (the reconnect screen) must fire only for a self 401.
  assert.match(appJs, /if \(tgt\.isSelf\) renderNotConnected\(\);/);
});
