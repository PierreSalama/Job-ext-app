// "AI rescue" IS A THIRD OF THE NEEDS-YOU QUEUE, AND IT IS NOT A QUESTION.
//
// Measured on the applier laptop 2026-09-05: 334 tasks sit parked, and 114 of them are parked on
// the literal string 'AI rescue'. For 91 of those it is the ONLY question on the task. So a third
// of the queue was a row Pierre could read and do absolutely nothing about.
//
// executor.js parks that marker on purpose, as a last resort when the AI rescue could not name a
// field and no required field had an answerable label, on the reasoning that a row nobody can
// answer still signals that the job needs attention. The information was never missing though.
// Every one of the 114 carries a `reason` written by the model saying exactly what is wanted. The
// queue simply showed the marker instead of the reason.
//
// The sharper bug is in queueParkedQuestions, which dedupes on the normalized question: 114
// different questions collapsed onto ONE key, so 113 were invisible, and answering the survivor
// would have written an answer filed under "AI rescue" into the answer bank.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));

const h = db.humanizeRescueQuestion;

// Real reasons, copied from the live rows on the laptop.
const QUOTED = 'A required field is ungroundable from the provided facts: "how did you hear about this position?" There is no supported source in the candidate profile, resume, or prior answers, and the listed options do not include Indeed.';
const CURLY = 'The posting asks “Have you ever been convicted of a criminal offence for which you have not received a pardon?” and criminal history is not on file.';
// A reason that uses U+2019 as an APOSTROPHE, which is the only way it appears in the live rows.
const APOSTROPHE = "Required field 'driver’s licence' is ungrounded: the profile does not say whether Pierre holds one. Nothing here should be read as a quoted question.";
const PROSE = "The page has a required driver's license question, but the candidate profile/resume does not state whether Pierre has a valid driver's licence.";

test('a quoted question inside the reason becomes the question', () => {
  const out = h({ question: 'AI rescue', fieldType: 'text', reason: QUOTED });
  assert.equal(out.question, 'how did you hear about this position?');
  assert.equal(out.rescueMarker, true, 'the row still says where it came from');
  assert.equal(out.reason, QUOTED, 'the original reason is preserved, not replaced');
});

test('curly DOUBLE quotes count too, because the model sometimes uses them', () => {
  const out = h({ question: 'AI rescue', reason: CURLY });
  assert.equal(out.question, 'Have you ever been convicted of a criminal offence for which you have not received a pardon?');
});

// COUNTED IN THE LIVE ROWS BEFORE WIDENING ANYTHING. Of the 114 reasons on the laptop, 11 contain
// U+2019 and ZERO contain U+2018. The model is using it as an apostrophe ("driver’s"), never as a
// quote mark, so treating it as a closing delimiter would carve a span out of the middle of a
// sentence and present the fragment to Pierre as his question. The first draft of this test
// asserted the opposite, from an example that does not occur.
test('a curly apostrophe is not a quote mark', () => {
  const out = h({ question: 'AI rescue', reason: APOSTROPHE });
  assert.equal(out.question, APOSTROPHE, 'the whole reason stands; no fragment is carved out of it');
});

test('with no quoted question the reason prose stands in, because it is still readable', () => {
  const out = h({ question: 'AI rescue', reason: PROSE });
  assert.equal(out.question, PROSE);
});

test('a marker with no reason at all is left alone rather than blanked', () => {
  // Showing an empty question would be worse than showing the marker: the row would vanish from
  // the queue entirely and the job would be stranded with no trace.
  assert.equal(h({ question: 'AI rescue' }).question, 'AI rescue');
  assert.equal(h({ question: 'AI rescue', reason: '   ' }).question, 'AI rescue');
});

test('an ordinary question is returned untouched, same object', () => {
  const q = { question: 'What are your salary expectations?', fieldType: 'text', reason: 'missing answer' };
  assert.equal(h(q), q, 'not even copied: nothing to do');
  assert.equal(h(null), null);
});

// ---------------------------------------------------------------------------
// THE DEDUPE COLLISION, which is the part that actually hid 113 questions
// ---------------------------------------------------------------------------
test('two rescue parks with different reasons are two questions, not one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-rescue-'));
  try {
    db.open(dir);
    const a = db.upsertJob({ title: 'Dev', company: 'ACV', source: 'linkedin', jobUrl: 'https://example.com/a' });
    const b = db.upsertJob({ title: 'Dev', company: 'Circuit', source: 'linkedin', jobUrl: 'https://example.com/b' });
    const ta = db.queueAdd(a.job.id, 'auto');
    const tb = db.queueAdd(b.job.id, 'auto');
    db.queuePatch(ta.id, { state: 'parked', pendingQuestions: [{ question: 'AI rescue', fieldType: 'text', reason: QUOTED }] });
    db.queuePatch(tb.id, { state: 'parked', pendingQuestions: [{ question: 'AI rescue', fieldType: 'text', reason: PROSE }] });

    const outstanding = db.queueParkedQuestions().filter((q) => q.jobId === a.job.id || q.jobId === b.job.id);
    assert.equal(outstanding.length, 2, `both must survive the dedupe, got ${JSON.stringify(outstanding.map((o) => o.question))}`);
    assert.ok(outstanding.every((o) => o.question !== 'AI rescue'), 'neither may still read as the marker');
    assert.ok(outstanding.some((o) => o.question === 'how did you hear about this position?'));
    assert.ok(outstanding.some((o) => o.question === PROSE));

    const needs = db.queueNeedsYou().filter((r) => r.jobId === a.job.id || r.jobId === b.job.id);
    assert.equal(needs.length, 2, 'both tasks are in the needs-you queue');
    const shown = needs.flatMap((r) => r.questions.map((q) => q.question));
    assert.ok(shown.every((q) => q !== 'AI rescue'), `the queue must not show the marker: ${JSON.stringify(shown)}`);
    assert.ok(shown.includes('how did you hear about this position?'));
  } finally { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});
