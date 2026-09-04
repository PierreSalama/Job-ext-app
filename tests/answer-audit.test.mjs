// Answer bank cleanup — the audit, the in-place edit, and the bulk-delete guard.
//
// Every fixture below is a REAL row from Pierre's live bank on 2026-09-04. The bank had 1000
// answers and auto-apply submits from it, so a wrong row goes out under his name.
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
const audit = require(path.join(root, 'app', 'src', 'answer-audit.js'));
const db = require(path.join(root, 'app', 'src', 'db.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-ansaudit-'));
db.open(dir);
process.on('exit', () => {
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
});

const verdict = (question, answer) => audit.auditAnswer({ question, answer });

// ---------------------------------------------------------------------------
// junk — objectively not an answer
// ---------------------------------------------------------------------------
test('a captured widget value is junk, not an answer', () => {
  const v = verdict('Are you able to work on a T4 basis without sponsorship?', 'on');
  assert.equal(v.severity, 'junk');
  assert.match(v.reason, /checkbox or widget value/);
});

test('a bare number against a worded question is junk', () => {
  const v = verdict('are you a canadian citizen or permanent resident of canada', '37');
  assert.equal(v.severity, 'junk');
  assert.match(v.reason, /number field was captured/);
});

test('a question whose answer IS digits is not junk', () => {
  // Caught on the live bank: "mobile phone number" -> "6479637745" was classified junk, which put
  // his own phone number in the bulk-delete group. A false positive here destroys real data.
  for (const [q, a] of [
    ['mobile phone number', '6479637745'],
    ['Phone number', '+1 647 963 7745'],
    ['Postal code', 'M5V 2T6'],
    ['How many years of experience do you have with React?', '3'],
    ['What are your salary expectations?', '105000'],
  ]) {
    assert.notEqual(audit.auditAnswer({ question: q, answer: a }).severity, 'junk',
      `"${q}" -> "${a}" must not be treated as mis-captured`);
  }
});

test('a scraped widget id is junk even on a high-stakes question', () => {
  // Live row: a GUID stored as the answer to a work-authorization question. Without this rule it
  // is offered to Pierre as a judgement call, when there is nothing to judge.
  const v = verdict("yes i'm legally eligible to work in canada without the need for sponsorship",
    '038b36c9-c68b-42a3-9671-7ab5ddf009be');
  assert.equal(v.severity, 'junk');
  assert.match(v.reason, /internal id/);
});

test('a long ordinary sentence is NOT mistaken for an opaque token', () => {
  const v = verdict('Why do you want to work here?', 'Because the team builds tools I would actually use every day.');
  assert.equal(v.severity, 'ok');
});

test('a dropdown placeholder is junk', () => {
  for (const a of ['-- No answer --', 'Select an option', 'Please select', '', 'n/a']) {
    assert.equal(verdict('What is your notice period?', a).severity, 'junk', `"${a}" should be junk`);
  }
});

// ---------------------------------------------------------------------------
// broken — the answer cannot fit the question
// ---------------------------------------------------------------------------
test('a province is not an answer to an attestation', () => {
  const v = verdict('i certify that the facts set forth in this application for employment are true and complete', 'Ontario');
  assert.equal(v.severity, 'broken');
  assert.match(v.reason, /not a .* answer/);
});

test('"Canada" is not an answer to a yes/no question', () => {
  const v = verdict('will you now or in the future require sponsorship to be able to work in the country', 'Canada');
  assert.equal(v.severity, 'broken');
});

// ---------------------------------------------------------------------------
// review — well-formed, but only Pierre knows if it is TRUE
// ---------------------------------------------------------------------------
test('THE DANGEROUS ONE: a well-formed but decisive answer is flagged for review', () => {
  // This row passes every shape check — it is a valid yes/no answer to a yes/no question — and it
  // is the single most damaging row in the bank, because it is false.
  const v = verdict('Are you legally authorized to work in Canada or the US for any employer?', 'No');
  assert.equal(v.severity, 'review');
  assert.ok(v.stakes.includes('work-auth'), 'work authorization must be recognised');
  assert.match(v.reason, /wrong value here/);
});

test('sponsorship, citizenship and salary are all high stakes', () => {
  assert.ok(verdict('Will you require visa sponsorship now or in the future?', 'Yes').stakes.includes('sponsorship'));
  assert.ok(verdict('Are you a Canadian citizen?', 'Yes').stakes.includes('citizenship'));
  assert.ok(verdict('What are your salary expectations?', '105000').stakes.includes('salary'));
});

test('an ordinary question with a sane answer is left alone', () => {
  for (const [q, a] of [
    ['How did you hear about us?', 'LinkedIn'],
    ['Do you have experience with React?', 'Yes'],
    ['What is your notice period?', 'Two weeks'],
  ]) {
    assert.equal(verdict(q, a).severity, 'ok', `"${q}" -> "${a}" should not be flagged`);
  }
});

test('a high-stakes question whose answer is ALSO malformed is reported as junk, not review', () => {
  // Severity is about what to DO with it. A "37" needs deleting whatever the question was.
  assert.equal(verdict('Are you a Canadian citizen or permanent resident?', '37').severity, 'junk');
});

