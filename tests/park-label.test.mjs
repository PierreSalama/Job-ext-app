// A parked task is only actionable if its label says WHAT is being asked.
//
// The AI rescue path parked with `target || 'AI rescue'`. When the model omitted a target, the
// needs-you queue got a row literally titled "AI rescue" — 21 of 83 pending questions on
// 2026-07-20, all identical, none answerable without opening each task. The real field was in the
// park REASON the whole time:
//   "Required field 'work authorization in canada*' cannot be answered truthfully from the
//    provided facts because the exact option among Canadian Citizen / Permanent Resident /
//    Open Work Permit / Others is not stated."
//
// Note what is NOT a bug here: refusing to answer that field. The profile says "Authorized to work
// in Canada (no sponsorship required)" but does not say WHICH status, so guessing would fabricate
// a legal fact. The guardrail is correct; only the label was wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'extension', 'content', 'executor.js'), 'utf8');

// Rebuild the extractor from source so this test tracks the real implementation.
const body = src.slice(src.indexOf('function fieldFromParkReason'));
const rxLiteral = body.match(/\.match\((\/.*?\/[gimsuy]*)\)/);
assert.ok(rxLiteral, 'fieldFromParkReason must extract with a regex literal');
const RX = eval(rxLiteral[1]);
const fieldFromParkReason = (reason) => {
  const m = String(reason || '').match(RX);
  return m ? m[1].trim() : '';
};

const LIVE_REASON = "Required field 'work authorization in canada*' cannot be answered truthfully "
  + 'from the provided facts because the exact option among Canadian Citizen / Permanent Resident '
  + '/ Open Work Permit / Others is not stated.';

test('the real field name is recovered from the live park reason', () => {
  assert.equal(fieldFromParkReason(LIVE_REASON), 'work authorization in canada*');
});

test('curly quotes work too — model output uses either', () => {
  assert.equal(fieldFromParkReason('Field “date of birth” is sensitive'), 'date of birth');
  assert.equal(fieldFromParkReason('Field ‘pronouns’ is personal'), 'pronouns');
});

test('no quoted field yields empty so the caller keeps its own fallback', () => {
  assert.equal(fieldFromParkReason('AI could not safely proceed — needs you'), '');
  assert.equal(fieldFromParkReason(null), '');
  assert.equal(fieldFromParkReason(''), '');
});

test('the park call prefers target, then the reason field, and only then the stage name', () => {
  const call = src.slice(src.indexOf("if (act.type === 'park')"));
  const stmt = call.slice(0, call.indexOf('return \'parked\';'));
  assert.match(stmt, /target \|\| fieldFromParkReason\(act\.reason\) \|\| 'AI rescue'/,
    'regression: parking straight to the internal stage name makes the needs-you queue unreadable');
});
