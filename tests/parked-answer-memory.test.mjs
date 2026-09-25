// The AI-answer pass (tools/ai-answer-parked.mjs) runs every 30 minutes on the applier laptop.
// Before 2026-09-23 it had no memory: a question the model could not answer confidently stayed
// parked, so every pass sent the same questions back to the model. Measured on the laptop that day:
// 16 unchanged questions x 52 passes, about 830 Claude calls a day, and 3,639 "weekly limit" errors
// in the week it used up Pierre's Claude plan.
//
// These tests run the REAL script against a fake app and count the model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(root, 'tools', 'ai-answer-parked.mjs');

function fakeApp({ questions, reply, profile = { data: { firstName: 'pierre' } }, intakeStatus = 200 }) {
  const state = { generate: 0, intake: 0 };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/profiles') return send(200, { items: [profile] });
    if (req.url === '/auto-apply/needs-you') return send(200, { items: [{ company: 'acme', questions }] });
    if (req.url === '/documents') return send(200, { items: [] });
    if (req.url === '/ai/generate') {
      state.generate++;
      const q = (JSON.parse(body).prompt.match(/QUESTION \(field type: [^)]*\): (.*)/) || [])[1];
      return send(200, { json: reply(q) });
    }
    if (req.url === '/auto-apply/intake') {
      state.intake++;
      return intakeStatus === 200 ? send(200, { saved: JSON.parse(body).answers.length, requeued: 0 }) : send(intakeStatus, { ok: false });
    }
    send(404, {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, base: `http://127.0.0.1:${server.address().port}` })));
}

function runPass(base, cache, extra = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--base', base, '--token', 't', '--cache', cache, ...extra]);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

const tmpCache = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jat-parked-')), 'cache.json');
const QS = [
  { question: 'Do you have Kotlin experience?', fieldType: 'radio', options: ['Yes', 'No'] },
  { question: 'Do you have a valid driver\'s licence?', fieldType: 'radio', options: ['Yes', 'No'] },
];
const lowForAll = () => ({ answer: 'No', confidence: 0, evidence: 'not in profile' });

test('an unsure question is asked once, not on every pass', async () => {
  const app = await fakeApp({ questions: QS, reply: lowForAll });
  const cache = tmpCache();
  try {
    await runPass(app.base, cache);
    assert.equal(app.state.generate, 2, 'first pass asks both questions');
    const second = await runPass(app.base, cache);
    const third = await runPass(app.base, cache);
    assert.equal(app.state.generate, 2, 'later passes must not ask the same questions again');
    assert.match(second.out, /REMEMBERED 2 question/);
    assert.match(third.out, /REMEMBERED 2 question/);
  } finally { app.server.close(); }
});

test('a NEW question is still asked while old ones are remembered', async () => {
  const qs = [...QS];
  const app = await fakeApp({ questions: qs, reply: lowForAll });
  const cache = tmpCache();
  try {
    await runPass(app.base, cache);
    qs.push({ question: 'Are you authorized to work in Canada?', fieldType: 'radio', options: ['Yes', 'No'] });
    await runPass(app.base, cache);
    assert.equal(app.state.generate, 3, 'only the new question goes to the model');
  } finally { app.server.close(); }
});

test('a profile change re-opens every question', async () => {
  const profile = { data: { firstName: 'pierre', skills: ['React'] } };
  const app = await fakeApp({ questions: QS, reply: lowForAll, profile });
  const cache = tmpCache();
  try {
    await runPass(app.base, cache);
    profile.data.skills.push('Kotlin');
    await runPass(app.base, cache);
    assert.equal(app.state.generate, 4, 'new facts can change the answer, so both are asked again');
  } finally { app.server.close(); }
});

test('the memory expires after --ttl-days', async () => {
  const app = await fakeApp({ questions: QS, reply: lowForAll });
  const cache = tmpCache();
  try {
    await runPass(app.base, cache);
    const mem = JSON.parse(fs.readFileSync(cache, 'utf8'));
    for (const v of Object.values(mem)) v.at = new Date(Date.now() - 8 * 864e5).toISOString();
    fs.writeFileSync(cache, JSON.stringify(mem));
    await runPass(app.base, cache, ['--ttl-days', '7']);
    assert.equal(app.state.generate, 4, 'an 8-day-old memory is stale at a 7-day TTL');
  } finally { app.server.close(); }
});

test('a save the app refused is NOT remembered', async () => {
  const app = await fakeApp({ questions: QS, reply: () => ({ answer: 'No', confidence: 0.95, evidence: 'skills list' }), intakeStatus: 500 });
  const cache = tmpCache();
  try {
    const first = await runPass(app.base, cache);
    assert.equal(first.code, 1, 'a failed intake is a failed pass');
    await runPass(app.base, cache);
    assert.equal(app.state.generate, 4, 'nothing was saved, so the next pass asks again');
  } finally { app.server.close(); }
});

test('--dry and --no-cache never write the memory', async () => {
  const app = await fakeApp({ questions: QS, reply: lowForAll });
  const cache = tmpCache();
  try {
    await runPass(app.base, cache, ['--dry']);
    assert.equal(fs.existsSync(cache), false);
    await runPass(app.base, cache, ['--no-cache']);
    assert.equal(fs.existsSync(cache), false);
    assert.equal(app.state.generate, 4);
  } finally { app.server.close(); }
});
