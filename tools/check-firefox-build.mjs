// Assert the Firefox build's manifest invariants — the contract build-firefox.mjs must never drift on.
// Run: node tools/check-firefox-build.mjs   (after build-firefox.mjs; wired into `npm run firefox:build`)
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist-firefox');

let failed = 0;
function assert(cond, name) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failed++;
}

const src = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8'));
const ff = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));

assert(ff.background?.scripts?.[0] === 'background.js' && !ff.background?.service_worker,
  'background is an EVENT PAGE (scripts, no service_worker)');
assert(ff.background?.type === 'module', 'background stays a module (static imports)');
assert(!ff.permissions.includes('tabGroups') && !ff.permissions.includes('system.display'),
  'chrome-only permissions stripped (tabGroups, system.display)');
assert(ff.permissions.includes('storage') && ff.permissions.includes('tabs') && ff.permissions.includes('scripting'),
  'core permissions intact');
assert(ff.browser_specific_settings?.gecko?.id === 'jat-v11@pierresalama.dev', 'gecko id present (signing identity)');
// Without update_url an unlisted add-on can NEVER update itself — every fix would need a physical
// USB trip (this stranded Dad's laptop with the extension frozen on 11.88.16). Must be https.
assert(/^https:\/\/.+\/updates\.json$/.test(ff.browser_specific_settings?.gecko?.update_url || ''),
  'update_url present (self-hosted auto-update)');
assert(ff.version === src.version, `version matches source (${src.version})`);
assert(JSON.stringify(ff.content_scripts) === JSON.stringify(src.content_scripts), 'content_scripts carried verbatim');
assert(existsSync(join(OUT, 'background.js')) && existsSync(join(OUT, 'content', 'loader.js')),
  'code files present in dist-firefox');

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nfirefox build checks: all green');
