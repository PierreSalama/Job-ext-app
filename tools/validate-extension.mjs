// Static contract validator for the extension half (no browser needed).
// Verifies manifest validity, that every referenced file exists, that
// web_accessible_resources cover the dynamic imports, and that the message
// types the content scripts/popup send are all handled in the service worker.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
let pass = 0, fail = 0; const out = [];
const ok = (c, m) => { if (c) { pass++; out.push('  PASS ' + m); } else { fail++; out.push('  FAIL ' + m); } };
const grp = (g) => out.push('\n■ ' + g);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

grp('Manifest');
const mf = JSON.parse(read('manifest.json'));
ok(mf.manifest_version === 3, 'manifest_version 3');
ok(/^11\./.test(mf.version), 'version is 11.x (' + mf.version + ')');
for (const p of ['storage', 'downloads', 'tabs', 'alarms', 'webNavigation', 'contextMenus'])
  ok(mf.permissions.includes(p), 'permission: ' + p);
ok(mf.background?.service_worker === 'background.js' && mf.background.type === 'module', 'module service worker');
ok(mf.content_scripts?.[0]?.all_frames === true, 'content script runs in all_frames (iframe capture)');
ok(mf.action?.default_popup === 'popup/popup.html', 'popup wired');

grp('Referenced files exist');
const refs = [
  mf.background.service_worker, mf.action.default_popup,
  ...Object.values(mf.action.default_icon || {}),
  ...mf.content_scripts.flatMap((c) => c.js),
];
for (const f of refs) ok(exists(f), 'file exists: ' + f);
for (const f of ['popup/popup.css', 'popup/popup.js', 'app/app.html', 'app/app.css', 'app/app.js', 'app/lib/themes.js', 'lib/api.js', 'lib/status.js'])
  ok(exists(f), 'file exists: ' + f);

grp('web_accessible_resources cover dynamic imports');
const war = (mf.web_accessible_resources?.[0]?.resources || []).join(' ');
// loader dynamically imports detector; detector imports executor + signals + sites + panel + lib
for (const need of ['content/detector.js', 'content/panel.js', 'content/executor.js', 'content/autofill.js', 'content/signals/*.js', 'content/sites/*.js', 'content/lib/*.js'])
  ok(war.includes(need), 'WAR lists: ' + need);
// executor.js STATICALLY imports ./replay.js (P5). A static import in a web-accessible module
// resolves against its chrome-extension:// URL, so replay.js itself must be web-accessible —
// otherwise the module load is blocked at runtime in BOTH Chrome and Firefox. (cross-browser P8)
{
  const execSrc = read('content/executor.js');
  const importsReplay = /from\s+['"]\.\/replay\.js['"]/.test(execSrc);
  ok(!importsReplay || war.includes('content/replay.js') || war.includes('content/*.js'),
    'WAR covers content/replay.js (statically imported by executor.js)');
}
for (const f of ['content/detector.js', 'content/panel.js', 'content/executor.js', 'content/autofill.js',
  'content/signals/forms.js', 'content/signals/intent.js', 'content/signals/success.js', 'content/signals/json-ld.js',
  'content/sites/index.js', 'content/sites/linkedin.js', 'content/lib/dom.js'])
  ok(exists(f), 'file exists: ' + f);

grp('Message contract: senders ↔ service-worker handlers');
const bg = read('background.js');
// every message type the SW must handle (from popup.js, loader.js, detector.js, executor.js)
const handled = [...bg.matchAll(/case '([\w.-]+)':/g)].map((m) => m[1]);
const popup = read('popup/popup.js');
const loader = read('content/loader.js');
const detector = read('content/detector.js');
const executor = read('content/executor.js');
const senders = popup + loader + detector + executor;
const sent = [...senders.matchAll(/type:\s*'([\w.-]+)'/g)].map((m) => m[1]);
// SW-bound messages (not the tab-bound jat11.* ones the SW SENDS to content)
const swBound = ['ping', 'app-health', 'pair-app', 'popup-state', 'check-app-update', 'check-ext-update',
  'download-app-installer', 'capture-now', 'pipeline-event', 'qa-record', 'api-call', 'task-progress', 'get-token', 'get-document'];
for (const t of swBound) ok(handled.includes(t), 'SW handles message: ' + t);
ok(sent.includes('jat11.page-state'), 'popup sends jat11.page-state (page card)');
// content-script-bound messages the SW/popup send → handled in loader
for (const t of ['jat11.reboot', 'jat11.capture-now', 'jat11.run-task', 'jat11.page-state'])
  ok(loader.includes(`'${t}'`), 'loader handles tab message: ' + t);

grp('Executor safety invariants');
ok(/NEVER_AUTOFILL_RX/.test(executor) && /ethnic|race|gender/.test(executor), 'executor guards EEO/demographic fields');
ok(/awaiting_review/.test(executor) && /mode === 'review'/.test(executor), 'review mode stops before final submit');
ok(/captchaOrLoginPresent/.test(executor), 'captcha/login detection present');
ok(/aiConfidenceMin/.test(executor), 'AI answers are confidence-gated');

grp('Dashboard host bootstrap');
const app = read('app/app.js');
ok(/get-token/.test(app) && /jatDesktop/.test(app), 'dashboard resolves token in both extension + desktop hosts');
ok(/canAutoRefresh/.test(app) && /activeElement/.test(app), 'no-refresh-while-editing guard present');

console.log(out.join('\n'));
console.log(`\n=== EXTENSION VALIDATION: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
