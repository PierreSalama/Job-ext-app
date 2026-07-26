// Publish the signed Firefox XPI so installed copies AUTO-UPDATE — no USB, no reinstall.
//
// Why this exists: an unlisted add-on is not on addons.mozilla.org, so Firefox has no update
// source unless the manifest names one. Without it the extension is frozen at whatever version
// was force-installed — exactly what stranded Dad's laptop with the app on 11.88.17 and the
// extension stuck on 11.88.16, needing a physical USB trip for every fix.
//
// How it works: build-firefox.mjs stamps browser_specific_settings.gecko.update_url into the
// Firefox manifest, pointing at firefox/updates.json on the PUBLIC release repo. This script
// copies the signed XPI + a generated updates.json into that repo's working copy. Firefox polls
// the manifest (~daily, and on browser start) and installs a newer signed XPI by itself.
//
// Run AFTER: npm run firefox:sign   (needs AMO keys)
// Usage:     node tools/publish-firefox-update.mjs [--commit]
//            --commit also git-commits + pushes the publish repo (v11 branch).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISH = join(ROOT, '..', '.v11-publish');
const ARTIFACTS = join(ROOT, 'dist-firefox-artifacts');
const RAW_BASE = 'https://raw.githubusercontent.com/PierreSalama/Job-ext-app/v11/firefox';

const version = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8')).version;
const addonId = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8'))
  .browser_specific_settings.gecko.id;

if (!existsSync(PUBLISH)) { console.error(`publish repo not found at ${PUBLISH}`); process.exit(1); }

// The XPI must match THIS version — the artifacts dir accumulates old signed builds.
const xpi = (existsSync(ARTIFACTS) ? readdirSync(ARTIFACTS) : []).find((f) => f.endsWith(`-${version}.xpi`));
if (!xpi) {
  console.error(`no signed XPI for ${version} in dist-firefox-artifacts — run: npm run firefox:sign`);
  process.exit(1);
}

const outDir = join(PUBLISH, 'firefox');
mkdirSync(outDir, { recursive: true });

// Keep the filename versioned so an older Firefox that hasn't polled yet can still fetch the exact
// build its manifest referenced (a single overwritten "latest.xpi" would break mid-rollout).
const xpiName = `jat-v11-firefox-${version}.xpi`;
copyFileSync(join(ARTIFACTS, xpi), join(outDir, xpiName));

// Firefox update manifest (schema: https://extensionworkshop.com/documentation/manage/updating-your-extension/)
const updates = {
  addons: {
    [addonId]: {
      updates: [{ version, update_link: `${RAW_BASE}/${xpiName}` }],
    },
  },
};
writeFileSync(join(outDir, 'updates.json'), JSON.stringify(updates, null, 2) + '\n');

console.log(`staged firefox/${xpiName}`);
console.log(`staged firefox/updates.json  → version ${version}`);
console.log(`update_link: ${RAW_BASE}/${xpiName}`);

if (process.argv.includes('--commit')) {
  const run = (cmd) => execSync(cmd, { cwd: PUBLISH, stdio: 'inherit' });
  run('git add firefox');
  try { run(`git commit -m "firefox extension ${version} — self-hosted auto-update"`); }
  catch { console.log('(nothing to commit)'); }
  run('git push origin v11');
  console.log('\npushed — installed Firefox copies will auto-update on their next poll.');
} else {
  console.log('\nstaged only. Re-run with --commit to push (Firefox picks it up on its next poll).');
}
