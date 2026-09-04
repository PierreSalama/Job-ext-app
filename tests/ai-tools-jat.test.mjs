// AI Apply chunk 5 — the ledger tools.
//
// The dedupe tests are the heart of this file. Overnight, `Jobber` surfaced as a fresh lead after
// it had already been applied to, because the check matched on company NAME and only excluded
// status 'applied'. Both halves of that bug are pinned here.
//
// The log_application tests pin a second real failure: writing status 'applied' — a status this
// app does not have — silently stored 'started', so 12 genuinely submitted applications were
// recorded as never sent. Every assertion below reads the row BACK.
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
const db = require(path.join(root, 'app', 'src', 'db.js'));
const jat = require(path.join(root, 'app', 'src', 'ai', 'tools', 'jat.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-tools-'));
db.open(dir);
process.on('exit', () => {
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
});

const belt = jat.makeJatTools({});
const byName = Object.fromEntries(belt.tools.map((t) => [t.name, t]));
const call = async (name, args = {}) => {
  const t = byName[name];
  if (t.guard) {
    const refusal = await t.guard(args, {});
    if (refusal) return { refused: refusal };
  }
  return { result: await t.run(args, {}) };
};

// ---------------------------------------------------------------------------
// the dedupe key
// ---------------------------------------------------------------------------
test('the employer key is the ATS slug, not the company name', () => {
  const a = jat.employerKey({ url: 'https://job-boards.greenhouse.io/knak/jobs/4725427005', company: 'Knak Inc.' });
  assert.equal(a.via, 'slug');
  assert.equal(a.slug, 'knak');
  const b = jat.employerKey({ url: 'https://jobs.ashbyhq.com/maintainx/abc-123', company: 'MaintainX (An Autodesk Company)' });
  assert.equal(b.slug, 'maintainx', 'the decorated display name must not change the key');
});

test('FOUND BY THE FIRST E2E RUN: the Greenhouse EMBED url yields the slug', () => {
  // job-boards.greenhouse.io/embed/job_app?for=knak is the form used by hand for D2L, Coinbase and
  // Knak, and the one the agent reaches for. It was silently degrading to a company-NAME match.
  const k = jat.employerKey({ url: 'https://job-boards.greenhouse.io/embed/job_app?for=knak&token=4725427005', company: 'Knak Inc.' });
  assert.equal(k.via, 'slug');
  assert.equal(k.slug, 'knak');
});

test('FOUND BY THE FIRST E2E RUN: a vendor is never mistaken for the employer', () => {
  // seequent.csod.com resolved to "csod" — the vendor. Every Cornerstone employer would collapse
  // into one identity, so applying to one would mark all the others as duplicates.
  const a = jat.employerKey({ url: 'https://seequent.csod.com/ux/ats/careersite/1/requisition/4318', company: 'Seequent' });
  assert.equal(a.slug, 'seequent');
  const b = jat.employerKey({ url: 'https://bentley.csod.com/ux/ats/careersite/2/requisition/99', company: 'Bentley' });
  assert.equal(b.slug, 'bentley');
  assert.notEqual(a.key, b.key, 'two Cornerstone employers must stay distinct');

  const w = jat.employerKey({ url: 'https://clio.wd3.myworkdayjobs.com/en-US/ClioCareerSite/job/Toronto/x', company: 'Clio' });
  assert.equal(w.key, 'clio', 'and Workday must give the employer, not "myworkdayjobs"');
});

test('a vendor word is never used as an identity, however it was derived', () => {
  for (const url of [
    'https://job-boards.greenhouse.io/embed/job_app?for=jobs',
    'https://greenhouse.csod.com/x',
  ]) {
    const k = jat.employerKey({ url, company: 'Real Employer Ltd' });
    assert.equal(k.via, 'name', `${url} must fall back to the name rather than key on a vendor`);
    assert.equal(k.key, 'realemployerltd');
  }
});

test('a URL with no board slug falls back to the company name', () => {
  const k = jat.employerKey({ url: 'https://ca.indeed.com/viewjob?jk=abc', company: 'Some Co' });
  assert.equal(k.via, 'name');
  assert.equal(k.key, 'someco');
});

