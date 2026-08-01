// Multi-node dashboard — Chunk 2: remote Start/Stop from the Auto-Apply page.
//
// Chunk 1 made the Auto-Apply view point at any machine (read-only). Chunk 2 lets Pierre START or
// STOP the selected machine's auto-apply from his own dashboard — so he can stop the server laptop,
// start his main PC, and run them in parallel. Start/Stop just flips that node's autoApply.enabled
// through api()→node (verified live: clicking Start/Stop on a remote node flipped its server-side
// enabled true/false while other nodes stayed untouched).
//
// The two things that must hold for this to be safe:
//   • Start/Stop is the ONLY control re-enabled on a remote view; editing keywords/settings and
//     per-task retry/cancel stay disabled (that's a later chunk).
//   • stopAutoApplyTabs() closes THIS machine's tabs — it must NOT run when stopping a remote node,
//     or stopping the server from your main PC would kill your main PC's own run.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appJs = fs.readFileSync(path.join(here, '..', 'extension', 'app', 'app.js'), 'utf8');
const mirror = fs.readFileSync(path.join(here, '..', 'app', 'src', 'app', 'app.js'), 'utf8');

test('the two dashboard copies are still byte-identical', () => {
  assert.equal(appJs, mirror);
});

test('Start/Stop is re-enabled on a remote view; everything else stays disabled', () => {
  // Anchor on the CONTROLS block specifically. `if (viewingRemote) {` also appears earlier now (the
  // unreachable-node fallback in the /queue route), so indexOf() alone would slice the wrong block.
  const block = appJs.slice(appJs.indexOf("const powerBtn = v.querySelector('[data-power]');"));
  // the power button is captured and excluded from the blanket disable, alongside the switcher
  assert.match(block.slice(0, 500), /const powerBtn = v\.querySelector\('\[data-power\]'\);/);
  assert.match(block.slice(0, 500), /if \(elm === nodeSwitch \|\| elm === powerBtn\) return;/);
});

test('stopping a REMOTE node never closes this machine\'s tabs', () => {
  // stopAutoApplyTabs() is a local side-effect; it must be gated behind !viewingRemote.
  assert.match(appJs, /if \(!viewingRemote\) stopAutoApplyTabs\(\);/);
  // and it must NOT appear ungated anywhere in the power handler
  const handler = appJs.slice(appJs.indexOf("v.querySelector('[data-power]').addEventListener"));
  const stopBranch = handler.slice(0, handler.indexOf("state.settings = null;"));
  const ungated = stopBranch.split('\n')
    .filter((l) => !l.trim().startsWith('//'))   // ignore comments that merely mention it
    .filter((l) => /stopAutoApplyTabs\(\)/.test(l) && !/if \(!viewingRemote\)/.test(l));
  assert.equal(ungated.length, 0, 'stopAutoApplyTabs() must only be called via the !viewingRemote guard');
});

test('Start/Stop targets the selected node (goes through api(), which is apiTarget→node on /queue)', () => {
  const handler = appJs.slice(appJs.indexOf("v.querySelector('[data-power]').addEventListener"));
  const head = handler.slice(0, 900);
  assert.match(head, /await api\('\/settings', \{ method: 'PATCH', body: \{ autoApply: \{ enabled: true \} \} \}\)/);
  assert.match(head, /await api\('\/settings', \{ method: 'PATCH', body: \{ autoApply: \{ enabled: false \} \} \}\)/);
});

test('Start/Stop toasts name the machine when it is remote', () => {
  assert.match(appJs, /viewingRemote \? `Auto-apply started on \$\{aaTgt\.name\}`/);
  assert.match(appJs, /viewingRemote \? `Auto-apply stopped on \$\{aaTgt\.name\}`/);
});

test('the read-only banner now advertises Start/Stop (not "arrives next")', () => {
  assert.match(appJs, /you can <strong>Start\/Stop<\/strong> it from here/);
});
