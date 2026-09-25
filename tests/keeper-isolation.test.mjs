// PIERRE'S KEEPER MUST NEVER TOUCH ASHRAF'S NODE.
//
// Both instances run the SAME binary, "Job Application Tracker.exe". The only thing that tells them
// apart is the data directory: jat11-app-pierre on port 7744, jat11-app-dad on port 7745.
//
// laptop-app-keeper.ps1 replaces Pierre's app when port 7744 answers with the wrong token. That
// branch used to do `taskkill /IM 'Job Application Tracker.exe' /T /F`, which kills by IMAGE NAME,
// meaning every process with that name on the machine. Ashraf's applier went down with it, every
// time, and the keeper runs every three minutes.
//
// Caught live 2026-09-08: the keeper logged "wrong profile, replacing" at 12:29:12 and Ashraf's four
// processes all restarted at 12:30:2x. The overnight monitor put him back, so from the outside his
// app looked mysteriously flaky rather than shot by a keeper with no business touching it. He is on
// a trial.
//
// These are source assertions rather than behavioural ones: the script kills processes, so the only
// safe place to test it is on its text.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// CODE ONLY. These scripts carry long comments explaining the very mistakes being asserted
// against - the old `taskkill /IM` line is quoted verbatim in the keeper, and the comment names
// Ashraf's port and data directory to explain why they must not appear in the code. Matching raw
// text would fail on the explanation rather than on the behaviour, which is exactly what the first
// draft of this file did.
const codeOnly = (src) => src.split(/\r?\n/)
  .map((line) => line.replace(/#.*$/, ''))
  .filter((line) => line.trim())
  .join('\n');

const read = (name) => codeOnly(fs.readFileSync(path.join(here, '..', 'tools', 'laptop', name), 'utf8'));
const keeper = read('laptop-app-keeper.ps1');
const monitor = read('overnight-monitor.ps1');
const ctl = read('laptop-ctl.ps1');

test('the keeper never kills by image name', () => {
  assert.doesNotMatch(keeper, /taskkill\s+\/IM/i,
    'killing by image name cannot distinguish Pierre from Ashraf, they run the same binary');
});

test('the keeper selects processes by Pierre’s data directory', () => {
  assert.match(keeper, /CommandLine -match \[regex\]::Escape\(\$UD\)/,
    'the data directory is the only thing that separates the two instances');
  assert.match(keeper, /Stop-Process -Id \$p\.ProcessId/,
    'stop the matched PIDs, not everything sharing a name');
});

test('nothing in the keeper references Ashraf’s port or data directory', () => {
  assert.doesNotMatch(keeper, /7745|jat11-app-dad/,
    "Pierre's keeper has no business naming Ashraf's node at all");
});

test('the monitor may START Ashraf’s app but never stops anything', () => {
  // Self-heal 3 exists because Ashraf's own launcher blocks on the supervisor and so can never
  // re-run its own app check. Starting a missing app is safe; stopping one is not this script's job.
  assert.match(monitor, /7745/, 'the monitor is the thing that watches Ashraf’s port');
  assert.doesNotMatch(monitor, /Stop-Process|taskkill/i,
    'the overnight monitor must never kill anything, on either node');
});

test('laptop-ctl still refuses to reap Ashraf’s browser', () => {
  assert.match(ctl, /'Ashraf CfT'/);
  assert.match(ctl, /\$why = 'never - Ashraf lane'/,
    'the reaper must keep naming his lane and keep refusing it');
});
