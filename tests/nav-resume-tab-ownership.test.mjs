// A RESUMED RUN MUST NOT BE POURED INTO SOMEBODY ELSE'S PAGE.
//
// sendRunWithNavResume exists because an opener (or a submit) that NAVIGATES destroys the receiving
// content script mid-message; Chrome rejects with "message channel closed" and the run is re-sent to
// the new document. Its only guard was "does the tab still exist".
//
// That guard is not enough, because in serial mode the pump keeps ONE warm apply tab and NAVIGATES
// it to each job in turn (`const reuse = !parallel`). A tab being alive says nothing about whose job
// it is now showing. When a run's channel closes and the pump has already moved that tab on, the
// resume drives the NEW job's page while every report() goes to the OLD task id.
//
// Live 2026-08-24, task_63a857f4 — a faire posting
// (job-boards.greenhouse.io/faire/jobs/8603123002) — is parked holding five GitLab questions:
//     What is your current country of residence? · Are you currently located in Canada?
//     Are you subject to any employment agreements…? · Will you now or in the future require
//     sponsorship…? · Have you previously worked at or consulted for GitLab?
//
// The fix stamps the tab with the dispatch's own token before sending, and refuses to resume if the
// stamp has changed. This test runs the REAL function, lifted verbatim out of background.js, rather
// than asserting on its source text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bg = fs.readFileSync(path.join(here, '..', 'extension', 'background.js'), 'utf8');

// Lift the dispatch helper (and the state it owns) out of the SW module, which cannot be imported
// in node — it registers webNavigation/alarms listeners at load. Anchored on stable markers; if
// either disappears this test fails loudly rather than silently testing nothing.
const START = 'const CHANNEL_CLOSED_RX';
const END = '// Exposed for the harness';
const i = bg.indexOf(START);
const j = bg.indexOf(END);
assert.ok(i > 0 && j > i, 'could not locate the nav-resume block in background.js');
const BLOCK = bg.slice(i, j);

function makeSender({ chrome }) {
  // eslint-disable-next-line no-new-func
  const factory = new Function('chrome', 'console', `${BLOCK}\nreturn { sendRunWithNavResume, aaTabDispatch };`);
  return factory(chrome, { log() {} });
}

// A chrome stub whose sendMessage fails with the channel-closed rejection the first N times.
function chromeStub({ failTimes, onAttempt = () => {}, discarded = false }) {
  let attempts = 0;
  return {
    sent: [],
    tabs: {
      onRemoved: { addListener() {} },
      async get() { return { id: 1, url: 'https://job-boards.greenhouse.io/gitlab/jobs/8682707002', discarded }; },
      async sendMessage(tabId, msg) {
        attempts++;
        onAttempt(attempts);
        if (attempts <= failTimes) throw new Error('The message port closed before a response was received: message channel closed');
        return { ok: true, attempt: attempts, resumed: !!msg.resumedAfterNavigation };
      },
    },
  };
}

test('the ordinary case still resumes: the tab is still ours after the navigation', async () => {
  const chrome = chromeStub({ failTimes: 1 });
  const { sendRunWithNavResume } = makeSender({ chrome });
  const r = await sendRunWithNavResume(1, { type: 'jat11.run-task' }, { settleMs: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.attempt, 2, 'it retried once');
  assert.equal(r.resumed, true, 'and told the executor it was a resume');
});

test('THE BUG: a tab re-tasked by a newer dispatch is NOT resumed into', async () => {
  let api = null;
  const chrome = chromeStub({
    failTimes: 5,
    onAttempt: (n) => {
      // Between attempt 1 and the resume, the pump claims the same warm tab for another job —
      // exactly what `reuse` does when it navigates aaReuseTabId to the next posting.
      if (n === 1) api.aaTabDispatch.set(1, 'someone-else');
    },
  });
  api = makeSender({ chrome });
  await assert.rejects(
    () => api.sendRunWithNavResume(1, { type: 'jat11.run-task' }, { settleMs: 1 }),
    /message channel closed/,
    'it must surface the original failure, not drive the other job\'s page',
  );
});

test('a second dispatch on the same tab takes ownership from the first', async () => {
  const chrome = chromeStub({ failTimes: 99 });
  const { sendRunWithNavResume, aaTabDispatch } = makeSender({ chrome });
  // First dispatch stamps the tab...
  const first = sendRunWithNavResume(1, { type: 'jat11.run-task', task: { id: 'task_faire' } }, { settleMs: 1 })
    .then(() => 'resolved', () => 'rejected');
  await new Promise((r) => setTimeout(r, 5));
  const stampA = aaTabDispatch.get(1);
  // ...the pump dispatches another job into the same warm tab...
  sendRunWithNavResume(1, { type: 'jat11.run-task', task: { id: 'task_gitlab' } }, { settleMs: 1 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 5));
  assert.notEqual(aaTabDispatch.get(1), stampA, 'the newer dispatch owns the tab');
  assert.equal(await first, 'rejected', 'and the older one gives up rather than resuming');
});

test('a discarded tab is still a real failure (unchanged)', async () => {
  const chrome = chromeStub({ failTimes: 1, discarded: true });
  const { sendRunWithNavResume } = makeSender({ chrome });
  await assert.rejects(() => sendRunWithNavResume(1, {}, { settleMs: 1 }), /message channel closed/);
});

test('a non-channel error is never retried (unchanged)', async () => {
  const chrome = {
    tabs: {
      onRemoved: { addListener() {} },
      async get() { return { id: 1, discarded: false }; },
      async sendMessage() { throw new Error('Cannot access contents of the page'); },
    },
  };
  const { sendRunWithNavResume } = makeSender({ chrome });
  await assert.rejects(() => sendRunWithNavResume(1, {}, { settleMs: 1 }), /Cannot access contents/);
});
