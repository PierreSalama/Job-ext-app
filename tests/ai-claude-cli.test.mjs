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
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
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

// All three tests above read claude.js as TEXT. The file even says "nothing else in the system
// would notice if it came back" — which was true of the system and, until now, true of its tests.
// Rename the variable, build the args somewhere else, or push them onto a different array and every
// assertion above still passes while the CLI gets its full toolset back and the three thrown-away
// runs come with it. So capture the argv the CLI is actually spawned with.
test('BEHAVIOUR: every invocation really is spawned with an empty toolset', async (t) => {
  const cp = require('child_process');
  const realSpawn = cp.spawn;
  const realSpawnSync = cp.spawnSync;
  const seen = [];

  cp.spawnSync = () => ({ status: 0, stdout: process.execPath, stderr: '' });
  cp.spawn = (cmd, args) => {
    // A COPY, deliberately. Capturing the array by reference lets any push AFTER the spawn call
    // mutate what this test later inspects — which made an earlier version of this test pass while
    // the flag was being appended too late for the CLI to ever receive it.
    seen.push(args.slice());
    const { EventEmitter } = require('events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', JSON.stringify({ result: '{"ok":true}' }));
      child.emit('close', 0);
    });
    return child;
  };
  t.after(() => { cp.spawn = realSpawn; cp.spawnSync = realSpawnSync; });

  const claude = require(path.join(root, 'app/src/ai/claude.js'));

  // Every shape a caller can produce: bare, with a system prompt, with a schema, with both.
  const shapes = [
    { prompt: 'hi' },
    { prompt: 'hi', system: 'be terse' },
    { prompt: 'hi', schema: { type: 'object' } },
    { prompt: 'hi', system: 'be terse', schema: { type: 'object' } },
  ];
  for (const shape of shapes) {
    seen.length = 0;
    await claude.generate(shape).catch(() => {});
    assert.equal(seen.length, 1, 'exactly one spawn');
    const args = seen[0];
    const at = args.indexOf('--tools');
    assert.ok(at >= 0, `--tools missing for ${JSON.stringify(Object.keys(shape))}`);
    assert.equal(args[at + 1], '', 'the toolset must be EMPTY, not merely present');
  }
});
