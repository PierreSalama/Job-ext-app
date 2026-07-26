// ATS labels are often a STACKED BLOCK: section heading, helper sentence, then the real field
// name last. Read whole, the heading wins the profile match and the wrong value goes in the field.
//
// Captured live from Indeed smartapply 2026-07-20 (the dominant Indeed failure: 17 failed vs 17
// done over 7 days). The <label> wired to the required country dropdown had innerText:
//
//   "MOBILE NUMBER
//    Provide valid phone numbers to allow Recruiters to contact you.
//    Country *"
//
// /phone|mobile/ matches at index 0, /country/ only at index 78 -- so the COUNTRY combobox was
// matched to the phone profile field and filled with a phone number, matching no country option.
// The control stayed empty, Indeed's Continue silently refused, and the re-scan saw nothing
// unanswered. Harness trace before the fix:
//   trace:field "country * country * mobile numberprovide valid phone numbers…" → ***7745
//   trace:fill  … → left-empty (typeahead no match)
// after:
//   trace:field "country * country *" type=combobox src=profile → Canada
//
// Note the jamming in that "before" line: textContent drops block boundaries, so the words ran
// together. Label sources must therefore be read with innerText, not textContent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'extension', 'content', 'autofill.js'), 'utf8');

// Rebuild elLabelText's rule from source so the test tracks the real thresholds.
const fn = src.slice(src.indexOf('function elLabelText'), src.indexOf('export function isFillable'));
const maxLast = Number((fn.match(/last\.length <= (\d+)/) || [])[1]);
// Anchor on join(' ') so this does not accidentally read the `segs.length >= 2` guard.
const minFull = Number((fn.match(/join\(' '\)\.length >= (\d+)/) || [])[1]);
assert.ok(maxLast > 0 && minFull > 0, 'could not read elLabelText thresholds from source');

function reduce(text) {
  const segs = String(text).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (segs.length >= 2) {
    const last = segs[segs.length - 1];
    if (last.length <= maxLast && segs.join(' ').length >= minFull) return last;
  }
  return text;
}

const LIVE_LABEL = 'MOBILE NUMBER\n\nProvide valid phone numbers to allow Recruiters to contact you.\n\nCountry *';

test('a stacked ATS label reduces to the field name, not the section heading', () => {
  assert.equal(reduce(LIVE_LABEL), 'Country *');
});

test('the reduced label matches country, and no longer matches phone first', () => {
  const label = reduce(LIVE_LABEL).toLowerCase();
  assert.ok(/(country|pays|país|land)/i.test(label), 'must match the country profile pattern');
  assert.ok(!/phone|mobile/i.test(label), 'must NOT still look like a phone field');

  // The whole blob is what made this go wrong — phone wins on position.
  const blob = LIVE_LABEL.replace(/\s+/g, ' ').toLowerCase();
  assert.ok(blob.search(/phone|mobile/) < blob.search(/country/),
    'precondition: in the full blob the phone pattern appears first, which is why it won');
});

test('ordinary single-line labels are untouched', () => {
  for (const l of ['First name *', 'Email address', 'How many years of experience do you have with React?'])
    assert.equal(reduce(l), l);
});

test('a short two-line label is left alone — only long stacks are reduced', () => {
  // Guard against over-eager truncation: a brief two-liner is likely one prompt wrapped, not a
  // heading + helper + field stack, so it must survive whole.
  const short = 'Country\n*';
  assert.equal(reduce(short), short);
});

test('label sources are read with innerText, not textContent', () => {
  assert.match(fn, /el\.innerText \|\| el\.textContent/, 'innerText first so block boundaries survive');
  const labelBlock = src.slice(src.indexOf('const sources = ['), src.indexOf('let raw ='));
  assert.doesNotMatch(labelBlock, /\?\.textContent/,
    'regression: a textContent label source jams the words together and re-breaks the match');
});

test('the combobox is opened with pointer events', () => {
  // Live, a bare .click() left aria-expanded="false" and rendered zero options.
  const combo = src.slice(src.indexOf('export async function fillCombobox'));
  assert.match(combo.slice(0, combo.indexOf('const SEL')), /pointerdown/,
    'React comboboxes bind pointer events; mousedown+click alone never opens them');
});
