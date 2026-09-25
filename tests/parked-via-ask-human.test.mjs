// CORRECT BEHAVIOUR, FILED AS A FAILURE.
//
// disputeSummary checks that a run's summary matches what its steps actually did. One of its checks
// is "the summary says the application was handed to the human" — and it tested that by looking for
// a SUBMIT step that raised a block, because it was written for the Ritual case, where submit
// refused to park an application with eight empty fields and the model claimed a handover anyway.
//
// But ask_human parks too, and for a question nobody can answer it is the RIGHT way to park. Its
// result reads "PARKED. Block blk_... raised for the human".
//
// Live 2026-09-06: an end-to-end run met a US work-authorisation question, escalated it exactly as
// it should, raised a needs_answer block, described that honestly, and was disputed twice and then
// recorded as FAILED. The run did everything right.
//
// It surfaced today because today's work-authorisation fix made parking on a US question common.
// Before it, the deterministic floor simply answered "Yes" and the question never reached a human,
// so this path was rare enough to go unnoticed.
//
// A rail that files correct behaviour as failure is worse than one that does nothing: every number
// built on top of it is wrong, and in the direction that hides real problems behind fake ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { disputeSummary } = require(path.join(here, '..', 'app', 'src', 'ai', 'agent-loop.js'));

// The real result string ask_human returns.
const askHumanStep = {
  tool: 'ask_human',
  ok: true,
  refused: false,
  result: 'PARKED. Block blk_ae564ac5-96b4-46e3-b185-2ffa9743bb65 raised for the human '
    + '(it is queued on their page). Do NOT wait and do NOT guess. Move on to a different application.',
};
// And the real summary from that run.
const PARKED_SUMMARY = 'Prepared the application but the form asks for US work authorization, which is not in '
  + "the candidate's profile or prior answers. Escalated via ask_human and parked the application. No submission was made.";

test('an application parked via ask_human is not disputed', () => {
  const steps = [{ tool: 'navigate', ok: true }, { tool: 'recall_answer', ok: true }, askHumanStep];
  assert.equal(disputeSummary(PARKED_SUMMARY, steps), null,
    'the block exists, the summary is true, and there is nothing to dispute');
});

test('parking via submit is still accepted, which is what the check was built for', () => {
  const steps = [{
    tool: 'submit',
    ok: true,
    refused: false,
    result: 'NOT SUBMITTED — you are in Prepare mode. Block blk_dfc40b99 hands it to the human with the form ready.',
  }];
  assert.equal(disputeSummary('Called submit, which handed it to the human for review.', steps), null);
});

// ---------------------------------------------------------------------------
// and the lie it exists to catch must still be caught
// ---------------------------------------------------------------------------
test('claiming a handover with no block at all is still disputed', () => {
  // The Ritual case: submit refused, nothing was parked, the model said it was.
  const steps = [
    { tool: 'submit', ok: false, refused: true, result: 'refused: eight required fields are empty' },
    { tool: 'fill', ok: true },
  ];
  const d = disputeSummary('Called submit to hand the completed application to the human.', steps);
  assert.ok(d, 'must still be disputed');
  assert.match(d, /handed to the human/);
});

test('a REFUSED ask_human does not count as a park either', () => {
  // A refusal raises no block, so nothing was handed over, whatever the summary says.
  const steps = [{ tool: 'ask_human', ok: false, refused: true, result: 'refused: that is a question you can answer yourself' }];
  assert.ok(disputeSummary('Parked the application for the human.', steps), 'a refusal parks nothing');
});

test('an ask_human whose result carries no block does not count', () => {
  const steps = [{ tool: 'ask_human', ok: true, refused: false, result: 'something else entirely' }];
  assert.ok(disputeSummary('Parked the application for the human.', steps));
});

// ---------------------------------------------------------------------------
// the other two checks are untouched
// ---------------------------------------------------------------------------
test('a false claim of submission is still caught', () => {
  const steps = [{ tool: 'submit', ok: true, refused: false, result: 'NOT SUBMITTED — you are in Prepare mode.' }];
  const d = disputeSummary('The application was submitted successfully.', steps);
  assert.ok(d);
  assert.match(d, /no successful submit step/);
});

test('a false claim of writing documents is still caught', () => {
  const steps = [{ tool: 'write_resume', ok: false, refused: true, result: 'refused: voice check FAILED' }];
  const d = disputeSummary('Wrote a tailored resume for the role.', steps);
  assert.ok(d);
  assert.match(d, /no successful write_resume/);
});

test('an honest summary of an honest run is never disputed', () => {
  const steps = [
    { tool: 'write_resume', ok: true, refused: false, result: 'resume written' },
    { tool: 'submit', ok: true, refused: false, result: 'Block blk_1 hands it to the human' },
  ];
  assert.equal(disputeSummary('Wrote a tailored resume and handed it to the human for review.', steps), null);
});

// ---------------------------------------------------------------------------
// A DENIAL CAN BE A LIST — caught live 2026-09-08
//
// Real run against a real Indeed posting. The agent hit Cloudflare's verification wall, correctly
// refused to attempt it, and stopped to ask Pierre. Its summary ended:
//
//     "The application was not accessed, filled, or submitted."
//
// The denial guard existed already, but its gap pattern was (?:\w+\s+){0,3} and could not cross the
// COMMAS in "accessed, filled, or ". So the denial went unseen, the bare word "submitted" counted as
// a claim of submission, and a textbook-correct run was recorded as failed and disputed.
//
// That is the second time this exact shape has thrown away a good run, and it matters more than it
// looks: a rail that files correct behaviour as failure makes every number built on top of it wrong,
// in the direction that hides real problems behind fake ones.
// ---------------------------------------------------------------------------
const CLOUDFLARE_SUMMARY = "Opened the Indeed URL, encountered Cloudflare's Additional Verification "
  + 'Required page, and asked Pierre to complete it. The application was not accessed, filled, or submitted.';

test('a denial written as a LIST is still a denial', () => {
  const steps = [{ tool: 'navigate', ok: true }, askHumanStep];
  assert.equal(disputeSummary(CLOUDFLARE_SUMMARY, steps), null,
    'stopping at a CAPTCHA and saying so plainly is correct behaviour, not a false claim');
});

test('the denial guard still works without the list', () => {
  const steps = [{ tool: 'navigate', ok: true }, askHumanStep];
  for (const s of [
    'It was not submitted; it will resume once the human supplies the degree level.',
    'The application was never sent.',
    'I did not submit the application.',
    'No application was submitted for this posting.',
  ]) {
    assert.equal(disputeSummary(s, steps), null, `denial not recognised: ${s}`);
  }
});

test('and a REAL false claim of submission is still caught', () => {
  // The whole point of the check. Widening the denial pattern must not blunt this.
  const steps = [{ tool: 'submit', ok: true, refused: false, result: 'NOT SUBMITTED — you are in Prepare mode.' }];
  const d = disputeSummary('The application was submitted successfully to the company.', steps);
  assert.ok(d, 'a claim of submission with no successful submit step must still be disputed');
  assert.match(d, /no successful submit step/);
});
