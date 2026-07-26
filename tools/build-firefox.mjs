// Build the FIREFOX flavor of the v11 extension → dist-firefox/ (+ zip in dist-firefox-artifacts/).
//
// The runtime code is already cross-browser (P8: every chrome.tabGroups/system.display call is
// guarded via CAPS, state lives in storage.local). What Firefox needs is a MANIFEST flavor:
//   • background: Firefox MV3 runs EVENT PAGES ({scripts, type:module}), not service_worker.
//     Chrome's manifest keeps service_worker; this build swaps the key. Same background.js byte-for-byte.
//   • permissions: strip the Chrome-only ones Firefox doesn't recognize (tabGroups, system.display) —
//     the code never calls them un-guarded, and AMO lint flags unknown permissions.
//   • everything else (content scripts, WAR, gecko id, icons) carries verbatim.
//
// Usage:  node tools/build-firefox.mjs            → dist-firefox/ + dist-firefox-artifacts/jat-v11-firefox-<version>.zip
// Then:   npx web-ext lint -s dist-firefox        (wired into `npm run firefox:build` / `firefox:lint`)
// Sign:   node tools/sign-firefox.mjs             (needs AMO_JWT_ISSUER / AMO_JWT_SECRET — Pierre's AMO keys)

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'extension');
const OUT = join(ROOT, 'dist-firefox');
const ARTIFACTS = join(ROOT, 'dist-firefox-artifacts');

// Chrome-only permissions Firefox rejects/warns on. The code guards every use (CAPS map).
const CHROME_ONLY_PERMISSIONS = new Set(['tabGroups', 'system.display']);

// Where Firefox looks for extension updates. Served from the PUBLIC release repo (the same repo
// electron-updater already uses for the app), so no extra hosting to run or pay for. Both this
// file and the signed XPI it points at are committed to the v11 branch by tools/publish-firefox-update.mjs.
const FIREFOX_UPDATE_URL = 'https://raw.githubusercontent.com/PierreSalama/Job-ext-app/v11/firefox/updates.json';

function main() {
  const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
  if (!manifest.browser_specific_settings?.gecko?.id) {
    throw new Error('manifest.json is missing browser_specific_settings.gecko.id — required for signing');
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  cpSync(SRC, OUT, { recursive: true });

  // --- Firefox manifest flavor -------------------------------------------------------------------
  const ff = structuredClone(manifest);
  ff.background = { scripts: ['background.js'], type: 'module' }; // event page; same file
  ff.permissions = (ff.permissions ?? []).filter((p) => !CHROME_ONLY_PERMISSIONS.has(p));
  // SELF-HOSTED AUTO-UPDATE. An unlisted add-on is not on addons.mozilla.org, so Firefox has no
  // update source unless the manifest names one — without this the extension is frozen at whatever
  // version was force-installed, and every fix needs a USB trip (that is exactly what happened to
  // Dad's laptop: app on 11.88.17, extension stuck on 11.88.16). Firefox polls this manifest
  // roughly daily and installs a newer signed XPI on its own.
  ff.browser_specific_settings.gecko.update_url = FIREFOX_UPDATE_URL;
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(ff, null, 2) + '\n');

  // --- zip artifact (manifest at zip ROOT — Firefox refuses nested zips) ------------------------
  mkdirSync(ARTIFACTS, { recursive: true });
  const zipName = `jat-v11-firefox-${manifest.version}.zip`;
  const zipPath = join(ARTIFACTS, zipName);
  rmSync(zipPath, { force: true });
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${OUT}\\*' -DestinationPath '${zipPath}' -Force"`,
    { stdio: 'inherit' },
  );

  console.log(`[firefox] built ${OUT}`);
  console.log(`[firefox] zip   ${zipPath}`);
  console.log(`[firefox] background: event page (scripts) · stripped permissions: ${[...CHROME_ONLY_PERMISSIONS].join(', ')}`);
  if (!existsSync(join(OUT, 'background.js'))) throw new Error('background.js missing from dist-firefox');
}

main();
