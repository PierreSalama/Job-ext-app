// Assemble the USB kit -> v11/dist-usb-kit/ (copy that folder onto the USB, done).
// The ONE-SCRIPT kit: Setup-JAT.ps1 does install + config + extension + connect + remote + report.
// Run AFTER:
//   1. cd app && npm run build:win   (app/dist/JAT-v11-setup.exe, with build/discovery present)
//   2. npm run firefox:sign          (dist-firefox-artifacts/*.xpi -- needs Pierre's AMO keys)
// Usage: node tools/usb-kit/assemble.mjs
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KIT = join(ROOT, 'dist-usb-kit');
const HERE = join(ROOT, 'tools', 'usb-kit');

rmSync(KIT, { recursive: true, force: true });
mkdirSync(KIT, { recursive: true });

let ok = true;
function put(src, dst, required, hint) {
  if (existsSync(src)) {
    cpSync(src, join(KIT, dst));
    const mb = (statSync(src).size / 1024 / 1024).toFixed(1);
    console.log(`ok   ${dst}  (${mb} MB)`);
  } else {
    console.log(`${required ? 'MISS' : 'skip'} ${dst} -- ${hint}`);
    if (required) ok = false;
  }
}

// The one script + what it needs beside it.
put(join(HERE, 'Setup-JAT.ps1'), 'Setup-JAT.ps1', true, 'missing from tools/usb-kit');
put(join(HERE, 'README.txt'), 'README.txt', true, 'missing from tools/usb-kit');
put(join(HERE, 'INDEED-DIAGNOSIS.md'), 'INDEED-DIAGNOSIS.md', true, 'missing from tools/usb-kit');
put(join(ROOT, 'app', 'dist', 'JAT-v11-setup.exe'), 'JAT-v11-setup.exe', true, 'run: cd app && npm run build:win');

// Pick the XPI that matches the EXTENSION's version, not the app's. The extension and the app can
// legitimately diverge by a patch (e.g. an app-only fix like the DB stale-lock recovery bumps the
// app to 11.88.17 while the unchanged, already-signed extension stays 11.88.16 -- re-signing
// identical code would be pointless). The XPI is the extension, so match on extension/manifest.json.
const version = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8')).version;
const artDir = join(ROOT, 'dist-firefox-artifacts');
const xpis = existsSync(artDir) ? readdirSync(artDir).filter((f) => f.endsWith('.xpi')) : [];
const xpi = xpis.find((f) => f.endsWith(`-${version}.xpi`));
if (xpi) { console.log(`     (extension: ${xpi} -> matches app version ${version})`); put(join(artDir, xpi), 'jat-v11-firefox.xpi', true, ''); }
else {
  console.log(`MISS jat-v11-firefox.xpi for version ${version} -- run: npm run firefox:sign (needs AMO keys).`
    + (xpis.length ? ` Found only: ${xpis.join(', ')}` : ''));
  ok = false;
}

console.log(ok
  ? `\nUSB kit ready -> ${KIT}\nCopy the whole folder onto the USB stick. On Dad's laptop: copy to Desktop, run Setup-JAT.ps1.`
  : '\nKit INCOMPLETE -- fix the MISS lines above and rerun.');
process.exit(ok ? 0 : 1);
