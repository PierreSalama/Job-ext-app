// WINNING THE RACE THE SUBMIT NAVIGATION USED TO WIN.
//
// The executor proves a submit AFTER clicking: confirmSubmitted waits up to 15s for the
// confirmation to settle, then report() sends the evidence. On any ATS whose confirmation is a NEW
// DOCUMENT, none of that code is ever reached — the click destroys the content world first. Live
// 2026-08-24 all seven of the ATS lane's genuine submissions ended exactly at
// `isFinalSubmit("Submit application")=true`, five of them with "Thank you for applying" visible on
// screen and nothing left alive to read it.
//
// Two halves, one per test group:
//
//   1. executor.js writes a submit-intent sentinel to sessionStorage and AWAITS its transcript PATCH
//      BEFORE the click. sessionStorage because it is synchronous (a promise would be lost to the
//      navigation) and per-tab (chrome.storage is profile-wide, and a warm apply tab cycling jobs
//      would let one job's sentinel be read on another job's page).
//
//   2. detector.js reads it on the next document. Reaching that code with a sentinel present IS the
//      proof that a new document loaded after the click — init() runs once per document, and in the
//      clicking document it had already run long before the sentinel existed. So a success signal
//      there is a post-click, NEW-DOCUMENT signal, gated on the same formGrounded flag R1 requires.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const detectorUrl = pathToFileURL(path.join(here, '..', 'extension', 'content', 'detector.js')).href;
const executorSrc = fs.readFileSync(path.join(here, '..', 'extension', 'content', 'executor.js'), 'utf8');

// =============================================================================================
// 1 — the executor writes the intent BEFORE it clicks
// =============================================================================================

test('the sentinel and its awaited PATCH are written BEFORE syntheticClick', () => {
  const write = executorSrc.indexOf('writeSubmitIntent({');
  const patch = executorSrc.indexOf('await reportNow({');
  const click = executorSrc.indexOf('syntheticClick(clickBtn);');
  assert.ok(write > 0, 'the submit-intent write must exist');
  assert.ok(patch > write, 'the transcript marker follows the sentinel');
  assert.ok(click > patch,
    'ORDERING IS THE WHOLE FIX: anything written after the click can be erased by the navigation');
});

