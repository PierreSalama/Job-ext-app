// AI Apply chunk 12 — one codebase, three faces, and the consent gate.
//
// `applicant` is Dad's laptop. He sees his progress, the questions waiting on him and his own
// details — not queue depth, not discovery providers, not AI settings. And nothing is applied for
// on his behalf until he has said yes, in his own words, once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const db = require(path.join(root, 'app', 'src', 'db.js'));

const appJs = fs.readFileSync(path.join(root, 'extension', 'app', 'app.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'extension', 'app', 'app.html'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'extension', 'app', 'app.css'), 'utf8');
const serverJs = fs.readFileSync(path.join(root, 'app', 'src', 'server.js'), 'utf8');

// The route table lifted out of the renderer, so these assertions test the SAME data the app uses
// rather than a copy that can drift away from it.
function routeRoles() {
  const m = appJs.match(/const ROUTE_ROLES = \{([\s\S]*?)\n\};/);
  assert.ok(m, 'ROUTE_ROLES not found');
  const out = {};
  for (const line of m[1].split('\n')) {
    const r = line.match(/'([^']+)':\s*'([^']*)'/);
    if (r) out[r[1]] = r[2].split(',').filter(Boolean);
  }
  return out;
}

// ---------------------------------------------------------------------------
// what each face can reach
// ---------------------------------------------------------------------------
test('an applicant can reach only their own four things', () => {
  const roles = routeRoles();
  const allowed = Object.entries(roles).filter(([, r]) => r.includes('applicant')).map(([p]) => p).sort();
  assert.deepEqual(allowed, ['/ai-apply', '/answers', '/documents', '/profile', '/settings'].sort());
});

test('an applicant CANNOT reach the machinery', () => {
  const roles = routeRoles();
  for (const p of ['/queue', '/aa-settings', '/pipeline', '/activity', '/needs-you', '/procedures']) {
    assert.ok(!roles[p].includes('applicant'), `${p} must not be on Dad's laptop`);
  }
});

test('the owner sees everything', () => {
  for (const r of Object.values(routeRoles())) assert.ok(r.includes('owner'));
});

test('every gated route is also tagged in the nav, and vice versa', () => {
  // A route allowed but not in the nav is unreachable; a nav item with no rule is a hole.
  const roles = routeRoles();
  for (const p of Object.keys(roles)) {
    assert.ok(appHtml.includes(`data-route="${p}"`), `${p} has a rule but no nav entry`);
  }
  const navRoutes = [...appHtml.matchAll(/data-route="([^"]+)"/g)].map((m) => m[1]);
  for (const p of navRoutes) {
    assert.ok(roles[p], `nav item ${p} has no role rule — it would be hidden from everyone but the owner`);
  }
});

test('every nav item carries a data-roles attribute', () => {
  const items = [...appHtml.matchAll(/<a href="#[^"]*" class="nav-item"[^>]*>/g)].map((m) => m[0]);
  assert.ok(items.length >= 12, 'sanity: the nav was found');
  for (const i of items) assert.match(i, /data-roles="/, `untagged nav item: ${i.slice(0, 70)}`);
});

// ---------------------------------------------------------------------------
// hiding is not enough
// ---------------------------------------------------------------------------
test('routes are GUARDED, not merely hidden', () => {
  assert.match(appJs, /if \(!roleAllows\(path\)\)/,
    'a hash URL can be typed or bookmarked — hiding the nav item stops nothing');
  assert.match(appJs, /ROLE_HOME\[appRole\(\)\]/, 'and it must land somewhere they are allowed');
});

test('an unknown route is denied to a non-owner rather than allowed by default', () => {
  const m = appJs.match(/function roleAllows[\s\S]*?\n\}/);
  assert.ok(m);
  assert.match(m[0], /allowed === undefined \? false :/,
    'a new page must default to hidden on Dad\'s laptop, not to visible');
});

test('an empty nav section hides itself', () => {
  assert.match(appJs, /nav-section/);
  assert.match(appJs, /if \(!any\) h\.hidden = true/);
});

// ---------------------------------------------------------------------------
// consent
// ---------------------------------------------------------------------------
test('consent is a dated record, not a boolean somebody flipped', () => {
  const cfg = require(path.join(root, 'app', 'src', 'config.js'));
  assert.equal(cfg.DEFAULTS.app.role, 'owner', 'a fresh install must not assume it is a companion');
  assert.equal(cfg.DEFAULTS.app.consentAt, '', 'and must not assume consent');
  assert.match(appJs, /consentAt: new Date\(\)\.toISOString\(\)/);
});

test('THE ONE THAT MATTERS: the server refuses to start a run without consent', () => {
  const block = serverJs.slice(serverJs.indexOf("pathname === '/ai-apply/start'"));
  assert.match(block.slice(0, 900), /role === 'applicant' && !appCfg\.consentAt/);
  assert.match(block.slice(0, 900), /NO_CONSENT/);
  assert.match(block.slice(0, 900), /403/,
    'a UI gate stops the button, not a scheduled task, another node, or a stale tab');
});

test('the consent screen says what it will never do', () => {
  const gate = appJs.slice(appJs.indexOf('function consentGate'), appJs.indexOf('function consentGate') + 2600);
  for (const promise of ['never', 'password', 'human check', 'race, gender, disability']) {
    assert.ok(gate.toLowerCase().includes(promise.toLowerCase()), `the consent text must mention: ${promise}`);
  }
  assert.match(gate, /withdraw this at any time/i);
});

test('the consent gate blocks the page, it is not a banner beside it', () => {
  assert.match(appJs, /const gate = consentGate\(\);\s*\n\s*if \(gate\) return gate;/,
    'on an applicant install the page must show this and nothing else');
});

// ---------------------------------------------------------------------------
// the setting itself
// ---------------------------------------------------------------------------
test('the role survives a round trip through the database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-role-'));
  db.open(dir);
  try {
    assert.equal(db.getSettings().app.role, 'owner');
    db.patchSettings({ app: { role: 'applicant' } });
    assert.equal(db.getSettings().app.role, 'applicant');
    assert.equal(db.getSettings().app.consentAt, '', 'switching role must not grant consent');
    db.patchSettings({ app: { consentAt: '2026-09-04T00:00:00.000Z' } });
    assert.equal(db.getSettings().app.role, 'applicant', 'and consent must not reset the role');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the consent screen is styled and themes cleanly', () => {
  assert.ok(appCss.includes('.consent'));
  const block = appCss.slice(appCss.indexOf('/* ---------- Companion: consent gate'));
  assert.deepEqual(block.match(/#[0-9a-f]{3,8}\b/gi) || [], []);
});

test('the dashboard copies are byte-identical', () => {
  for (const f of ['app.js', 'app.css', 'app.html']) {
    const a = fs.readFileSync(path.join(root, 'extension', 'app', f));
    const b = fs.readFileSync(path.join(root, 'app', 'src', 'app', f));
    assert.ok(a.equals(b), `${f} drifted — run \`npm run mirror\``);
  }
});
