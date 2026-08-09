// A busy node must still be able to install an update.
//
// tryIdleInstall's data-safety gate required the auto-apply pool to be FULLY drained —
// active === 0 AND scheduled === 0 AND queuedDepth === 0 — before quitAndInstall.
// Discovery refills the queue continuously, so a healthy working node never has an empty queue and
// therefore could NEVER install an update.
//
// Live 2026-08-09: the PC downloaded 11.90.18 at 05:21 and was still running 11.90.17 hours later,
// re-downloading the same installer every 30 minutes ("update available: 11.90.18" → "Downloading
// update" → nothing, repeatedly). The failure mode is the worst kind: every reliability fix we ship
// silently never reaches the nodes that are busy — i.e. exactly the ones that need them.
//
// The distinction that matters: ACTIVE/SCHEDULED work is in flight and has state a restart would
// lose. QUEUED work has not started, lives in the database, and is picked straight back up after
// relaunch. Queue depth is not a safety signal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const main = fs.readFileSync(path.join(here, '..', 'app', 'src', 'main.js'), 'utf8');
const gate = main.slice(main.indexOf('function tryIdleInstall'), main.indexOf('function setupAutoUpdater'));

const H = 3600000;
// Mirror the gate's decision: may we install right now? `waitingMs` is how long the downloaded
// update has been pending — the gate relaxes as that grows, because an update that never lands is
// the same bug in a slower disguise.
function mayInstall({ enabled, active, scheduled, queuedDepth, waitingMs = 0 }) {
  if (!enabled) return true;                 // pool is off — nothing to protect
  if (waitingMs < 4 * H) return active === 0 && scheduled === 0;   // queuedDepth NOT consulted
  if (waitingMs < 12 * H) return active === 0;
  return true;                               // 12h+ — startup recovery reclaims anything in flight
}

test('the live deadlock: a busy node with a full queue can now install', () => {
  assert.equal(mayInstall({ enabled: true, active: 0, scheduled: 0, queuedDepth: 56 }), true,
    'PC had 56 queued and was stuck on an old build for hours');
  assert.equal(mayInstall({ enabled: true, active: 0, scheduled: 0, queuedDepth: 122 }), true,
    'laptop steady state is ~120 queued — it must not be permanently ineligible');
});

test('in-flight work still blocks a restart — the safety property is preserved', () => {
  assert.equal(mayInstall({ enabled: true, active: 1, scheduled: 0, queuedDepth: 0 }), false,
    'an application actively running must never be interrupted');
  assert.equal(mayInstall({ enabled: true, active: 0, scheduled: 2, queuedDepth: 0 }), false,
    'dispatched-but-not-started work has state a restart would lose');
  assert.equal(mayInstall({ enabled: true, active: 3, scheduled: 4, queuedDepth: 99 }), false);
});

test('with auto-apply off there is nothing to protect', () => {
  assert.equal(mayInstall({ enabled: false, active: 0, scheduled: 0, queuedDepth: 500 }), true);
});

test('the implementation no longer consults queuedDepth', () => {
  assert.match(gate, /live\.active > 0 \|\| live\.scheduled > 0/,
    'in-flight work must still gate the install');
  assert.doesNotMatch(gate, /live\.queuedDepth > 0/,
    'regression: queue depth is never zero on a working node, so this is a permanent deadlock');
});

// --- escalation: the update must actually LAND ---------------------------------------------------
// Dropping queuedDepth alone does not guarantee delivery. A healthy node applies almost
// continuously, so "nothing in flight" is a narrow window a 60s poll can miss forever. Measured on
// the PC: active=1 on 11 of 12 samples across five minutes.
test('a permanently busy node still gets the update eventually', () => {
  const busy = { enabled: true, active: 1, scheduled: 0, queuedDepth: 57 };
  assert.equal(mayInstall({ ...busy, waitingMs: 1 * H }), false, 'fresh: stay fully safe');
  assert.equal(mayInstall({ ...busy, waitingMs: 6 * H }), false, 'still protects a RUNNING apply');
  assert.equal(mayInstall({ ...busy, waitingMs: 13 * H }), true,
    'after half a day a stuck update costs more than one interrupted application');
});

test('the 4h step only relaxes SCHEDULED, never a running application', () => {
  const scheduledOnly = { enabled: true, active: 0, scheduled: 2, queuedDepth: 10 };
  assert.equal(mayInstall({ ...scheduledOnly, waitingMs: 1 * H }), false);
  assert.equal(mayInstall({ ...scheduledOnly, waitingMs: 5 * H }), true,
    'dispatched-but-not-started is reclaimed by reconcileStaleRunning on restart');

  const running = { enabled: true, active: 1, scheduled: 0, queuedDepth: 10 };
  assert.equal(mayInstall({ ...running, waitingMs: 5 * H }), false,
    'a RUNNING application must still be protected at this step');
});

test('a quiet node installs immediately — escalation never delays the normal case', () => {
  assert.equal(mayInstall({ enabled: true, active: 0, scheduled: 0, queuedDepth: 122, waitingMs: 0 }), true);
});

test('the implementation escalates on how long the install has waited', () => {
  assert.match(gate, /waitingMs/, 'must consider how long the update has been pending');
  assert.match(gate, /4 \* 3600000/, '4h step');
  assert.match(gate, /12 \* 3600000/, '12h step');
  assert.match(gate, /startup recovery will reclaim them/i,
    'forcing an install past in-flight work must be logged, not silent');
});

test('the other gates are untouched — grace, idle, suspend, pairing', () => {
  assert.match(gate, /graceMinutes/, 'grace window still applies');
  assert.match(gate, /getSystemIdleTime/, 'machine must still be idle');
  assert.match(gate, /suspended \|\| pendingPair/, 'asleep / mid-pairing still blocks');
  assert.match(gate, /au\.mode !== 'auto'/, 'manual-mode nodes (the laptop) still never auto-install');
});
