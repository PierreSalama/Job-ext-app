// Auto-apply must survive an update restart, and every flip must be attributable.
//
// An auto-install deliberately quits and relaunches the app. On the PC, auto-apply came back OFF
// after the restart FOUR separate times on 2026-08-09, each needing a manual re-enable — a node that
// looks healthy but silently applies to nothing.
//
// I could not identify what clears it. Ruled out by inspection: the app's quit path (nothing there
// touches the setting), migrations, the extension's automatic paths (only the dashboard's Start/Stop
// button writes it), a one-at-a-time enforcer, and scheduled tasks on that machine. Nothing recorded
// the transition, so there was no way to attribute it.
//
// Two responses, deliberately independent of the unknown cause:
//   1. SURVIVABILITY — if the engine was running when we chose to restart, it is running afterwards.
//   2. OBSERVABILITY — every on/off flip is attributed, so the next occurrence is one query.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const main = read('app', 'src', 'main.js');
const server = read('app', 'src', 'server.js');

// Mirror the resume decision.
const resume = ({ flag, enabledNow }) => Number(flag) === 1 && !enabledNow;

test('the live case: ON before the update, OFF after → restored', () => {
  assert.equal(resume({ flag: 1, enabledNow: false }), true);
});

test('if it survived on its own, nothing is changed', () => {
  assert.equal(resume({ flag: 1, enabledNow: true }), false,
    're-patching an already-on engine would reset startedAt and the running-for timer');
});

test('a node deliberately left OFF is NOT switched on by an update', () => {
  assert.equal(resume({ flag: 0, enabledNow: false }), false,
    'the PC is often intentionally off — an update must never start applying behind Pierre');
});

test('the flag is recorded at the moment we choose to restart', () => {
  const fn = main.slice(main.indexOf('function tryIdleInstall'), main.indexOf('function setupAutoUpdater'));
  assert.match(fn, /autoApplyResumeAfterUpdate/, 'must capture the state before quitting');
  const iSet = fn.indexOf('autoApplyResumeAfterUpdate');
  const iQuit = fn.indexOf('quitAndInstall');
  assert.ok(iSet > -1 && iQuit > -1 && iSet < iQuit,
    'capturing after quitAndInstall would never run — the process is gone');
});

test('the flag is consumed exactly once', () => {
  const boot = main.slice(main.indexOf('app.whenReady'));
  const block = boot.slice(0, boot.indexOf('reclaimDeadParks'));
  assert.match(block, /kvSet\('autoApplyResumeAfterUpdate', 0\)/,
    'leaving it set would re-enable on every later launch, overriding a deliberate OFF');
  const iClear = block.indexOf("kvSet('autoApplyResumeAfterUpdate', 0)");
  const iPatch = block.indexOf('patchSettings');
  assert.ok(iClear < iPatch, 'clear before restoring, so a crash mid-restore cannot loop');
});

test('the restore is logged as the anomaly it is', () => {
  const boot = main.slice(main.indexOf('app.whenReady'));
  assert.match(boot.slice(0, boot.indexOf('reclaimDeadParks')), /came back OFF — restored/,
    'a silent restore would hide that the underlying cause is still unknown');
});

test('every on/off flip is attributed, and only on a real change', () => {
  const fn = server.slice(server.indexOf("if (body.autoApply && typeof body.autoApply.enabled === 'boolean')"));
  const block = fn.slice(0, fn.indexOf('db.patchSettings'));
  assert.match(block, /wasOn !== body\.autoApply\.enabled/, 'no-op writes must not spam the log');
  assert.match(block, /user-agent/, 'the caller must be identified');
  assert.match(block, /autoApplyLastToggle/, 'the last flip must be queryable, not only in a log file');
});

test('startedAt handling is unchanged', () => {
  const fn = server.slice(server.indexOf("if (body.autoApply && typeof body.autoApply.enabled === 'boolean')"));
  const block = fn.slice(0, fn.indexOf('db.patchSettings'));
  assert.match(block, /body\.autoApply\.startedAt = new Date\(\)\.toISOString\(\)/, 'ON stamps the timer');
  assert.match(block, /body\.autoApply\.startedAt = ''/, 'OFF clears it');
});
