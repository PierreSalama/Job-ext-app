// The Claude CLI is used as a TEXT GENERATOR, not as an agent.
//
// JAT runs its own agent loop: it hands the model a list of JAT's tools and asks which one to use
// next, as JSON. The CLI, left to its defaults, brings its own toolset to that conversation. Three
// separate end-to-end application runs died because of it: late in a run the model stopped
// describing the next action and tried to actually invoke `recall_answer`, its harness replied
// "No such tool available", and the model then reported that JAT's tools had all stopped working.
// The run ended two steps from a finished application, with a summary that was false but, from
// where the model was sitting, honest.
//
// So the toolset is switched off at the invocation. This test pins that, because nothing else in
// the system would notice if it came back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'app/src/ai/claude.js'), 'utf8');

test('the CLI is invoked with its own tools disabled', () => {
  assert.match(src, /args\.push\('--tools', ''\)/, 'the CLI must be given an empty toolset');
});

test('the tool lockout is not conditional on anything', () => {
  // A flag that only applies to "agent" calls would leave every other call path holding a shell.
  const line = src.split('\n').findIndex((l) => l.includes("args.push('--tools', '')"));
  assert.ok(line > 0);
  const before = src.split('\n').slice(Math.max(0, line - 12), line).join('\n');
  assert.equal(/\bif\s*\(/.test(before.split('//').join('')), false,
    'the lockout must be unconditional, not inside a branch');
});

test('the reason is written down where the next person will find it', () => {
  // This one cost three thrown-away runs to diagnose. It must not be re-litigated from scratch.
  assert.match(src, /No such tool available/, 'the symptom belongs next to the fix');
});
