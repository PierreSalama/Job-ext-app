// An ATS confirmation names the employer in the body, not in the subject or the sender.
//
// The email search looked at subject, from_addr and from_name. On 2026-09-04 eleven companies had
// an application recorded as "submit was clicked but could not be verified", and searching for them
// returned nothing at all for ten. That read as evidence the applications never landed. It was
// evidence of nothing: a Greenhouse confirmation arrives from no-reply@greenhouse-mail.io and an
// Ashby one from no-reply@ashbyhq.com, and the company can appear nowhere but the body.
//
// Searching the body found a Vanta confirmation the old search could not see.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const db = require(path.join(root, 'app/src/db.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-mailsearch-'));
db.open(dir);
process.on('exit', () => {
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
});

const store = (e) => db.emailUpsert({
  accountId: 'gmail', provider: 'gmail', uid: e.uid, messageId: `<${e.uid}@test>`, threadId: e.uid,
  from: e.from, fromName: e.fromName || '', to: 'pierresalama115@gmail.com',
  subject: e.subject, snippet: e.snippet || '', body: e.body || '', sentAt: new Date().toISOString(),
  category: e.category || 'application_confirmation',
});

test('an employer named ONLY in the body is found', () => {
  store({
    uid: 'a1', from: 'no-reply@ashbyhq.com', fromName: 'Ashby',
    subject: 'Thanks for applying',
    body: 'Thank you for your interest in Vanta. We have received your application.',
  });
  const hits = db.listEmails({ q: 'Vanta' });
  assert.equal(hits.length, 1, 'the subject and sender say nothing about the employer');
  assert.equal(hits[0].category, 'application_confirmation');
});

test('the snippet counts too, for a body that was never stored in full', () => {
  store({ uid: 'a2', from: 'no-reply@greenhouse-mail.io', subject: 'Application received', snippet: 'your application to Harvey' });
  assert.equal(db.listEmails({ q: 'Harvey' }).length, 1);
});

test('subject and sender still work', () => {
  // Widening a search is only safe if it is strictly additive.
  store({ uid: 'a3', from: 'jobs@maintainx.com', fromName: 'MaintainX', subject: 'Your application to MaintainX' });
  assert.equal(db.listEmails({ q: 'MaintainX' }).length, 1);
  assert.equal(db.listEmails({ q: 'maintainx.com' }).length, 1);
});

test('a company with no mail at all still returns nothing', () => {
  // The point of the fix is that silence becomes meaningful. If everything matched everything,
  // an absent confirmation would stop being evidence.
  assert.deepEqual(db.listEmails({ q: 'Nowhere Incorporated' }), []);
});
