// The Pipeline board rendered EVERY application as a card: measured on the real database,
// 832 cards across 11,133 elements and 528 KB, on every single visit.
//
// The cards are not spread evenly, which is what makes the cap worth having. Three columns hold
// everything -- "started" 550, "ghosted" 190, "submitted" 92 -- so the board was drawing a
// 550-card column nobody scrolls to the bottom of.
//
// Capped at 40 per column: 1,786 elements, 88 KB. The COLUMN HEADER still prints the true total
// (byStatus[s.id].length), so the board never understates what you have -- it says 550 and shows
// 40, with a button naming the other 510 exactly.
//
// THE TRAP THIS FILE GUARDS is the binding, not the cap. Cards were bound once at render with
// `v.querySelectorAll('.kb-card').forEach(...)`. A card revealed later would have been fully
// styled, correctly positioned, and completely inert -- not draggable, not clickable. That is
// the same silent failure the Applications, Profile and Procedures pages each shipped with, and
// on a drag-and-drop board it is worse: dragging a dead card looks like the app losing your work.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(here, '..', 'extension', 'app', 'app.js'), 'utf8');
const MIRROR = fs.readFileSync(path.join(here, '..', 'app', 'src', 'app', 'app.js'), 'utf8');

test('the authored file and its mirror agree', () => {
  assert.equal(APP, MIRROR, 'run `node tools/mirror.mjs` — the two copies have diverged');
});

test('cards are capped per column, not per board', () => {
  // Per-board would be wrong: it would starve the small columns to make room for "started".
  assert.match(APP, /const CARD_CAP = 40;/);
  assert.match(APP, /const cardsFor = \(statusId\) => \{/,
    'the cap belongs in a per-column helper');
  assert.match(APP, /list\.slice\(0, CARD_CAP\)\.map\(cardHtml\)/,
    "and must slice that column's own list");
});

test('THE HONESTY RULE: the column header still shows the true total', () => {
  // If this ever changes to the rendered count, the board starts telling him he has 40
  // applications in a column that holds 550. The cap may change what is DRAWN and never what
  // the board CLAIMS.
  assert.match(APP, /<span class="n">\$\{byStatus\[s\.id\]\.length\}<\/span>/,
    'the header count must come from the full list, not the capped slice');
});

test('the reveal button names the exact remaining count', () => {
  assert.match(APP, /Show the other \$\{list\.length - CARD_CAP\}/,
    'a vague "show more" hides how much is behind it; on "started" the honest number is 510');
});

test('THE BUG: card binding is a re-callable function, not a one-shot at render', () => {
  assert.match(APP, /const bindCard = \(card\) => \{/,
    'binding one card must be a named, re-callable function');
  assert.match(APP, /const bindAllCards = \(\) =>/,
    'and there must be a bind-anything-not-yet-bound sweep');
  const i = APP.indexOf('data-kb-more]');
  const reveal = APP.slice(i, i + 700);
  assert.match(reveal, /bindAllCards\(\)/,
    'the reveal MUST re-bind, or every card it inserts is dead on a drag-and-drop board');
});

test('re-binding is idempotent — a card must not collect a second listener', () => {
  // bindAllCards() runs at render AND after every reveal. Without the guard, an already-drawn
  // card would get a second contextmenu/click handler and every status change would fire twice.
  assert.match(APP, /if \(card\.dataset\.kbBound\) return;/);
  assert.match(APP, /card\.dataset\.kbBound = '1';/);
});

test('the reveal draws through the SAME card builder as the first paint', () => {
  const i = APP.indexOf('data-kb-more]');
  const reveal = APP.slice(i, i + 700);
  assert.match(reveal, /rest\.map\(cardHtml\)\.join\(''\)/,
    'two builders would drift and revealed cards would slowly stop matching the visible ones');
  assert.match(reveal, /\.slice\(CARD_CAP\)/, 'and must start exactly where the cap stopped');
});

test('the reveal click does not bubble into the column', () => {
  // The button sits inside .kb-col, which carries drop/collapse handling. Without
  // stopPropagation a reveal could also register as a column interaction.
  const i = APP.indexOf('data-kb-more]');
  assert.match(APP.slice(i, i + 700), /e\.stopPropagation\(\)/);
});

// ---------------------------------------------------------------------------------------
// Verified in a real browser against a copy of the live database before this was committed:
//
//   * 11,133 -> 1,786 elements, 528 -> 88 KB, 0 console errors
//   * headers still read 550 / 92 / 190 while showing 40 each, with buttons offering
//     "Show the other 510 / 52 / 150"
//   * clicked "Show the other 510", then took the card at index 500 -- which cannot exist
//     without the reveal -- and fired a REAL dragstart: it set .dragging AND wrote its own id
//     into the dataTransfer, and dragend cleared the class
//   * clicked that same revealed card and the route changed to #/applications/<its id>
//
// A flag saying "bound" is not proof a listener works, which is why the check above drives the
// actual DragEvent rather than counting attributes.
test('the measurement that justifies the cap, recorded', () => {
  // 832 cards over 12 columns sounds like ~70 each. It is not: three columns hold all of it.
  // If a future change caps by dividing evenly, this comment is the reason not to.
  assert.match(APP, /"started" alone holds 550/,
    'the distribution finding must stay recorded next to the cap');
});
