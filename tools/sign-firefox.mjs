// Sign the Firefox build as an UNLISTED add-on via Mozilla's signing API → a permanent .xpi
// Dad double-clicks once in Firefox. (Temporary about:debugging loads vanish on every restart —
// that was the trial's install pain; a signed unlisted XPI is the fix.)
//
// Prereqs (one-time, Pierre):
//   1. Log in at https://addons.mozilla.org  (create the free account if needed)
//   2. Tools ▸ Manage API Keys → generate credentials
//   3. Put them in the environment (PowerShell):
//        $env:AMO_JWT_ISSUER = "user:12345678:123"
//        $env:AMO_JWT_SECRET = "<64-hex-chars>"
//
// Usage:  node tools/build-firefox.mjs && node tools/sign-firefox.mjs
// Output: dist-firefox-artifacts/*.xpi  (signed; installable permanently in any Firefox)
//
// Notes: channel=unlisted means it is NOT published on addons.mozilla.org — Mozilla only signs it.
// First-ever sign of this add-on ID registers it to the AMO account; keep using the same account.

import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'dist-firefox');
const ARTIFACTS = join(ROOT, 'dist-firefox-artifacts');

const issuer = process.env.AMO_JWT_ISSUER;
const secret = process.env.AMO_JWT_SECRET;
if (!issuer || !secret) {
  console.error('AMO_JWT_ISSUER / AMO_JWT_SECRET are not set — see the header of this file for the 3 one-time steps.');
  process.exit(1);
}
if (!existsSync(join(SRC, 'manifest.json'))) {
  console.error('dist-firefox/ missing — run `node tools/build-firefox.mjs` first.');
  process.exit(1);
}

execSync(
  `npx web-ext sign --source-dir "${SRC}" --artifacts-dir "${ARTIFACTS}" --channel unlisted ` +
  `--api-key "${issuer}" --api-secret "${secret}"`,
  { stdio: 'inherit', cwd: ROOT },
);
console.log(`[firefox] signed XPI in ${ARTIFACTS}`);
