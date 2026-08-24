// THE RÉSUMÉ UPLOAD MUST ATTACH A RÉSUMÉ, AND FAIL LOUDLY WHEN IT CANNOT.
//
// The reported symptom was a queue row reading:
//     "Resume Uploading... fileuploaded.jpg Upload failed. Max size for files is 10 MB."
//
// IMPORTANT, AND CONTRARY TO THE AUDIT: that string is the upload widget's OWN on-screen chatter
// scraped as a question label. 'fileuploaded.jpg' is the SITE's placeholder text, not a file JAT
// selected — the executor already carries an UPLOAD_CHATTER_RX guard written for exactly this
// row. So it is not evidence that an image was ever attached to an application.
//
// What IS true is that nothing stopped it: tryAttachResume() sent whatever bytes the default
// 'resume' document held, under whatever name, mime and size, with no validation at all. This
// covers both halves — the label is never asked as a question (junk-questions test), and the
// attach path now refuses anything that is not a résumé document and says so out loud.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let af;
test.before(async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.com/' });
  for (const k of ['window', 'document', 'Element', 'Node', 'HTMLElement', 'NodeFilter', 'getComputedStyle']) globalThis[k] = dom.window[k];
  globalThis.CSS = dom.window.CSS || { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
  af = await import(pathToFileURL(path.join(here, '..', 'extension', 'content', 'autofill.js')).href);
});

test('an IMAGE is refused as a résumé — by extension and by mime', () => {
  for (const f of [
    { name: 'fileuploaded.jpg', mime: 'image/jpeg' },
    { name: 'headshot.png', mime: 'image/png' },
    { name: 'scan.heic', mime: '' },
    { name: 'resume', mime: 'image/jpeg' },          // no extension, image mime
  ]) {
    const why = af.resumeUploadRefusal({ ...f, bytes: 1000 });
    assert.ok(why, `must refuse ${f.name} (${f.mime})`);
    assert.match(why, /not a r[ée]sum[ée] document|image|unusable/i);
  }
});

test('a real résumé document is accepted', () => {
  for (const f of [
    { name: 'Pierre Salama - Resume.pdf', mime: 'application/pdf' },
    { name: 'resume.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { name: 'cv.doc', mime: 'application/msword' },
    { name: 'resume.txt', mime: 'text/plain' },
  ]) {
    assert.equal(af.resumeUploadRefusal({ ...f, bytes: 250 * 1024 }), null, `must accept ${f.name}`);
  }
});

test('an oversized file is refused BEFORE the ATS rejects it', () => {
  const why = af.resumeUploadRefusal({ name: 'resume.pdf', mime: 'application/pdf', bytes: 12 * 1024 * 1024 });
  assert.ok(why, 'a 12 MB résumé must be refused');
  assert.match(why, /10 MB/);
  // exactly at the limit is fine
  assert.equal(af.resumeUploadRefusal({ name: 'resume.pdf', mime: 'application/pdf', bytes: af.MAX_RESUME_UPLOAD_BYTES }), null);
});

test('a non-document, non-image type (zip, exe) is refused too', () => {
  assert.ok(af.resumeUploadRefusal({ name: 'portfolio.zip', mime: 'application/zip', bytes: 1000 }));
  assert.ok(af.resumeUploadRefusal({ name: 'setup.exe', mime: 'application/octet-stream', bytes: 1000 }));
});

test('the executor consults the guard and refuses rather than proceeding', () => {
  // executor.js cannot be imported under node (it is a browser content-script entry), so the
  // wiring is asserted on its source — the guard itself is behaviourally tested above.
  const src = fs.readFileSync(path.join(here, '..', 'extension', 'content', 'executor.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function tryAttachResume'), src.indexOf('// ---- RESUME PAGE'));
  assert.ok(fn.length, 'tryAttachResume must exist');
  assert.match(fn, /resumeUploadRefusal\(/, 'the attach path must consult the guard');
  // it must refuse BEFORE constructing/attaching the File
  assert.ok(fn.indexOf('resumeUploadRefusal(') < fn.indexOf('new File('),
    'the guard must run before the file is built');
  assert.match(fn, /logLine\('err'/, 'a refusal must be logged loudly, not swallowed');
  assert.match(fn, /attached:\s*0/, 'a refusal must report attached=0 so the caller parks');
  assert.match(src, /import \{[^}]*resumeUploadRefusal/s, 'the guard must be imported, not redefined');
});

test('the upload widget chatter is never asked as a question', () => {
  assert.equal(af.isJunkQuestionText('Resume Uploading... fileuploaded.jpg Upload failed. Max size for files is 10 MB.'), false,
    'this specific string is handled by the executor\'s UPLOAD_CHATTER_RX, not the generic junk filter');
  // …but the generic filter still catches the widget\'s bare placeholder forms
  assert.equal(af.isJunkQuestionText('Uploading...'), true);
});
