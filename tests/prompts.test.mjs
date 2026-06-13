// Prompt library contracts — schemas exist where required, grounding rules
// are present, and no template throws on sparse input.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const prompts = require('../app/src/ai/prompts.js');

const JOB = { title: 'Engineer', company: 'Acme', description: 'Build things.' };
const PROFILE = { data: { firstName: 'Pierre', skills: ['JS'] } };

test('structured prompts carry a JSON schema', () => {
  for (const build of [
    () => prompts.fitScore({ job: JOB, profile: PROFILE, resumeText: '' }),
    () => prompts.answerQuestion({ question: 'Years of JS?', job: JOB, profile: PROFILE, qaHistory: [], resumeText: '' }),
    () => prompts.classifyEmail({ subject: 's', from: 'f', body: 'b' }),
    () => prompts.resumeParse({ resumeText: 'text' }),
    () => prompts.validateCapture({ job: JOB }),
  ]) {
    const p = build();
    assert.ok(p.schema && p.schema.type === 'object', `${p.kind} should have an object schema`);
    assert.ok(Array.isArray(p.schema.required), `${p.kind} schema should declare required fields`);
  }
});

test('prose prompts have no schema but set prose flag', () => {
  for (const build of [
    () => prompts.coverLetter({ job: JOB, profile: PROFILE, resumeText: '' }),
    () => prompts.tailorResume({ job: JOB, resumeText: 'resume', profile: PROFILE }),
    () => prompts.followUp({ job: JOB, profile: PROFILE, daysSince: 7 }),
  ]) {
    const p = build();
    assert.equal(p.schema, undefined);
    assert.equal(p.prose, true);
  }
});

test('grounding rules are stated', () => {
  assert.match(prompts.tailorResume({ job: JOB, resumeText: 'r' }).prompt, /Never invent experience/i);
  assert.match(prompts.answerQuestion({ question: 'q', job: JOB, profile: PROFILE }).prompt, /refuse/i);
  assert.match(prompts.SYSTEM_BASE, /never invent/i);
});

test('templates tolerate empty input', () => {
  assert.doesNotThrow(() => prompts.fitScore({ job: {}, profile: null, resumeText: null }));
  assert.doesNotThrow(() => prompts.answerQuestion({ question: 'q' }));
  assert.doesNotThrow(() => prompts.summarizeJob({ job: {} }));
});

test('answer-question forces options verbatim when provided', () => {
  const p = prompts.answerQuestion({ question: 'Auth?', options: ['Yes', 'No'], job: JOB, profile: PROFILE });
  assert.match(p.prompt, /exactly one of these options verbatim/i);
  assert.match(p.prompt, /"Yes"/);
});
