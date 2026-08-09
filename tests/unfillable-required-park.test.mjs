// A REQUIRED field we cannot fill must park, not be left silently empty.
//
// When a select's options don't contain the profile's stored answer, the fill left the control
// EMPTY and said so only in the trace. The flow then clicked the advance button against a form that
// could never move, until the page budget ran out and it died as a generic "stuck on a step".
//
// Live 2026-08-09 on the PC, verbatim from the transcript:
//   trace:field "work authorization in canada*" type=select src=profile → Authorized to work in…
//   trace:fill  "work authorization in canada*" → left-empty (no matching option)
//   trace:button chose "Review" … changed=false … page did not change after click
//   pages=75/100 … stuck — page stopped advancing
// ~26 minutes of a worker slot per task, converting nothing, with the real cause visible only to
// someone reading the trace.
//
// Parking is the right response for two reasons: the existing `if (parked.length) { reportParked();
// break; }` checks short-circuit the loop at the FIRST failed advance, and the question surfaces
// with its real OPTIONS — answerable once, then learned and auto-filled forever after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const executor = fs.readFileSync(path.join(here, '..', 'extension', 'content', 'executor.js'), 'utf8');

// Mirror the callback's decision.
function shouldPark({ outcome, required }) {
  return (outcome === 'skipped-no-option' || outcome === 'skipped-combobox-miss') && !!required;
}

test('the live case parks: a required select with no matching option', () => {
  assert.equal(shouldPark({ outcome: 'skipped-no-option', required: true }), true);
});

test('a required typeahead that matched nothing parks too', () => {
  assert.equal(shouldPark({ outcome: 'skipped-combobox-miss', required: true }), true,
    'same failure, different control — it blocks the advance identically');
});

test('an OPTIONAL unfillable field never parks', () => {
  assert.equal(shouldPark({ outcome: 'skipped-no-option', required: false }), false,
    'parking optional fields would stall applications that could have completed');
  assert.equal(shouldPark({ outcome: 'skipped-combobox-miss', required: false }), false);
});

test('successful and deliberate outcomes never park', () => {
  for (const outcome of ['filled', 'fuzzy-snapped', 'skipped-not-yes', 'skipped-site-chrome']) {
    assert.equal(shouldPark({ outcome, required: true }), false, `${outcome} must not park`);
  }
});

test('the parked question carries the field\'s real OPTIONS so it is answerable', () => {
  const cb = executor.slice(executor.indexOf('const filled = await engine.fill('));
  const body = cb.slice(0, cb.indexOf('if (filled)'));
  assert.match(body, /suggestion\.required/, 'must only park REQUIRED fields');
  assert.match(body, /park\(suggestion\.label, suggestion\.fieldType \|\| 'select', suggestion\.options \|\| null/,
    'without the options the user sees a question they cannot answer');
});

test('both unfillable outcomes are handled by the same branch', () => {
  const cb = executor.slice(executor.indexOf('const filled = await engine.fill('));
  const body = cb.slice(0, cb.indexOf('if (filled)'));
  assert.match(body, /outcome === 'skipped-no-option' \|\| outcome === 'skipped-combobox-miss'/,
    'handling only one leaves the other burning the page budget');
});

test('the existing parked short-circuit is what stops the burn — it must still exist', () => {
  assert.match(executor, /if \(parked\.length\) \{ reportParked\('no-advance'\); break; \}/,
    'parking only helps because a failed advance with parked questions breaks out');
});
