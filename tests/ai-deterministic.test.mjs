// P4 (Apprenticeship Engine) — bundled local AI + deterministic no-model floor.
// deterministic.answer() grounds the common application questions with ZERO model
// (Dad's GPU-less laptop / a brand-new offline box) by mirroring prompts.js's
// high-confidence grounding block; hardware tiers keep proven Qwen/Llama for
// structured JSON and a Gemma for prose; localsetup.verifyChecksum rejects a
// corrupt weight; provisioning is ENOENT-safe and never throws. Temp DB (the floor
// uses db.normalizeQuestion + db.isSensitiveKey); createRequire harness mirrored
// from recipe-transfer.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));
const deterministic = require(path.join(here, '..', 'app', 'src', 'ai', 'deterministic.js'));
const hardware = require(path.join(here, '..', 'app', 'src', 'hardware.js'));
const localsetup = require(path.join(here, '..', 'app', 'src', 'localsetup.js'));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-detai-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

// A Toronto/Ontario Bachelor's profile with 5y experience, like a real harvested one.
const PROFILE = {
  data: {
    firstName: 'Pierre', city: 'Toronto', region: 'Ontario', country: 'Canada',
    highestDegree: "Bachelor's", major: 'Computer Science', yearsExperience: '5 years',
    workAuthorization: 'Canadian citizen',
  },
};
const RESUME = 'Software Engineer 2019–present. B.Sc. Computer Science, University of Toronto.';
const ctx = (extra = {}) => ({ profile: PROFILE, resume: RESUME, ...extra });

// ---------- deterministic.answer() ----------

test('residency: a Toronto profile answers "residing in BC?" = No', () => {
  const r = deterministic.answer('Are you currently residing in BC?', ctx());
  assert.ok(r, 'a grounded answer is returned');
  assert.equal(r.answer, 'No');
  assert.equal(r.source, 'deterministic');
  assert.ok(r.confidence >= 0.8);
});

test('residency: the same profile answers "residing in Ontario?" = Yes', () => {
  const r = deterministic.answer('Do you currently reside in Ontario?', ctx());
  assert.equal(r.answer, 'Yes');
});

test('residency: "a resident of Canada?" = Yes', () => {
  const r = deterministic.answer('Are you a resident of Canada?', ctx());
  assert.equal(r.answer, 'Yes');
});

test('which-location: country / province / city come from the profile', () => {
  assert.equal(deterministic.answer('What country are you located in?', ctx()).answer, 'Canada');
  assert.equal(deterministic.answer('Which province do you live in?', ctx()).answer, 'Ontario');
  assert.equal(deterministic.answer('What city are you based in?', ctx()).answer, 'Toronto');
});

test('education: a Bachelor\'s holder answers "completed a Bachelor\'s?" = Yes', () => {
  const r = deterministic.answer("Have you completed a Bachelor's degree?", ctx());
  assert.equal(r.answer, 'Yes');
  assert.ok(r.confidence >= 0.85);
});

test('education: a Bachelor\'s holder answers "do you hold a Master\'s?" = No (higher not held)', () => {
  const r = deterministic.answer("Do you hold a Master's degree or higher?", ctx());
  assert.equal(r.answer, 'No');
});

test('years-of-experience returns a NUMBER, never a URL', () => {
  const r = deterministic.answer('How many years of experience do you have with Java?', ctx());
  assert.ok(r, 'an answer is returned');
  assert.match(r.answer, /^\d+$/, 'the answer is a bare number');
  assert.doesNotMatch(r.answer, /https?:\/\/|www\.|\.com/i, 'never a URL/link for a quantity question');
  assert.equal(r.answer, '5', 'reads the profile yearsExperience');
});

test('preferred language defaults to English', () => {
  const r = deterministic.answer('What is your preferred language of correspondence?', ctx());
  assert.equal(r.answer, 'English');
});

test('relocation defaults to Yes (applicant presumed open)', () => {
  const r = deterministic.answer('Are you willing to relocate for this role?', ctx());
  assert.equal(r.answer, 'Yes');
  assert.ok(r.confidence >= 0.75);
});

test('authorized-to-work derives Yes from profile work authorization', () => {
  const r = deterministic.answer('Are you legally authorized to work in Canada?', ctx());
  assert.equal(r.answer, 'Yes');
});

