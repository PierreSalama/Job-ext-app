// Deterministic résumé extraction — contacts + links. Tested against a real
// résumé header (the part deterministic extraction targets) so a regression in
// link/contact pulling is caught.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { deterministicResumeFields } = require(path.join(here, '..', 'app', 'src', 'resumefields.js'));

const REAL_HEADER = `Pierre Salama
(647)-963-7745, Toronto ON • pierresalama115@gmail.com • https://www.linkedin.com/in/pierre-salama • https://github.com/PierreSalama
SKILLS: Python, JavaScript, React, Node`;

test('pulls contacts + links from a real résumé header', () => {
  const f = deterministicResumeFields(REAL_HEADER);
  assert.equal(f.email, 'pierresalama115@gmail.com');
  assert.ok(/647.*963.*7745/.test(f.phone || ''), 'phone: ' + f.phone);
  assert.ok(/linkedin\.com\/in\/pierre-salama/i.test(f.linkedinUrl || ''), 'linkedin: ' + f.linkedinUrl);
  assert.ok(/github\.com\/PierreSalama/i.test(f.githubUrl || ''), 'github: ' + f.githubUrl);
});

test('github/linkedin links are NOT mistaken for a portfolio', () => {
  const f = deterministicResumeFields('see https://www.linkedin.com/in/x and https://github.com/y');
  assert.equal(f.portfolioUrl, undefined);
});

test('a real portfolio URL is captured', () => {
  const f = deterministicResumeFields('Portfolio: https://pierre.dev/work');
  assert.ok(/pierre\.dev/.test(f.portfolioUrl || ''), 'portfolio: ' + f.portfolioUrl);
});
