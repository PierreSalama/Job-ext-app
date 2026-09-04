// AI Apply chunk 6 — the voice check and the document gate.
//
// The voice rules are Pierre's standing brief: no em or en dash, no semicolon, and none of
// "wanted to reach out" / "passionate about" / "leverage" / "excited about the opportunity".
//
// The important tests here are the HTML ones. Overnight these documents were checked with a grep
// over the raw file, which reported a violation for every `&middot;` (an entity ending in a
// semicolon) — so `;` was dropped from the check for HTML, silently disabling the semicolon rule
// on the documents most likely to contain one. Decoding first fixes both halves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const vc = require(path.join(root, 'app', 'src', 'ai', 'voice-check.js'));
const docs = require(path.join(root, 'app', 'src', 'ai', 'tools', 'documents.js'));

// ---------------------------------------------------------------------------
// prose
// ---------------------------------------------------------------------------
test('clean prose passes', () => {
  const r = vc.voiceCheck('I build the tools and I answer when they break. That is the job.', { html: false });
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
});

test('every banned construction is caught, with a fix', () => {
  const cases = [
    ['An em dash — like this', 'em-dash'],
    ['A range 2020–2024', 'en-dash'],
    ['One thing; another thing', 'semicolon'],
    ['I wanted to reach out about the role', 'reach-out'],
    ['I am passionate about backend work', 'passionate'],
    ['We leverage Postgres heavily', 'leverage'],
    ['I am excited about the opportunity to join', 'excited-opportunity'],
  ];
  for (const [text, rule] of cases) {
    const r = vc.voiceCheck(text, { html: false });
    assert.equal(r.ok, false, `"${text}" should fail`);
    assert.equal(r.violations[0].rule, rule);
    assert.ok(r.violations[0].fix.length > 5, 'every violation must say what to do instead');
  }
});

test('"leverage" is caught in all its forms but "lever" is not', () => {
  for (const s of ['leverages', 'leveraged', 'leveraging']) {
    assert.equal(vc.voiceCheck(`We ${s} it`, { html: false }).ok, false);
  }
  assert.equal(vc.voiceCheck('He pulled the lever and the levers moved', { html: false }).ok, true);
});

test('a violation points at a real line and shows its surroundings', () => {
  const text = 'line one\nline two\nthis one has a semicolon; right here\nline four';
  const r = vc.voiceCheck(text, { html: false });
  assert.equal(r.violations[0].line, 3);
  assert.match(r.violations[0].context, /semicolon; right here/);
});

// ---------------------------------------------------------------------------
// HTML — the half that was broken overnight
// ---------------------------------------------------------------------------
test('THE OVERNIGHT BUG: &middot; is not a semicolon violation', () => {
  const html = '<body><p class="contact">Toronto, ON &middot; (647) 963-7745 &middot; pierre@example.com</p></body>';
  const r = vc.voiceCheck(html, { html: true });
  assert.equal(r.ok, true, 'entities must be decoded before the semicolon rule runs');
});

test('…and a REAL semicolon in HTML prose is still caught', () => {
  const html = '<body><p>I built the pipeline; it repairs itself.</p></body>';
  const r = vc.voiceCheck(html, { html: true });
  assert.equal(r.ok, false, 'this is exactly what the old workaround stopped detecting');
  assert.equal(r.violations[0].rule, 'semicolon');
});

test('an &mdash; entity is caught, which a raw grep never could', () => {
  const r = vc.voiceCheck('<body><p>Toronto &mdash; Ontario</p></body>', { html: true });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].rule, 'em-dash');
});

test('an entity we do not model does not leave its semicolon behind', () => {
  // Caught by running the gate over the 94 documents actually sent to employers: `0&rarr;1` was
  // the single "failure", for a semicolon that exists only inside the entity.
  assert.equal(vc.voiceCheck('<body><p>0&rarr;1 Products and Quality Pipelines</p></body>', { html: true }).ok, true);
  assert.equal(vc.voiceCheck('<body><p>a &nosuchentity; b</p></body>', { html: true }).ok, true);
  // …but a modelled dash entity must still be caught rather than swallowed.
  assert.equal(vc.voiceCheck('<body><p>a &mdash; b</p></body>', { html: true }).ok, false);
});

test('semicolons inside <style> and <script> are code, not prose', () => {
  const html = '<html><head><style>body { margin: 0; color: red; }</style>'
    + '<script>const a = 1; const b = 2;</script></head><body><p>Clean copy here.</p></body></html>';
  assert.equal(vc.voiceCheck(html, { html: true }).ok, true);
});

