// The résumé styling has to exist on the machine that does the applying.
//
// Twelve green end-to-end runs, then the first real application from the server laptop spent
// thirteen steps and 134,000 characters and gave up with ENOENT on `resume-2026.html`. The template
// was one absolute path on Pierre's PC, `F:/GITHUB/Perosnal/portfolio-site/resume/...`, and the
// laptop has no such drive. Every one of those green runs had executed here, where the file happens
// to sit, which is exactly why none of them caught it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const docs = require(path.join(root, 'app/src/ai/tools/documents.js'));

test('the styling ships inside the app', () => {
  assert.equal(fs.existsSync(docs.BUNDLED_TEMPLATE), true, 'no bundled template means no résumé on any other machine');
  assert.match(docs.BUNDLED_TEMPLATE.split('\\').join('/'), /app\/src\/ai\/resume-template\.html$/);
});

test('the installer actually packages it', () => {
  // `src/**/*` is what carries it. If that ever narrows, this breaks on the laptop and nowhere else.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'app/package.json'), 'utf8'));
  const files = (pkg.build && pkg.build.files) || [];
  assert.ok(files.some((f) => /^src\/\*\*/.test(String(f))), 'src/** must be in the packaged files');
});

test('the bundled head is a real document head', () => {
  const head = docs.resumeHead(docs.BUNDLED_TEMPLATE);
  assert.match(head, /<!doctype html>/i);
  assert.match(head, /<style/i, 'the whole point of the template is the styling');
  assert.equal(/<body/i.test(head), false, 'the head stops before the body the agent supplies');
});

test('a missing template falls back instead of failing the application', () => {
  // A plain résumé beats no résumé. The run that found this threw away everything it had done.
  const gone = path.join(os.tmpdir(), 'definitely-not-here-resume.html');
  assert.equal(fs.existsSync(gone), false);
  const head = docs.resumeHead(gone);
  assert.match(head, /<!doctype html>/i);
});

test('the bundled template failing is still an error, not a silent empty page', () => {
  // The fallback has to bottom out somewhere, or a broken install renders blank PDFs forever.
  const src = fs.readFileSync(path.join(root, 'app/src/ai/tools/documents.js'), 'utf8');
  assert.match(src, /if \(templatePath !== BUNDLED_TEMPLATE\)/);
  assert.match(src, /throw e;/);
});

test('the authored copy still wins where it exists', () => {
  // Editing the real résumé in the portfolio repo must keep changing what the agent produces here.
  const src = fs.readFileSync(path.join(root, 'app/src/ai/tools/documents.js'), 'utf8');
  assert.match(src, /existsSync\(AUTHORED_TEMPLATE\)/);
});