// ---------------------------------------------------------------------------
// the summary
// ---------------------------------------------------------------------------
test('auditAll counts, filters and orders by what needs deciding first', () => {
  const rows = [
    { id: '1', question: 'How did you hear about us?', answer: 'LinkedIn' },
    { id: '2', question: 'Are you legally authorized to work in Canada?', answer: 'No', seen_count: 3 },
    { id: '3', question: 'i certify the facts are true and complete', answer: 'Ontario' },
    { id: '4', question: 'Are you able to work on a T4 basis?', answer: 'on' },
  ];
  const r = audit.auditAll(rows);
  assert.equal(r.counts.total, 4);
  assert.equal(r.counts.ok, 1);
  assert.equal(r.items.length, 3, 'clean rows are not listed');
  assert.equal(r.items[0].severity, 'review', 'the decision he must make comes first');
  assert.deepEqual(r.items.map((i) => i.severity), ['review', 'broken', 'junk']);
});

test('within a severity, the most-used answers come first', () => {
  const rows = [
    { id: 'a', question: 'Do you consent to a background check?', answer: 'maybe-ish', seen_count: 2 },
    { id: 'b', question: 'Do you have a valid drivers licence?', answer: 'Toronto', seen_count: 40 },
  ];
  const r = audit.auditAll(rows);
  assert.equal(r.items[0].id, 'b', 'the one submitted 40 times matters more than the one used twice');
});

// ---------------------------------------------------------------------------
// editing
// ---------------------------------------------------------------------------
test('qaSetAnswer corrects a row in place and keeps its history', () => {
  const pid = db.ensureDefaultProfileId();
  const saved = db.qaRecord({
    profileId: pid,
    question: 'Are you legally authorized to work in Canada or the US for any employer?',
    answer: 'No',
    lineageSource: 'user',
  });
  assert.ok(saved, 'fixture must be stored');
  const before = db.qaList(pid, 500).find((r) => r.id === saved.id);

  const after = db.qaSetAnswer(saved.id, 'Yes — authorized in Canada, would need sponsorship for the US');
  assert.ok(after);
  assert.match(after.answer, /^Yes/);
  assert.equal(after.question, before.question, 'the question must not change');
  assert.equal(after.seen_count, before.seen_count, 'usage history is preserved');
  assert.equal(audit.auditAnswer(after).severity, 'review', 'still worth his eyes, but now correct');
});

test('an answer cannot be blanked or replaced with a placeholder', () => {
  const pid = db.ensureDefaultProfileId();
  const row = db.qaRecord({ profileId: pid, question: 'What is your preferred start date?', answer: 'Two weeks from offer', lineageSource: 'user' });
  assert.throws(() => db.qaSetAnswer(row.id, '   '), /cannot be blank/);
  assert.throws(() => db.qaSetAnswer(row.id, '-- No answer --'), /placeholder/);
  assert.equal(db.qaList(pid, 500).find((r) => r.id === row.id).answer, 'Two weeks from offer');
});

test('editing an id that does not exist reports it rather than pretending', () => {
  assert.equal(db.qaSetAnswer('qa_nope', 'x'), null);
});

// ---------------------------------------------------------------------------
// the bulk-delete guard
// ---------------------------------------------------------------------------
const serverJs = fs.readFileSync(path.join(root, 'app', 'src', 'server.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'extension', 'app', 'app.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'extension', 'app', 'app.html'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'extension', 'app', 'app.css'), 'utf8');

test('bulk delete re-audits server-side and refuses anything but junk', () => {
  const block = serverJs.slice(serverJs.indexOf("pathname === '/qa/bulk-delete'"));
  assert.match(block, /answerAudit\.auditAnswer\(row\)/, 'the server must decide, not trust the client list');
  assert.match(block, /verdict\.severity !== 'junk'/, 'only junk may be removed in bulk');
  assert.match(block, /refused\.push/, 'and it must report what it declined');
});

test('the page, nav entry and endpoints all exist and agree', () => {
  assert.match(appHtml, /data-route="\/answers"/);
  assert.match(appJs, /route\('\/answers'/);
  for (const ep of ["'/qa/audit'", "'/qa/bulk-delete'"]) assert.ok(serverJs.includes(ep), `missing ${ep}`);
  for (const hook of ['data-clearjunk', 'data-save', 'data-del', 'data-answer']) {
    assert.ok(appJs.includes(hook), `missing control ${hook}`);
  }
});

test('only the junk group offers a bulk action', () => {
  assert.match(appJs, /g\.sev === 'junk' \? '<button[^']*data-clearjunk/,
    'review and broken rows must be handled one at a time');
});

test('the styles cover every severity and use theme variables only', () => {
  for (const sev of ['review', 'broken', 'junk']) {
    assert.ok(appCss.includes(`.ans-row[data-sev="${sev}"]`), `no style for ${sev}`);
  }
  const block = appCss.slice(appCss.indexOf('/* ---------- Answer bank'));
  assert.deepEqual(block.match(/#[0-9a-f]{3,8}\b/gi) || [], [], 'must theme cleanly');
});

test('the dashboard copies are byte-identical', () => {
  for (const f of ['app.js', 'app.css', 'app.html']) {
    const a = fs.readFileSync(path.join(root, 'extension', 'app', f));
    const b = fs.readFileSync(path.join(root, 'app', 'src', 'app', f));
    assert.ok(a.equals(b), `${f} drifted — run \`npm run mirror\``);
  }
});
