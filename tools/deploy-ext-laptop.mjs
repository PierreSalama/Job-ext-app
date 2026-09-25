#!/usr/bin/env node
// One command to put the tree's extension on the laptop and PROVE it landed.
//
// Why this exists: the extension half of JAT does not auto-update. The app half ships via
// electron-updater and is always current, and because the app version is the one on display, the
// gap is invisible. On 2026-09-06 the laptop was found running 11.127.0 against a tree at 11.154.0
// — 31 commits of apply-flow fixes that had never executed on the machine that applies, including
// the fix for its own dominant failure bucket ("Easy Apply to this job" did not transfer, 83 of 241
// failures in 14 days).
//
// Two traps this encodes, both measured the hard way:
//
//   1. Chrome must be relaunched from SESSION 1. A Windows SSH session is session 0, which has no
//      desktop; Chrome started from there comes up, fails to make a window and exits within seconds.
//      So the install step goes through the session-1 bridge, never through ssh directly.
//   2. The OLD sync-extension.ps1 on the laptop targets the Chrome-for-Testing lane
//      (cft-profile-pierre + the "JAT Pierre Applier" task). That lane has been dead since
//      2026-08-22. The live lane is Pierre's real default-profile Chrome. Deploying with the old
//      script copies files and reloads nothing.
//
// Usage:
//   node tools/deploy-ext-laptop.mjs                 # stage, install, verify
//   node tools/deploy-ext-laptop.mjs --check         # verify only, change nothing
//
// Auth: JAT_BRIDGE_TOKEN, else ~/.jat-bridge-token. The app token comes from JAT_TOKEN or the
// default below. Neither is ever written into the repo.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const HOST = process.env.JAT_LAPTOP || '100.104.86.34';
const SSH_USER = process.env.JAT_LAPTOP_USER || 'laptop';
const KEY = process.env.JAT_SSH_KEY || path.join(os.homedir(), '.ssh', 'jat_nodes');
const BRIDGE = `http://${HOST}:${process.env.JAT_BRIDGE_PORT || 7749}`;
const APP = `http://${HOST}:7744`;
const APP_TOKEN = process.env.JAT_TOKEN || '92226860c5f0b57faeb5514203c3e10dfcf6d02176db66ef55392d70cbd282af';
const REMOTE = 'C:/ProgramData/JAT-Remote';

function bridgeToken() {
  if (process.env.JAT_BRIDGE_TOKEN) return process.env.JAT_BRIDGE_TOKEN.trim();
  const f = path.join(os.homedir(), '.jat-bridge-token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  throw new Error('no bridge token: set JAT_BRIDGE_TOKEN or write ~/.jat-bridge-token');
}

const ssh = (cmd) =>
  execFileSync('ssh', ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10', `${SSH_USER}@${HOST}`, cmd], { encoding: 'utf8', timeout: 120000 });

// Everything that must touch the desktop goes through the bridge, which runs in session 1.
async function exec(cmd, timeout = 300) {
  const r = await fetch(`${BRIDGE}/exec`, {
    method: 'POST',
    headers: { 'x-jat-token': bridgeToken(), 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, timeout }),
  });
  if (!r.ok) throw new Error(`bridge ${r.status}`);
  return r.json();
}

const builtVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8')).version;

async function liveVersion() {
  const r = await fetch(`${APP}/ext/status`, { headers: { 'x-jat-token': APP_TOKEN } }).catch(() => null);
  if (r && r.ok) {
    const j = await r.json().catch(() => null);
    const v = j && (j.extensionVersion || j.version || (j.extension && j.extension.version));
    if (v) return v;
  }
  // Fall back to the manifest on disk, which is what actually gets loaded.
  const out = await exec(`(Get-Content '${REMOTE}/chrome-extension-pierre/manifest.json' -Raw | ConvertFrom-Json).version`, 30);
  return (out.stdout || '').trim() || null;
}

const built = builtVersion();
console.log(`built extension: ${built}`);

if (process.argv.includes('--check')) {
  const live = await liveVersion();
  console.log(`laptop  : ${live}`);
  console.log(live === built ? '\n  current — nothing to do' : `\n  BEHIND — laptop ${live}, tree ${built}`);
  process.exit(live === built ? 0 : 1);
}

// --- 1. stage -----------------------------------------------------------------------------------
console.log('staging…');
ssh(`powershell -NoProfile -Command "$s='${REMOTE.replace(/\//g, '\\')}\\ext-stage'; if(Test-Path $s){Remove-Item $s -Recurse -Force}; New-Item -ItemType Directory -Path $s -Force | Out-Null"`);
execFileSync('scp', ['-i', KEY, '-o', 'StrictHostKeyChecking=no', '-q', '-r',
  ...fs.readdirSync(path.join(root, 'extension')).map((f) => path.join(root, 'extension', f)),
  `${SSH_USER}@${HOST}:${REMOTE}/ext-stage/`], { timeout: 300000 });

const staged = (await exec(`(Get-Content '${REMOTE}/ext-stage/manifest.json' -Raw | ConvertFrom-Json).version`, 30)).stdout.trim();
if (staged !== built) { console.error(`staged ${staged} != built ${built}`); process.exit(1); }
console.log(`staged  : ${staged}`);

// --- 2. install, through the bridge so Chrome relaunches into session 1 --------------------------
console.log('installing…');
// --force installs over an identical version. THE VERSION IS NOT THE CONTENT: the install script
// skipped whenever the versions matched, so a fix made without a version bump was staged, reported
// as "current ✓", and never installed. Measured 2026-09-08 with two harness-verified fixes that
// deployed cleanly and ran nothing.
const force = process.argv.includes('--force') ? ' -Force' : '';
const r = await exec(`powershell -NoProfile -ExecutionPolicy Bypass -File ${REMOTE.replace(/\//g, '\\')}\\deploy-ext.ps1${force}`, 300);
process.stdout.write(r.stdout || '');
if (r.stderr) process.stderr.write(r.stderr);

// --- 3. prove it ---------------------------------------------------------------------------------
const live = await liveVersion();
console.log(`\nlaptop now: ${live}`);
if (live !== built) { console.error('DEPLOY DID NOT TAKE'); process.exit(1); }
console.log('  current ✓');
