// `(unparsed)` IS THE SINGLE COMMONEST STEP IN THE SYSTEM, AND IT IS ALWAYS THE SAME BUG.
//
// 16 of 219 steps on 2026-09-05. An earlier session started storing the rejected reply specifically
// so someone could diagnose it later. Diagnosed 2026-09-06 from exactly those stored replies, plus
// two fresh ones from end-to-end runs.
//
// Every one is a write_resume call. Not truncated, not fenced, not prose: four thousand good
// characters with one unescaped double quote about halfway in, and the SAME phrase both times,
// because it comes from Pierre's own material:
//
//     an AST-enforced "new functions need tests" gate
//
// So there are two fixes here and they are different jobs. The reply is REPAIRED, because one
// missing backslash should not cost a step. And when a reply cannot be repaired, the failure now
// says WHERE and shows the text, because the old message ("reply was not a single JSON action
// object") gave the model no way to find one bad character in a four-thousand-character document.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { parseAction } = require(path.join(here, '..', 'app', 'src', 'ai', 'agent-loop.js'));

const Q = String.fromCharCode(34);
const withBody = (body) => `{${Q}tool${Q}:${Q}write_resume${Q},${Q}args${Q}:{${Q}bodyHtml${Q}:${Q}${body}${Q}}}`;

// ---------------------------------------------------------------------------
// repaired, not bounced back
//
// The repair inserts a backslash at the exact quote the parser objected to, and nowhere else.
//
// The first version assumed that quote sits at position-1. It does, for the FIRST one. The real
// sample reads [tests" gate]: JSON skips the space and reports the position of the g, so position-1
// is a space and the repair bailed on the very case it was written for. It walks back over
// whitespace now, which is why both shapes below are tested.
// ---------------------------------------------------------------------------
test('the real failure is repaired, and says so', () => {
  const body = `<p>an AST-enforced ${Q}new functions need tests${Q} gate</p>`;
  const r = parseAction(withBody(body));
  assert.equal(r.error, undefined, 'it should not fail at all now');
  assert.equal(r.repaired, true, 'and it must SAY it was repaired, never silently');
  assert.equal(r.action.tool, 'write_resume');
  assert.equal(r.action.args.bodyHtml, body, 'the text survives exactly, quotes included');
});

test('a quote followed immediately by text is repaired too', () => {
  // The easy shape, quote then character with no space between: position-1 really is the quote.
  const body = `<p>the ${Q}x${Q}y phrase</p>`;
  const r = parseAction(withBody(body));
  assert.equal(r.repaired, true);
  assert.equal(r.action.args.bodyHtml, body);
});

test('several quoted phrases in one document are all repaired', () => {
  const body = `<p>a ${Q}first${Q} and a ${Q}second${Q} and a ${Q}third${Q} phrase</p>`;
  const r = parseAction(withBody(body));
  assert.equal(r.repaired, true);
  assert.equal(r.action.args.bodyHtml, body);
});

test('a clean reply is never marked repaired', () => {
  const r = parseAction('{"tool":"fill","args":{"ref":"ref_1"}}');
  assert.equal(r.repaired, undefined, 'nothing was wrong with it');
  assert.equal(r.action.tool, 'fill');
});

// ---------------------------------------------------------------------------
// what must still be refused
//
// The repair only ever inserts a backslash at a quote. Anything it cannot fix that way has to come
// back as an error, not as a half-understood action.
// ---------------------------------------------------------------------------
test('genuinely broken JSON is refused, not mangled into something that parses', () => {
  assert.ok(parseAction('{"tool":"fill","args":{"ref":').error, 'truncated');
  assert.ok(parseAction('{"tool":"fill","args":[1,2').error, 'unclosed array');
  assert.ok(parseAction('not json at all').error, 'prose');
  assert.equal(parseAction('').error, 'empty reply');
  assert.equal(parseAction('   ').error, 'empty reply');
});

test('valid JSON that is simply not an action keeps the plain message', () => {
  // It parsed fine; it just was not an action. "invalid JSON at position N" would send the model
  // hunting for a typo that does not exist.
  assert.equal(parseAction('{"note":"no tool here"}').error, 'reply was not a single JSON action object');
});

// ---------------------------------------------------------------------------
// when it cannot be repaired, the message has to be useful
// ---------------------------------------------------------------------------
test('an unrepairable syntax error still reports position and text', () => {
  // Two values with nothing between them. There is a position, but no quote to escape, so the
  // repair declines and the diagnosis is what the model gets.
  const r = parseAction('{"tool":"fill","args":{"ref":"r1"} "extra"}');
  assert.ok(r.error, 'must not parse');
  assert.match(r.error, /position \d+/, 'the position is the point');
  assert.match(r.error, /right here/, 'and so is the surrounding text');
});

test('and it names the cause, because the cause is nearly always the same', () => {
  const r = parseAction('{"tool":"fill","args":{"ref":"r1"} "extra"}');
  assert.match(r.error, /double quote/i);
  assert.match(r.error, /escape|backslash/i);
});

// ---------------------------------------------------------------------------
// nothing that used to work may stop working
// ---------------------------------------------------------------------------
test('a done action still parses', () => {
  const r = parseAction('{"done":true,"summary":"finished"}');
  assert.equal(r.action.done, true);
  assert.equal(r.action.summary, 'finished');
});

test('a markdown fence is still tolerated', () => {
  // The parser has always accepted a fence, which is why a fence was never the cause.
  const r = parseAction('```json\n{"tool":"read_page","args":{}}\n```');
  assert.equal(r.action.tool, 'read_page');
});

test('an object wrapped in prose is still recovered', () => {
  const r = parseAction('Sure:\n{"tool":"page_text","args":{}}\nHope that helps.');
  assert.equal(r.action.tool, 'page_text');
});
