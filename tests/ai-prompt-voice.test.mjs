// Everything the model READS is a style example it will follow.
//
// Pierre's one non-negotiable rule for anything that leaves the machine in his name is no em dash,
// no en dash, no semicolon. The documents are gated on that by `voice-check`. But the gate only
// catches the mistake after the model has made it, and a document that fails the gate is a wasted
// step and a wasted run.
//
// The cheapest place to prevent it is upstream: never show the model that punctuation in the first
// place. Tool descriptions and the system prompt are the entire prompt surface, so this test holds
// that surface to the same rule the output is held to. It is here because the descriptions drifted
// back into em dashes twice while they were being tightened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const BANNED = [
  ['\u2014', 'em dash'],
  ['\u2013', 'en dash'],
  [';', 'semicolon'],
];

function offences(text) {
  return BANNED.filter(([ch]) => String(text).includes(ch)).map(([, name]) => name);
}

function everyTool() {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-voice-'));
  const { makeBrowserTools } = require(path.join(root, 'app/src/ai/tools/browser.js'));
  const { makeJatTools } = require(path.join(root, 'app/src/ai/tools/jat.js'));
  const { makeDocumentTools } = require(path.join(root, 'app/src/ai/tools/documents.js'));
  const { makeEscalateTools } = require(path.join(root, 'app/src/ai/tools/escalate.js'));
  const sandbox = require(path.join(root, 'app/src/ai/tools/sandbox.js'));
  return [
    // Chrome is launched lazily, so building the belt here starts no browser.
    ...makeBrowserTools({ profileId: 'voice-test', port: 9299 }).tools,
    ...makeJatTools({}).tools,
    ...makeDocumentTools({ root: docs }).tools,
    ...makeEscalateTools({}).tools,
    ...(sandbox.makeSandboxTools ? sandbox.makeSandboxTools().tools : sandbox.tools || []),
  ];
}

test('no tool description shows the model punctuation it must never write', () => {
  const bad = [];
  for (const t of everyTool()) {
    const found = offences(t.description || '');
    if (found.length) bad.push(`${t.name}: ${found.join(', ')}`);
  }
  assert.deepEqual(bad, [], `tool descriptions must not contain ${BANNED.map((b) => b[1]).join(', ')}`);
});

test('the assembled system prompt is clean too', () => {
  const loop = require(path.join(root, 'app/src/ai/agent-loop.js'));
  const registry = loop.makeRegistry(everyTool());
  const prompt = loop.systemPrompt(registry, 'Apply to one job.');
  assert.deepEqual(offences(prompt), [], 'the system prompt itself must obey the voice rules');
});

test('the test would actually catch a violation', () => {
  // A guard that cannot fail is not a guard.
  assert.deepEqual(offences('a \u2014 b'), ['em dash']);
  assert.deepEqual(offences('a; b'), ['semicolon']);
  assert.deepEqual(offences('plain words only'), []);
});