test('the real résumé template head is itself clean under these rules', () => {
  // If the shared template tripped the gate, every tailored résumé would be refused.
  const head = docs.resumeHead();
  assert.equal(vc.voiceCheck(head, { html: true }).ok, true, 'the shared head must not fail the gate');
});

test('html mode is detected when not stated', () => {
  assert.equal(vc.voiceCheck('<p>a &middot; b</p>').ok, true, 'entities decoded');
  assert.equal(vc.voiceCheck('plain text; with a semicolon').ok, false, 'plain text checked as prose');
});

// ---------------------------------------------------------------------------
// the document gate
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-docs-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

const belt = docs.makeDocumentTools({ root: tmp });
const byName = Object.fromEntries(belt.tools.map((t) => [t.name, t]));
const call = async (name, args) => {
  const t = byName[name];
  if (t.guard) { const r = await t.guard(args, {}); if (r) return { refused: r }; }
  return { result: await t.run(args, {}) };
};

const GOOD_BODY = '<body><h1>Pierre Salama</h1><p class="role">Software Developer &middot; Python and React</p>'
  + '<p>I am the only developer on a 15 application platform. I build it and I answer when it breaks.</p></body>';

test('a résumé that breaks the rules is REFUSED and nothing is written', async () => {
  const bad = '<body><h1>Pierre</h1><p>I am passionate about backend work — truly.</p></body>';
  const r = await call('write_resume', { company: 'Refused Co', bodyHtml: bad });
  assert.ok(r.refused, 'must not be written');
  assert.match(r.refused, /passionate/);
  assert.match(r.refused, /em dash/);
  assert.equal(fs.existsSync(path.join(tmp, 'refused-co')), false, 'not even the folder may be created');
});

test('a résumé without a <body> is refused with a usable message', async () => {
  const r = await call('write_resume', { company: 'X Co', bodyHtml: '<h1>hi</h1>' });
  assert.match(r.refused, /must be a full <body>/);
});

test('a too-short cover letter is refused rather than written', async () => {
  const r = await call('write_cover_letter', { company: 'Y Co', text: 'Hi, hire me.' });
  assert.match(r.refused, /too short/);
});

test('a cover letter that breaks the rules is refused', async () => {
  const r = await call('write_cover_letter', {
    company: 'Z Co',
    text: 'Hello,\n\nI wanted to reach out because I am passionate about this role. '.repeat(6),
  });
  assert.ok(r.refused);
  assert.match(r.refused, /wanted to reach out/);
});

test('a clean cover letter is written to the company folder', async () => {
  const text = 'Hi,\n\nI am the only developer on a 15 application platform at Tacel. '
    + 'I build the services, the data layer and the applications on top of them, and I answer when '
    + 'something breaks. That is the shape of the job you are describing.\n\nPierre Salama\n';
  const r = await call('write_cover_letter', { company: 'Clean Co', text });
  assert.ok(!r.refused, r.refused);
  const file = path.join(tmp, 'clean-co', 'cover-letter.txt');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('a clean résumé renders a real PDF using the shared head', { timeout: 120000 }, async () => {
  const r = await call('write_resume', { company: 'Clean Co', bodyHtml: GOOD_BODY });
  assert.ok(!r.refused, r.refused);
  const dir = path.join(tmp, 'clean-co');

  const rendered = fs.readFileSync(path.join(dir, 'render.html'), 'utf8');
  assert.match(rendered, /<style>/, 'the shared head must be prepended');
  assert.match(rendered, /Pierre Salama/);

  const pdf = fs.readdirSync(dir).find((f) => f.endsWith('.pdf'));
  assert.ok(pdf, 'a PDF must exist');
  const buf = fs.readFileSync(path.join(dir, pdf));
  assert.ok(buf.length > 1000, 'a real PDF, not an empty file');
  assert.equal(buf.slice(0, 5).toString(), '%PDF-', 'must actually be a PDF');
});

test('list_documents reports what is there, and says so when nothing is', async () => {
  assert.match((await call('list_documents', { company: 'Clean Co' })).result, /cover-letter\.txt/);
  assert.match((await call('list_documents', { company: 'Never Heard Of' })).result, /nothing prepared/);
});

test('the tools declare themselves for the agent registry', () => {
  const loop = require(path.join(root, 'app', 'src', 'ai', 'agent-loop.js'));
  const d = loop.makeRegistry(belt.tools).describe();
  assert.match(d, /- write_resume\(company, bodyHtml\)/);
  assert.match(d, /- voice_check\(text\)/);
});
