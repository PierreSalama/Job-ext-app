// "AI rescue" was the single largest entry in the needs-you queue: 107 pending questions across
// 57 parked tasks, every one of them titled "AI rescue" — the name of the CODE PATH, not a
// question. Pierre could not answer any of them, and because the label is junk the answer could
// never be learned or reused, so the same question re-parked on the next application forever.
//
// What is NOT a bug: 74% of these are the model correctly refusing because the profile genuinely
// lacks the fact (criminal record, referrals, non-competes). That guardrail is right. The bug is
// that the refusal is unactionable.
//
// Measured on the 41 live post-fix parks (2026-07-20 → 07-25):
//   - the old quote-only regex recovered the field name in 4  (10%)
//   - adding ` as a delimiter recovers                    11  (27%)  ← the model writes backticks
//   - the remaining 30 (73%) name no delimited field AT ALL and never will be regex-recoverable
// So the fallback must be structural: park from fieldRefs, which holds the page's REAL fields.
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

// Verbatim reasons from the live DB.
const BACKTICK = 'Required field `work authorization in canada*` cannot be answered truthfully from '
  + 'the provided profile: it contains no immigration status.';
const BACKTICK2 = 'The blocked required field is `phone country code*`. The candidate is in Canada, '
  + 'but `Canada (+1)` is not among the provided options.';
const QUOTED = "Cannot truthfully answer 'Have you ever been convicted of a criminal offence for "
  + "which you have not received a pardon?' because criminal history is not provided.";
const PROSE = 'Cannot safely complete this page truthfully: the required years fields for Java, '
  + 'Spring Boot, and Angular are not grounded in the resume.';

test('a backtick-delimited field name is recovered (the model\'s preferred quoting)', () => {
  assert.equal(fieldFromParkReason(BACKTICK), 'work authorization in canada*');
  assert.equal(fieldFromParkReason(BACKTICK2), 'phone country code*');
});

test('straight/curly quoting still works, including questions past the old 80-char cap', () => {
  assert.equal(
    fieldFromParkReason(QUOTED),
    'Have you ever been convicted of a criminal offence for which you have not received a pardon?',
  );
});

test('prose with no delimited field yields nothing — that is the structural path\'s job', () => {
  assert.equal(fieldFromParkReason(PROSE), '');
});

// ── the structural fallback ────────────────────────────────────────────────────────────────────
// Reproduce the park branch's decision the same way: read it out of the real source.
const parkBranch = src.slice(src.indexOf("if (act.type === 'park')"));
const branch = parkBranch.slice(0, parkBranch.indexOf("if (act.type === 'click')"));

test('the park branch falls back to the page\'s real unanswered required fields', () => {
  // `answerable(f)` was added 2026-08-08 — the required && !value predicate is unchanged, but the
  // labels are now screened through UI_INSTRUCTION_RX first. See rescue-park-answerable.test.mjs:
  // this path was parking combobox screen-reader help ("1 result available.Use Up and Down…") as
  // if it were a question, which is unanswerable in exactly the way this test file exists to stop.
  assert.match(branch, /fieldRefs\.filter\(\(f\) => f\.required && !f\.value/,
    'must park from the real field list, not from prose');
  assert.match(branch, /park\(f\.label, f\.type, f\.options, why\)/,
    'each parked question must carry its true label, type AND options so it is answerable');
});

test('"AI rescue" survives only as the last resort when the page has no blocking field', () => {
  const idx = branch.indexOf("'AI rescue'");
  assert.ok(idx > branch.indexOf('fieldRefs.filter'),
    'the literal must come AFTER the structural fallback, not before it');
});

// ── option truncation ──────────────────────────────────────────────────────────────────────────
// "Canada (+1) is not among the options" blocked 7 applications. It was true of the list we SENT
// and false of the page: the cap was 20 and Canada is ~38th in any alphabetical country list.
test('a country-length select is no longer truncated below where Canada appears', () => {
  const cap = Number(src.match(/OPTION_CAP_SELECT\s*=\s*(\d+)/)?.[1]);
  assert.ok(Number.isFinite(cap), 'OPTION_CAP_SELECT must exist');
  const COUNTRIES_BEFORE_CANADA = 37;
  assert.ok(cap > COUNTRIES_BEFORE_CANADA * 2,
    `cap ${cap} must comfortably clear the ~${COUNTRIES_BEFORE_CANADA} countries before Canada`);
});

test('a radio cap cannot clip a work-status option list', () => {
  const cap = Number(src.match(/OPTION_CAP_RADIO\s*=\s*(\d+)/)?.[1]);
  assert.ok(Number.isFinite(cap) && cap >= 20, `radio cap ${cap} is too tight`);
});

test('a list we DID cut is reported as cut, so absence is never inferred from our own truncation', () => {
  assert.match(src, /optionsTruncated: true/,
    'the AI payload must flag a truncated option list');
});
