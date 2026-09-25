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

// The three tests above assert the SOURCE of documents.js. None of them reads a byte of a template,
// so none would notice the head coming out empty, coming from the wrong file, or swallowing a whole
// document. What ships to an employer is the actual bytes, so assert those.

test('BEHAVIOUR: a missing template falls back to the BUNDLED one specifically, not to nothing', () => {
  const gone = path.join(os.tmpdir(), 'definitely-not-here-resume-' + process.pid + '.html');
  assert.equal(fs.existsSync(gone), false, 'precondition');
  const head = docs.resumeHead(gone);
  assert.ok(head.length > 0, 'an empty head is the blank-PDF failure this fallback exists to prevent');
  assert.equal(head, docs.resumeHead(docs.BUNDLED_TEMPLATE),
    'the fallback must land on the bundled template, byte for byte');
});

test('BEHAVIOUR: the bytes returned really are the template file, up to <body>', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-tpl-'));
  const f = path.join(tmp, 'custom.html');
  const marker = 'jat-marker-' + process.pid;
  fs.writeFileSync(f, `<!doctype html><html><head><style>.${marker}{color:red}</style></head><body>DROP ME</body></html>`, 'utf8');
  try {
    const head = docs.resumeHead(f);
    assert.ok(head.includes(marker), 'the caller must get THIS file, not a cached or bundled one');
    assert.ok(!head.includes('DROP ME'), 'everything from <body> on must be cut');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BEHAVIOUR: a template with no <body> is an error, not the whole document as a head', () => {
  // Silently returning the entire file would inline a second document into the résumé's head and
  // produce something that renders as garbage rather than failing where anyone would look.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-tpl-nobody-'));
  const f = path.join(tmp, 'nobody.html');
  fs.writeFileSync(f, '<!doctype html><html><head><title>no body here</title></head></html>', 'utf8');
  try {
    assert.throws(() => docs.resumeHead(f), /no <body>/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