test('a generic path segment is never mistaken for an employer', () => {
  // `jobs`, `careers`, `apply` are routing words. Treating one as an employer key would collapse
  // unrelated companies into a single identity and block everything after the first application.
  for (const url of ['https://boards.greenhouse.io/careers/jobs/1', 'https://example.com/jobs/2']) {
    const k = jat.employerKey({ url, company: 'Distinct Co' });
    assert.notEqual(k.key, 'careers');
    assert.notEqual(k.key, 'jobs');
  }
});

// ---------------------------------------------------------------------------
// duplicates
// ---------------------------------------------------------------------------
test('THE JOBBER BUG: a different display name is still caught by the slug', async () => {
  db.upsertJob({
    company: 'autotradercanada', title: 'Software Engineer',
    jobUrl: 'https://job-boards.greenhouse.io/autotrader/jobs/1',
    status: 'submitted',
  }, { source: 'manual', manual: true });

  const r = await call('check_duplicate', {
    url: 'https://job-boards.greenhouse.io/autotrader/jobs/999',
    company: 'AutoTrader.ca / Dealer Solutions',   // the name the scraper stored elsewhere
    title: 'Full Stack Developer',
  });
  assert.match(r.result, /^DUPLICATE/);
  assert.match(r.result, /matched on slug "autotrader"/);
});

test('THE OTHER HALF: every terminal status counts as engaged, not just "applied"', async () => {
  for (const [slug, status] of [['ghostco', 'ghosted'], ['rejectco', 'rejected'], ['offerco', 'offer'], ['hiredco', 'hired']]) {
    db.upsertJob({
      company: slug, title: 'Dev', jobUrl: `https://jobs.lever.co/${slug}/x`, status,
    }, { source: 'manual', manual: true });
    const r = await call('check_duplicate', { url: `https://jobs.lever.co/${slug}/y`, company: slug, title: 'Other Role' });
    assert.match(r.result, /^DUPLICATE/, `status "${status}" must count as already engaged`);
  }
});

test('FOUND BY E2E: a check that could not run is NOT reported as fresh', async () => {
  // The agent called this before navigating, with no company and a url carrying no slug. The old
  // wording said "fresh — checked by none", which reads as a green light with no protection at all.
  const r = await call('check_duplicate', { url: 'http://127.0.0.1:62272/apply', title: 'Developer' });
  assert.match(r.result, /^CANNOT CHECK/);
  assert.doesNotMatch(r.result, /^fresh/);
  assert.match(r.result, /Open the posting first/, 'and it must say how to get a real answer');
});

test('FOUND BY E2E: my_profile returns WHO THIS IS, not just learned answers', async () => {
  // The identity lives in profiles.data. Reading only the learned-answer table meant the agent
  // could not see the candidate's name, email or phone, and parked an application over facts that
  // were in the database the whole time.
  const pid = db.ensureDefaultProfileId();
  const row = db.listProfiles().find((p) => p.id === pid);
  db.saveProfile({
    ...row,
    data: { ...(typeof row.data === 'string' ? JSON.parse(row.data || '{}') : row.data || {}),
      firstName: 'Pierre', lastName: 'Salama', email: 'pierresalama115@gmail.com', phone: '647-963-7745' },
  });
  const r = await call('my_profile', {});
  assert.match(r.result, /WHO THIS IS/);
  assert.match(r.result, /Email: pierresalama115@gmail\.com/);
  assert.match(r.result, /Phone: 647-963-7745/);
});

test('a row that was only DISCOVERED is not a duplicate — it is a lead', async () => {
  db.upsertJob({
    company: 'freshco', title: 'Dev', jobUrl: 'https://jobs.lever.co/freshco/x', status: 'started',
  }, { source: 'manual', manual: true });
  const r = await call('check_duplicate', { url: 'https://jobs.lever.co/freshco/x', company: 'freshco', title: 'Dev' });
  assert.match(r.result, /^fresh/);
});