test('when options are passed, the answer is EXACTLY one of them', () => {
  const r = deterministic.answer('Are you willing to relocate?', ctx({ options: ['Yes', 'No', 'Maybe'] }));
  assert.ok(['Yes', 'No', 'Maybe'].includes(r.answer), 'answer is one of the provided options');
  assert.equal(r.answer, 'Yes');

  // A residency No must also land on the verbatim option.
  const r2 = deterministic.answer('Are you residing in BC?', ctx({ options: ['Yes', 'No'] }));
  assert.ok(['Yes', 'No'].includes(r2.answer));
  assert.equal(r2.answer, 'No');
});

test('unanswerable niche question returns null (caller parks, never fabricates)', () => {
  const r = deterministic.answer('Describe a time you resolved a conflict on your team.', ctx());
  assert.equal(r, null);
});

test('never emits a credential/sensitive answer — returns null', () => {
  assert.equal(deterministic.answer('What is your account password?', ctx()), null);
  assert.equal(deterministic.answer('Enter your social security number (SSN)', ctx()), null);
});

test('a profile with no education on file does not guess', () => {
  const bare = { data: { city: 'Toronto', region: 'Ontario', country: 'Canada' } };
  assert.equal(deterministic.answer("Have you completed a Bachelor's degree?", { profile: bare, resume: '' }), null);
});

test('fitScore delegates to fit.js so relevance works with no model', () => {
  const job = { title: 'Java Engineer', description: 'We need strong Java and SQL skills.' };
  const prof = { data: { skills: ['Java', 'SQL'], headline: 'Java developer' } };
  const r = deterministic.fitScore(job, prof, '');
  assert.ok(typeof r.score === 'number' && r.score >= 0 && r.score <= 100);
  assert.ok(Array.isArray(r.matched));
});

// ---------- hardware tier mapping ----------

test('every tier keeps Qwen/Llama for structured and Gemma for prose', () => {
  for (const t of hardware.TIERS) {
    assert.match(t.structured, /qwen|llama/i, `${t.id} structured stays on the proven family`);
    assert.match(t.prose, /gemma/i, `${t.id} prose uses Gemma`);
  }
});

test('recommendModels returns {structuredModel, proseModel} for a tier', () => {
  const sm = hardware.recommendModels({ tier: 'sm' });
  assert.match(sm.structuredModel, /qwen|llama/i);
  assert.match(sm.proseModel, /gemma/i);
});

test('the no-GPU (sm) tier picks the SMALLEST models', () => {
  // tierFor with no VRAM and minimal RAM must select the last (smallest) tier.
  const smallest = hardware.TIERS[hardware.TIERS.length - 1];
  const picked = hardware.tierFor(0, 0);
  assert.equal(picked.id, smallest.id, 'no GPU + low RAM → smallest tier (Dad\'s laptop)');
  const rec = hardware.recommendModels({ tier: picked.id });
  assert.equal(rec.structuredModel, smallest.structured);
  assert.equal(rec.proseModel, smallest.prose);
  // And it really is the smallest of each family across all tiers.
  assert.equal(smallest.prose, 'gemma3:1b', 'smallest prose is Gemma 1B');
});

test('user override beats the auto-pick', () => {
  const rec = hardware.recommendModels({ tier: 'sm', structuredModel: 'mymodel:7b', proseModel: 'myprose:2b' });
  assert.equal(rec.structuredModel, 'mymodel:7b');
  assert.equal(rec.proseModel, 'myprose:2b');
});

// ---------- localsetup checksum + ENOENT-safe provisioning ----------

test('verifyChecksum accepts a correct sha256 and rejects a wrong one', async () => {
  const f = path.join(dir, 'weight.bin');
  fs.writeFileSync(f, 'pretend GGUF bytes');
  const realSha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  assert.equal(await localsetup.verifyChecksum(f, realSha), true, 'correct hash accepted');
  assert.equal(await localsetup.verifyChecksum(f, realSha.toUpperCase()), true, 'case-insensitive');
  assert.equal(await localsetup.verifyChecksum(f, 'deadbeef'.repeat(8)), false, 'wrong hash rejected');
  assert.equal(await localsetup.verifyChecksum(path.join(dir, 'nope.bin'), realSha), false, 'missing file rejected');
});

test('provisioning entrypoint never throws when no runtime is present (ENOENT-safe)', async () => {
  // Point at a dead Ollama URL so detect/pull cannot succeed; provision must resolve
  // (not reject) and report a benign state — the deterministic floor stays active.
  let res;
  await assert.doesNotReject(async () => {
    res = await localsetup.provision({ cfg: { url: 'http://127.0.0.1:1', exePath: 'definitely-not-a-real-binary-xyz' }, override: { tier: 'sm' } });
  });
  assert.ok(res && typeof res === 'object', 'provision resolves to a result object');
  assert.ok(Array.isArray(res.models), 'reports the (attempted) tier models');
});
