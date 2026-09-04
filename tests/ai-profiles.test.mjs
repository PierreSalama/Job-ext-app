// AI Apply chunk 10 — two people, two browsers, two sets of logins.
//
// "Make it so I can do it with my logins and or my dad's." The rules that make that safe:
// separate profile directories, separate ports, and profiles that PERSIST so a sign-in is done
// once rather than every night.
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
const cdp = require(path.join(root, 'app', 'src', 'browser', 'cdp.js'));
const pb = require(path.join(root, 'app', 'src', 'ai', 'profile-browsers.js'));

// ---------------------------------------------------------------------------
// where a login lives
// ---------------------------------------------------------------------------
test('THE BUG THIS CHUNK FIXED: browser profiles are not kept in temp', () => {
  const dir = cdp.profileDir('pierre');
  const tmp = path.resolve(os.tmpdir()).toLowerCase();
  assert.ok(!path.resolve(dir).toLowerCase().startsWith(tmp),
    'Windows cleans %TEMP% — a profile there would silently sign both people out');
});

test('the profile root is configurable, so it can sit beside the database', () => {
  const original = cdp.profileRoot();
  try {
    const target = path.join(os.tmpdir(), 'jat-root-test');
    cdp.setProfileRoot(target);
    assert.equal(path.dirname(cdp.profileDir('dad')), target);
  } finally {
    cdp.setProfileRoot(original);
  }
});

test('two people never share a directory or a port', () => {
  assert.notEqual(cdp.profileDir('pierre'), cdp.profileDir('dad'));
  assert.notEqual(pb.signinPortFor('pierre'), pb.signinPortFor('dad'));
  // Stable across restarts, so a person is always on the same window.
  assert.equal(pb.signinPortFor('pierre'), pb.signinPortFor('pierre'));
});

test('a sign-in window can never collide with a run browser', () => {
  const runner = require(path.join(root, 'app', 'src', 'ai', 'apply-runner.js'));
  for (const id of ['pierre', 'dad', '', 'someone-else', 'a', 'zzz']) {
    const runPort = runner._portFor(id);
    const signinPort = pb.signinPortFor(id);
    assert.notEqual(runPort, signinPort);
    assert.ok(runPort >= 9230 && runPort < 9290, `run port ${runPort} out of its range`);
    assert.ok(signinPort >= 9400 && signinPort < 9460, `sign-in port ${signinPort} out of its range`);
  }
});

test('a profile id cannot escape its directory', () => {
  const evil = cdp.profileDir('../../Windows/System32');
  assert.doesNotMatch(path.basename(evil), /[\\/.]{2}/);
  assert.equal(path.dirname(evil), cdp.profileRoot());
});

// ---------------------------------------------------------------------------
// signed-in state
// ---------------------------------------------------------------------------
test('a profile that has never been used reports that it needs signing in', () => {
  const s = pb.status(`never-used-${Date.now()}`);
  assert.equal(s.signedInBefore, false);
  assert.equal(s.browserOpen, false);
});

test('a profile with real Chrome state reports as signed in', () => {
  const original = cdp.profileRoot();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-prof-'));
  try {
    cdp.setProfileRoot(tmp);
    const id = 'has-session';
    fs.mkdirSync(path.join(cdp.profileDir(id), 'Default'), { recursive: true });
    assert.equal(cdp.profileIsInitialised(id), false, 'an empty folder is not a session');
    fs.writeFileSync(path.join(cdp.profileDir(id), 'Default', 'Cookies'), 'x');
    assert.equal(cdp.profileIsInitialised(id), true, 'a cookie store is');
    assert.equal(pb.status(id).signedInBefore, true);
  } finally {
    cdp.setProfileRoot(original);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// safety
// ---------------------------------------------------------------------------
test('signing in is refused while that person has a run using the browser', async () => {
  await assert.rejects(
    () => pb.openSignin('busy-person', { isRunning: () => true }),
    (e) => e.code === 'PROFILE_BUSY',
  );
});

test('closing a browser that is not open says so rather than pretending', async () => {
  const r = await pb.closeSignin('not-open-at-all');
  assert.equal(r.ok, false);
  assert.match(r.reason, /no sign-in browser/);
});

test('there is no way to make this module type a credential', () => {
  const src = fs.readFileSync(path.join(root, 'app', 'src', 'ai', 'profile-browsers.js'), 'utf8');
  for (const forbidden of ['insertText', 'dispatchKeyEvent', 'password', 'setFileInputFiles']) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(src.replace(/\/\/.*$/gm, '')),
      `${forbidden} must not appear — signing in is the human's job`);
  }
});

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
const serverJs = fs.readFileSync(path.join(root, 'app', 'src', 'server.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(root, 'app', 'src', 'main.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'extension', 'app', 'app.js'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'extension', 'app', 'app.css'), 'utf8');

test('profiles are listed with their browser state and their open blocks', () => {
  assert.ok(serverJs.includes("pathname === '/ai-apply/profiles'"));
  const block = serverJs.slice(serverJs.indexOf("pathname === '/ai-apply/profiles'"));
  assert.match(block, /profileBrowsers\.status\(p\.id\)/);
  assert.match(block, /applyRunner\.isRunning\(p\.id\)/);
  assert.match(block, /aiBlockCounts\(p\.id\)/);
});

test('the app stores browser profiles beside the database, not in temp', () => {
  assert.match(mainJs, /setProfileRoot\(path\.join\(app\.getPath\('userData'\), 'chrome-profiles'\)\)/);
});

test('THE ONE THAT MATTERS: starting a run sends the selected person', () => {
  const start = appJs.slice(appJs.indexOf("api('/ai-apply/start'"));
  assert.match(start.slice(0, 600), /profileId: activeId/,
    'without this an application goes out under the wrong name while the page says otherwise');
});

test('the selected person survives a page reload', () => {
  assert.match(appJs, /localStorage\.getItem\(LS_AI_PROFILE\)/);
  assert.match(appJs, /setAiProfileId/);
});

test('the page asks for status and blocks scoped to the selected person', () => {
  assert.match(appJs, /api\(`\/ai-apply\/status\$\{q\}`\)/);
  assert.match(appJs, /api\(`\/ai-apply\/blocks\$\{q\}`\)/);
});

test('each profile state has a style, and the styles theme cleanly', () => {
  for (const s of ['running', 'ready', 'needs-signin']) {
    assert.ok(appCss.includes(`.ai-prof[data-state="${s}"]`), `no style for ${s}`);
  }
  assert.ok(appCss.includes('.ai-prof.active'), 'the selected person must be unmistakable');
  const block = appCss.slice(appCss.indexOf('/* ---------- AI Apply: who is applying'));
  assert.deepEqual(block.match(/#[0-9a-f]{3,8}\b/gi) || [], []);
});

test('the dashboard copies are byte-identical', () => {
  for (const f of ['app.js', 'app.css', 'app.html']) {
    const a = fs.readFileSync(path.join(root, 'extension', 'app', f));
    const b = fs.readFileSync(path.join(root, 'app', 'src', 'app', f));
    assert.ok(a.equals(b), `${f} drifted — run \`npm run mirror\``);
  }
});