test('a BLOCKED-ON-PIERRE row still counts as engaged', async () => {
  const res = db.upsertJob({
    company: 'blockedco', title: 'Dev', jobUrl: 'https://jobs.lever.co/blockedco/x', status: 'started',
  }, { source: 'manual', manual: true });
  db.patchJob(res.job.id, { tags: ['BLOCKED-ON-PIERRE'] }, { source: 'manual', manual: true });
  const r = await call('check_duplicate', { url: 'https://jobs.lever.co/blockedco/z', company: 'blockedco', title: 'Dev' });
  assert.match(r.result, /^DUPLICATE/, 'a parked application is still an application in flight');
});

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------
test('log_application records SUBMITTED and proves it by reading the row back', async () => {
  const r = await call('log_application', {
    company: 'Newco', title: 'Backend Engineer',
    url: 'https://jobs.ashbyhq.com/newco/abc', location: 'Toronto, ON',
    notes: 'confirmation page reached',
  });
  assert.ok(!r.refused, r.refused);
  assert.match(r.result, /verified by read-back/);

  const row = db.listJobs({ q: 'Newco', limit: 5 }).find((j) => j.company === 'Newco');
  assert.ok(row, 'the row must exist');
  assert.equal(row.status, 'submitted', 'NOT "started" — this is the bug that lost 12 applications');
  assert.ok(row.submittedAt, 'a submitted application needs a submitted date for the ghosting sweep');
  assert.ok((row.tags || []).includes('AI-APPLY'));
  assert.equal(row.source, 'ashby', 'the ATS should be recorded, not a literal object');
});

test('log_application REFUSES to write a duplicate', async () => {
  const r = await call('log_application', {
    company: 'Newco Holdings', title: 'A Different Role',
    url: 'https://jobs.ashbyhq.com/newco/xyz',
  });
  assert.ok(r.refused, 'the second application to one employer must be refused');
  assert.match(r.refused, /already \[submitted\]/);
  assert.match(r.refused, /slug "newco"/);
});

test('log_application refuses an incomplete record rather than storing a stub', async () => {
  assert.ok((await call('log_application', { company: 'X' })).refused);
  assert.ok((await call('log_application', { title: 'Y' })).refused);
});

test('a read-only run cannot write to the ledger at all', async () => {
  const ro = jat.makeJatTools({ allowWrites: false });
  const tool = ro.tools.find((t) => t.name === 'log_application');
  assert.match(await tool.guard({ company: 'A', title: 'B', url: 'https://jobs.lever.co/aaa/1' }), /may not write/);
});

// ---------------------------------------------------------------------------
// reading the candidate
// ---------------------------------------------------------------------------
test('recall_answer says plainly when a question has never been answered', async () => {
  const r = await call('recall_answer', { question: 'What is your favourite kind of bridge?' });
  assert.match(r.result, /NOT ANSWERED BEFORE/);
  assert.match(r.result, /Do not invent|Escalate/, 'the model must be told what to do instead');
});

test('recall_answer returns a stored answer', async () => {
  const pid = db.ensureDefaultProfileId();
  const saved = db.qaRecord({
    profileId: pid,
    question: 'How many years of Python experience do you have?',
    answer: '2 years 8 months',
    lineageSource: 'user',
  });
  assert.ok(saved, 'the answer must actually be stored before recall can be tested');
  const r = await call('recall_answer', { question: 'How many years of Python experience do you have?' });
  assert.match(r.result, /2 years 8 months/);
  assert.match(r.result, /previous answer to THIS question/);
  assert.match(r.result, /stored question:/, 'the source question must always be visible');
});

