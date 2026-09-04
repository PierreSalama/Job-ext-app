// Guards the 2026-09-03 outage: both nodes sat dead for hours while /ai/status read GREEN.
//
// What actually happened: the Codex subscription hit its usage limit. The CLI reports that as a
// JSONL `error`/`turn.failed` event and then exits non-zero with an EMPTY stderr, so the provider
// surfaced it as `CODEX_EXIT codex exited 1:` with no message and retried it as the known transient
// alpha flake. Meanwhile status() only asked `codex login status` — and a quota-exhausted account is
// still perfectly logged in — so it kept answering available:true, which made canAnswer true on both
// the PC and the laptop while every single generate call failed. The health check could not see it.
//
// These tests pin the two halves of the fix: quota is its own hard code, and status() tells the truth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const codex = require('../app/src/ai/codex.js');

const REAL_MESSAGE =
  "You've hit your usage limit. To continue using Codex and get access to GPT-5.3-Codex, " +
  'start a free trial of Plus today (https://chatgpt.com/explore/plus), or try again at Sep 26th, 2026 5:25 PM.';

test('the reset time is read out of the real message codex printed', () => {
  const at = codex.parseQuotaReset(REAL_MESSAGE);
  assert.ok(at, 'expected a parsed reset time');
  const d = new Date(at);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8, 'September');
  assert.equal(d.getDate(), 26);
  assert.equal(d.getHours(), 17, '5:25 PM is 17:00, not 5:00');
  assert.equal(d.getMinutes(), 25);
});

test('a quota message with no date still blocks, it just has no expiry', () => {
  codex.clearQuota();
  const blocked = codex.noteQuota('You have hit your usage limit.');
  assert.equal(blocked.until, null);
  assert.ok(codex.quotaStatus(), 'a dateless block is still a block');
  codex.clearQuota();
});

test('status reports unavailable while blocked, even though the account is logged in', async () => {
  codex.clearQuota();
  codex.noteQuota(REAL_MESSAGE);
  const s = await codex.status();
  assert.equal(s.available, false, 'logged in is NOT the same as has quota');
  assert.equal(s.quotaBlocked, true);
  assert.match(s.reason, /usage limit/i);
  assert.equal(new Date(s.retryAt).getTime(), codex.parseQuotaReset(REAL_MESSAGE));
  codex.clearQuota();
});

test('generate fails fast with CODEX_QUOTA and never spawns the CLI while blocked', async () => {
  codex.clearQuota();
  codex.noteQuota(REAL_MESSAGE);
  const started = Date.now();
  await assert.rejects(
    () => codex.generate({ prompt: 'anything' }),
    (e) => {
      assert.equal(e.code, 'CODEX_QUOTA', 'must not be reported as the transient CODEX_EXIT');
      return true;
    },
  );
  assert.ok(Date.now() - started < 1000, 'should short-circuit, not spawn and wait on the CLI');
  codex.clearQuota();
});

test('a block expires on its own once its reset time has passed', () => {
  codex.clearQuota();
  codex.noteQuota('usage limit reached, try again at Jan 1st, 2020 1:00 AM');
  assert.equal(codex.quotaStatus(), null, 'a reset time in the past must not keep blocking');
});

test('the block is cleared so a recovered subscription is usable again', () => {
  codex.noteQuota(REAL_MESSAGE);
  assert.ok(codex.quotaStatus());
  codex.clearQuota();
  assert.equal(codex.quotaStatus(), null);
});
