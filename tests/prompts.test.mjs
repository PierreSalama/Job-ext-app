// Prompt library contracts — schemas exist where required, grounding rules
// are present, and no template throws on sparse input.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const prompts = require('../app/src/ai/prompts.js');

const JOB = { title: 'Engineer', company: 'Acme', description: 'Build things.' };
const PROFILE = { data: { firstName: 'Pierre', skills: ['JS'] } };

test('applyRescue: structured-actions schema + safety rules + no throw on sparse input', () => {
  const p = prompts.applyRescue({
    url: 'https://x/apply', routeState: 'linkedin_easy_apply_modal', failureReason: 'page stopped advancing',
    fields: [{ label: 'I certify the info is accurate', type: 'checkbox', required: true, value: '' }],
    buttons: ['Review', 'Submit application'], pageText: 'Before you submit',
    job: JOB, profile: PROFILE, qaHistory: [], resumeText: '',
  });
  assert.equal(p.kind, 'apply-rescue');
  assert.ok(p.schema && p.schema.properties.actions, 'has an actions array schema');
  assert.deepEqual(p.schema.properties.actions.items.properties.type.enum, ['fill', 'select', 'check', 'click', 'park']);
  assert.match(p.prompt, /NEVER/i, 'carries hard truthfulness/no-blind-submit rules');
  assert.match(p.prompt, /I certify the info is accurate/, 'includes the detected fields');
  assert.doesNotThrow(() => prompts.applyRescue({ profile: PROFILE }));
});

test('structured prompts carry a JSON schema', () => {
  for (const build of [
    () => prompts.fitScore({ job: JOB, profile: PROFILE, resumeText: '' }),
    () => prompts.answerQuestion({ question: 'Years of JS?', job: JOB, profile: PROFILE, qaHistory: [], resumeText: '' }),
    () => prompts.applyRescue({ failureReason: 'stuck', fields: [], buttons: [], profile: PROFILE }),
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
