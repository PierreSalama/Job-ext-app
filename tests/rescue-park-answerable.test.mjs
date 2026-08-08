// The AI-rescue fallback must only park rows the user can actually ANSWER.
//
// When the model returns prose instead of a field name, the rescue path parks this page's required
// unfilled fields using their raw labels. Both autofill scan paths drop combobox screen-reader help
// via UI_INSTRUCTION_RX first — this path did not, so it re-introduced exactly what that guard
// exists to prevent. A label that is not a question can never be answered, so the job parks forever.
//
// Live 2026-08-08, in the needs-you queue across both nodes:
//   6 × "1 result available.Use Up and Down to choose options, press Enter to select…"
//   9 × a bare "Type"
//  10 × "AI rescue"  (the internal stage name, parked when there was no field to show at all)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const executor = read('extension', 'content', 'executor.js');
const autofill = read('extension', 'content', 'autofill.js');

const UI_RX = new RegExp(
  autofill.match(/const UI_INSTRUCTION_RX = \/(.+)\/i;/)[1], 'i');

test('UI_INSTRUCTION_RX catches the SINGULAR "1 result available" form', () => {
  const live = '1 result available.Use Up and Down to choose options, press Enter to select the currently focused option, press Escape to exit the menu, press Tab to select the option and exit the menu.';
  assert.equal(UI_RX.test(live), true, 'the live combobox string must be recognised as UI noise');
  assert.equal(UI_RX.test('72 results available.Use Up and Down to choose options'), true, 'plural too');
});

test('real questions are NOT mistaken for UI noise', () => {
  for (const q of ['Pronouns', 'Are you legally authorized to work in Canada?',
                   'How many years of React experience do you have?', 'Type of employment sought']) {
    assert.equal(UI_RX.test(q), false, `must remain answerable: ${q}`);
  }
});

test('the rescue park path filters labels through the same guard', () => {
  assert.match(executor, /UI_INSTRUCTION_RX/,
    'executor must import and use the guard, not park raw labels');
  const block = executor.slice(executor.indexOf('const answerable ='), executor.indexOf('const answerable =') + 400);
  assert.match(block, /UI_INSTRUCTION_RX\.test\(f\.label\)/, 'labels must be screened');
  assert.match(block, /f\.label &&/, 'an empty label is not answerable either');
});

test('"AI rescue" stays the LAST resort, after the screened structural fallback', () => {
  // Not removed: an unanswerable row still flags that the job needs attention, and dropping it
  // would let the task retry-loop silently. ai-rescue-park-fields.test.mjs owns that decision.
  // What matters here is ordering — the screened field list must be tried first.
  const branch = executor.slice(executor.indexOf("if (act.type === 'park')"));
  const body = branch.slice(0, branch.indexOf("if (act.type === 'click')"));
  assert.ok(body.indexOf("'AI rescue'") > body.indexOf('const answerable ='),
    'the stage-name park must come after the answerable-field fallback');
});

// The filter itself, pinned as arithmetic.
test('answerable() keeps real fields and drops noise', () => {
  // !! because `'' && …` short-circuits to '' — Array.filter coerces, but strict equal does not.
  const answerable = (f) => !!(f.label && f.label.trim().length > 2 && !UI_RX.test(f.label));
  assert.equal(answerable({ label: 'Pronouns' }), true);
  assert.equal(answerable({ label: 'Type' }), true, 'short but real — length gate is only for stubs');
  assert.equal(answerable({ label: '' }), false);
  assert.equal(answerable({ label: ' ' }), false);
  assert.equal(answerable({ label: '1 result available.Use Up and Down to choose options' }), false);
});