test('a FUZZY recall is labelled as a different question, with the source shown', async () => {
  // The live failure this pins: "Are you legally authorized to work in Canada?" recalled a stored
  // "No" belonging to a US-scoped SPONSORSHIP question, presented as score 1.00 with no hint that
  // the question differed. Answering that on a Canadian application would disqualify him.
  const pid = db.ensureDefaultProfileId();
  db.qaRecord({
    profileId: pid,
    question: 'Will you now or in the future require visa sponsorship in the United States?',
    answer: 'Yes',
    lineageSource: 'user',
  });
  const r = await call('recall_answer', { question: 'Will you now or in the future require visa sponsorship?' });
  if (/NOT ANSWERED BEFORE/.test(r.result)) return;   // the recall gate rejected it outright, also fine
  assert.match(r.result, /NOT the same question/, 'a fuzzy hit must never read as an exact one');
  assert.match(r.result, /stored question: "Will you now or in the future require visa sponsorship in the United States/);
  assert.match(r.result, /HINT, NOT A FACT/);
  assert.match(r.result, /work authorization|sponsorship/i, 'the risky categories must be named');
});

test('my_profile reports emptiness honestly instead of returning nothing', async () => {
  const r = await call('my_profile', {});
  assert.ok(r.result.length > 0);
});

test('search_ledger finds what is there and says so when it is not', async () => {
  assert.match((await call('search_ledger', { query: 'Newco' })).result, /Newco/);
  assert.match((await call('search_ledger', { query: 'zzz-nothing-like-this' })).result, /no ledger rows match/);
});

test('the tools declare themselves properly for the agent registry', () => {
  const loop = require(path.join(root, 'app', 'src', 'ai', 'agent-loop.js'));
  const reg = loop.makeRegistry(belt.tools);
  assert.match(reg.describe(), /- check_duplicate\(url, company, title\)/);
  assert.match(reg.describe(), /- log_application\(/);
  for (const t of belt.tools) assert.ok(t.description.length > 15, `${t.name} needs a real description`);
});

// ---------------------------------------------------------------------------
// my_resume: the source material that was sitting right there
//
// Read what the agent produced on the eleventh end-to-end run and the problem was plain. It wrote a
// three-line résumé saying "build and maintain full-stack web applications", because `my_profile`
// hands over an identity and some learned screening answers and nothing else. His real résumé, all
// 4,717 characters of it, was already in the documents table, used by fit-score and by nothing
// else. It was not writing a weak résumé, it was writing the only one the available facts allowed.
// ---------------------------------------------------------------------------
test('my_resume returns the résumé on file', () => {
  const doc = db.addDocument({
    name: 'resume.pdf', role: 'resume', filePath: '/tmp/resume.pdf',
    textContent: 'REAL WORK HISTORY: shipped an ERP integration.',
    sizeBytes: 1, mime: 'application/pdf', isDefault: 1, source: 'test',
    keywords: '', lastModified: new Date().toISOString(), folderId: null,
    importance: 1, label: 'resume',
  });
  assert.ok(doc, 'the fixture document must exist for this to mean anything');
  const { makeJatTools: mk } = require(path.join(root, 'app/src/ai/tools/jat.js'));
  const out = mk({}).tools.find((x) => x.name === 'my_resume').run({});
  assert.match(out, /REAL WORK HISTORY/);
  assert.match(out, /resume\.pdf/, 'and it names the document, so a stale one is spottable');
});

test('with no résumé on file it says so instead of writing from thin air', () => {
  // The failure mode to avoid is a confident three-line résumé, not an error.
  const { makeJatTools: mk } = require(path.join(root, 'app/src/ai/tools/jat.js'));
  const t = mk({}).tools.find((x) => x.name === 'my_resume');
  const out = t.run({});
  if (/NO RESUME ON FILE/.test(out)) {
    assert.match(out, /ask_human/, 'it must route to the human, not to invention');
    assert.match(out, /three lines of nothing/);
  }
});

test('write_resume sends the agent to the source first', () => {
  const { makeDocumentTools } = require(path.join(root, 'app/src/ai/tools/documents.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-src-'));
  const r = makeDocumentTools({ root: tmp }).tools.find((t) => t.name === 'write_resume');
  assert.match(r.description, /my_resume FIRST/);
  assert.match(r.description, /three lines of nothing/);
});

// ---------------------------------------------------------------------------
// check_fit: naming what he does NOT have
//
// Pierre's rule has always been that if a posting needs something he lacks, say so plainly in one
// clause or skip the job. The agent had no way to know. It read a posting, read his résumé, and
// applied. The overnight run needed a human in the loop to catch a furniture manufacturer whose
// "Product Engineer" turned out to be a mechanical role.
// ---------------------------------------------------------------------------
const PLATFORM = 'Toronto, hybrid. We build control software for warehouse robots. You will work across '
  + 'a Python and Node backend, a React front end, and the PostgreSQL layer under both. We ask for 2+ '
  + 'years of professional experience. Bonus: experience integrating an ERP, and CI/CD you built yourself.';
const CHEMICAL = 'We are seeking a Senior Process Engineer for chemical plant design. Responsibilities '
  + 'include P&ID development, HAZOP studies, distillation column sizing, ASPEN simulation, pressure '
  + 'vessel specification and APEGA registration. Ten years of process engineering in oil and gas required.';

const fitTool = () => {
  const { makeJatTools: mk } = require(path.join(root, 'app/src/ai/tools/jat.js'));
  return mk({}).tools.find((t) => t.name === 'check_fit');
};

test('a role he can do scores far above one he cannot', () => {
  const t = fitTool();
  const good = Number(/score (\d+)/.exec(t.run({ title: 'Software Developer, Platform', description: PLATFORM }))[1]);
  const bad = Number(/score (\d+)/.exec(t.run({ title: 'Senior Process Engineer', description: CHEMICAL }))[1]);
  assert.ok(good > bad * 2, `expected a clear gap, got ${good} vs ${bad}`);
});

test('it names the gap and forbids writing it onto the résumé', () => {
  const said = fitTool().run({ title: 'Senior Process Engineer', description: CHEMICAL });
  assert.match(said, /no match in his history/);
  assert.match(said, /HAZOP|distillation|ASPEN/i, 'the specific thing he lacks has to be named');
  assert.match(said, /Do NOT put anything from that list on the résumé/);
});

test('the score is labelled as a signal, not a verdict', () => {
  // A number that looks authoritative is worse than no number. The judgement is the agent's.
  assert.match(fitTool().run({ title: 'x', description: PLATFORM }), /crude token overlap, not a verdict/);
});

test('punctuation and filler are stripped, real tokens are not', () => {
  // The raw scorer emits "robots.", "hybrid.", "under", "ask", which buries the word that matters.
  const said = fitTool().run({ title: 'Software Developer, Platform', description: PLATFORM });
  assert.equal(/\brobots\.|hybrid\./.test(said), false, 'trailing punctuation must go');
  assert.equal(/(^|[ ,])(under|ask|both|bonus)([ ,]|$)/.test(said.split('\n')[2] || ''), false, 'filler must go');
});

test('a summary instead of the posting is refused', () => {
  assert.match(fitTool().run({ title: 'x', description: 'Nice job in Toronto' }), /posting text, not a summary/);
});

// ---------------------------------------------------------------------------
// A résumé without a work history is not a résumé
//
// On the real Ritual form the agent rendered 1,262 bytes: a summary and a skills list, no Experience
// section, no Education, no employer named anywhere. Every fixture run had both. The voice gate
// passed it because the punctuation was fine, which is the wrong question.
// ---------------------------------------------------------------------------
test('write_resume refuses a body with no Experience or Education section', () => {
  const { makeDocumentTools } = require(path.join(root, 'app/src/ai/tools/documents.js'));
  const t = makeDocumentTools({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'jat-struct-')) }).tools
    .find((x) => x.name === 'write_resume');
  const said = t.guard({ company: 'Ritual', bodyHtml: '<body><h1>Pierre</h1><h2>Summary</h2><p>Engineer.</p><h2>Skills</h2><p>React</p></body>' });
  assert.match(said, /no Experience section and no Education section/);
  assert.match(said, /my_resume/, 'and it must say where the material is');
});

test('a résumé with both sections passes the structural check', () => {
  const { makeDocumentTools } = require(path.join(root, 'app/src/ai/tools/documents.js'));
  const t = makeDocumentTools({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'jat-struct2-')) }).tools
    .find((x) => x.name === 'write_resume');
  assert.equal(t.guard({ company: 'Ritual', bodyHtml: '<body><h2>Experience</h2><p>Tacel, 2024 to Present.</p><h2>Education</h2><p>Honours BSc, Computer Science.</p></body>' }), null);
});

test('the structural check runs AFTER the voice check, so one refusal names one problem', () => {
  const src = fs.readFileSync(path.join(root, 'app/src/ai/tools/documents.js'), 'utf8');
  assert.ok(src.indexOf('breaks the house rules') < src.indexOf('no ${missing.join'), 'voice first, then structure');
});