test('the transcript marker carries the grounded flag the server reasons about', () => {
  // db.js SUBMIT_INTENT_GROUNDED_RX matches `submit-intent .*grounded=true`; if the executor stops
  // emitting that shape, every race-loss silently degrades to "unknown" again.
  assert.match(executorSrc, /note: `submit-intent url=\$\{pagePathOf\(\)\} grounded=\$\{formGrounded\}/);
});

test('a run that reaches its OWN verdict clears the sentinel', () => {
  // Otherwise a later document in the same warm tab could re-report a submit the executor already
  // adjudicated.
  const clears = executorSrc.match(/clearSubmitIntent\(\)/g) || [];
  assert.ok(clears.length >= 2, 'both the verified and the unverified verdict must clear it');
});

test('the sentinel is sessionStorage — not chrome.storage, not localStorage', () => {
  assert.match(executorSrc, /sessionStorage\.setItem\(SUBMIT_INTENT_KEY/);
  assert.doesNotMatch(executorSrc, /localStorage\.setItem\(SUBMIT_INTENT_KEY/);
});

test('the pre-click flush is BOUNDED — a down app must not park the run at the submit button', () => {
  // send() gives every message SEND_TIMEOUT_MS + 5s, and reportQueue is a shared chain, so an
  // unbounded await here would stall in front of the submit for ~35s per unreachable report.
  assert.match(executorSrc, /const REPORT_FLUSH_MS = (\d+);/);
  const ms = Number(executorSrc.match(/const REPORT_FLUSH_MS = (\d+);/)[1]);
  assert.ok(ms > 0 && ms <= 5000, `flush bound should be a beat, not a stall (got ${ms}ms)`);
  assert.match(executorSrc, /Promise\.race\(\[flushed, new Promise/);
});

// =============================================================================================
// 2 — the next document claims the confirmation
// =============================================================================================

const GLOBALS = ['window', 'document', 'location', 'sessionStorage', 'Element', 'Node',
  'HTMLElement', 'NodeFilter', 'getComputedStyle', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent'];
const SUBMIT_INTENT_KEY = 'jat11.submitIntent';
const CONFIRMATION = '<h1>Thank you for applying</h1><p>We have received your application and will be in touch.</p>';

let claimRaceLostSubmit;
let patches;

function mount({ url = 'https://job-boards.greenhouse.io/gitlab/jobs/8682707002', body = '' } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url });
  for (const k of GLOBALS) globalThis[k] = dom.window[k];
  globalThis.CSS = dom.window.CSS || { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
  return dom;
}
function setIntent(overrides = {}) {
  globalThis.sessionStorage.setItem(SUBMIT_INTENT_KEY, JSON.stringify({
    taskId: 'task_430e2cb0', jobId: 'job_x',
    url: 'https://job-boards.greenhouse.io/gitlab/jobs/8682707002',
    formGrounded: true, pack: 'greenhouse', at: Date.now(),
    ...overrides,
  }));
}

test.before(async () => {
  mount();
  patches = [];
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => p,
      sendMessage: (msg, cb) => { patches.push(msg); if (cb) cb({ ok: true }); },
    },
  };
  ({ claimRaceLostSubmit } = await import(detectorUrl));
});

test('THE FIX: a confirmation document claims the submit as verified', async () => {
  mount({ body: CONFIRMATION });
  setIntent();
  patches.length = 0;
  assert.equal(await claimRaceLostSubmit(), true);
  assert.equal(patches.length, 1);
  const { type, taskId, patch } = patches[0];
  assert.equal(type, 'task-progress');
  assert.equal(taskId, 'task_430e2cb0', 'reported against the task that clicked, not the page');
  assert.equal(patch.state, 'done');
  assert.equal(patch.submissionEvidence.type, 'verified');
  assert.equal(patch.submissionEvidence.reason, 'post-nav-confirmation');
  assert.equal(patch.lastError, null);
  assert.match(patch.transcriptAppend.note, /post-nav-confirmation/,
    'the marker db.js recovers from must be in the transcript');
});

test('it is claimed ONCE — the retry ladder cannot double-report', async () => {
  mount({ body: CONFIRMATION });
  setIntent();
  patches.length = 0;
  assert.equal(await claimRaceLostSubmit(), true);
  assert.equal(await claimRaceLostSubmit(), false);
  assert.equal(await claimRaceLostSubmit(), false);
  assert.equal(patches.length, 1);
  assert.equal(globalThis.sessionStorage.getItem(SUBMIT_INTENT_KEY), null, 'the sentinel is spent');
});

test('a page that does NOT confirm claims nothing, and keeps the sentinel for later', async () => {
  mount({ body: '<h1>Senior Backend Engineer</h1><p>Apply now</p>' });
  setIntent();
  patches.length = 0;
  assert.equal(await claimRaceLostSubmit(), false);
  assert.equal(patches.length, 0);
  assert.ok(globalThis.sessionStorage.getItem(SUBMIT_INTENT_KEY),
    'the confirmation may still be a beat away — do not throw the evidence away');
});

test('an UNGROUNDED submit is never minted as done (R1\'s own gate)', async () => {
  mount({ body: CONFIRMATION });
  setIntent({ formGrounded: false });
  patches.length = 0;
  assert.equal(await claimRaceLostSubmit(), false);
  assert.equal(patches.length, 0);
});

test('a stale sentinel expires instead of crediting an unrelated page', async () => {
  mount({ body: CONFIRMATION });
  setIntent({ at: Date.now() - 6 * 60 * 1000 });
  patches.length = 0;
  assert.equal(await claimRaceLostSubmit(), false);
  assert.equal(patches.length, 0);
  assert.equal(globalThis.sessionStorage.getItem(SUBMIT_INTENT_KEY), null, 'and it is dropped');
});

test('no sentinel at all is a no-op on every ordinary page', async () => {
  mount({ body: CONFIRMATION });
  patches.length = 0;
  assert.equal(await claimRaceLostSubmit(), false);
  assert.equal(patches.length, 0);
});

test('a malformed sentinel is ignored, not thrown on', async () => {
  mount({ body: CONFIRMATION });
  globalThis.sessionStorage.setItem(SUBMIT_INTENT_KEY, '{not json');
  patches.length = 0;
  assert.equal(await claimRaceLostSubmit(), false);
  globalThis.sessionStorage.setItem(SUBMIT_INTENT_KEY, JSON.stringify({ formGrounded: true, at: Date.now() }));
  assert.equal(await claimRaceLostSubmit(), false, 'no taskId → nothing to report against');
  assert.equal(patches.length, 0);
});
