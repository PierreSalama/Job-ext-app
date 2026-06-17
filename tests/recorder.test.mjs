// T2 (Teach & Correct) — the full-fidelity Recorder. Two halves:
//   1. buildLocator() is PURE + node-importable: it builds the locator bundle (CSS
//      selector, XPath, attribute signature, label, trimmed HTML) from a duck-typed
//      element. An element WITH an id → `#id` + id-anchored xpath; WITHOUT an id →
//      a tag/nth selector + an absolute xpath.
//   2. The SERVER mapping logic at the db level: a buildLocator() bundle round-trips
//      through db.recordDemonstration (T1's verified path) into a demonstration row,
//      and the credential rail still nulls value/html for a sensitive label.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildLocator } from '../extension/content/recorder.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));

// ---- tiny duck-typed DOM (no jsdom dependency) ----
// mk(tag, attrs, kids) builds an element that quacks like the bits buildLocator touches:
// nodeType, tagName, attributes[], getAttribute, parentNode, children, outerHTML.
function mk(tag, attrs = {}, kids = []) {
  const el = {
    nodeType: 1,
    tagName: tag,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    children: [],
    parentNode: null,
    type: attrs.type,
    getAttribute(n) { const a = this.attributes.find((x) => x.name === n); return a ? a.value : null; },
    get className() { return attrs.class || ''; },
    get outerHTML() { return `<${tag.toLowerCase()}${attrs.id ? ` id="${attrs.id}"` : ''}>`; },
  };
  for (const k of kids) { k.parentNode = el; el.children.push(k); }
  return el;
}

test('buildLocator: element WITH an id → #id selector + id-anchored xpath + attrs incl. id + label', () => {
  const input = mk('INPUT', { id: 'yoe', name: 'yoe', type: 'number', 'data-automation-id': 'years' });
  const b = buildLocator(input, () => 'Years of experience');
  assert.equal(b.selector, '#yoe', 'prefers #id');
  assert.equal(b.xpath, '//*[@id="yoe"]', 'id-anchored xpath');
  assert.equal(b.attrs.id, 'yoe', 'attribute signature includes the id');
  assert.equal(b.attrs.name, 'yoe');
  assert.equal(b.attrs['data-automation-id'], 'years', 'captures data-* ATS hooks');
  assert.equal(b.label, 'Years of experience', 'label from the injected labeller');
  assert.ok(b.html.includes('yoe'), 'trimmed outerHTML snippet');
});

test('buildLocator: element WITHOUT an id → tag/nth selector + absolute xpath', () => {
  const input = mk('INPUT', { class: 'form-control' });
  const field = mk('DIV', { class: 'field' }, [mk('LABEL', {}), input]);
  mk('FORM', {}, [field]);                          // root, sets parent chain
  const b = buildLocator(input);
  assert.match(b.selector, /input.*:nth-of-type\(1\)$/, 'tag + nth selector');
  assert.ok(b.selector.includes('form-control'), 'keeps a stable class');
  assert.equal(b.xpath, '/form[1]/div[1]/input[1]', 'absolute indexed xpath');
  assert.ok(!b.attrs.id, 'no id in the signature');
});

test('buildLocator never throws on a junk element', () => {
  assert.doesNotThrow(() => buildLocator(null));
  assert.doesNotThrow(() => buildLocator({}));
  const b = buildLocator(undefined);
  assert.equal(b.selector, '');
});

// ---- server mapping: buildLocator bundle → db.recordDemonstration round-trip ----
let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-rec-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('a buildLocator bundle round-trips into a demonstration row (the /observe step path)', () => {
  const pid = db.ensureDefaultProfileId();
  const input = mk('INPUT', { id: 'yoe', name: 'yoe', type: 'number' });
  const b = buildLocator(input, () => 'Years of experience with Java');
  // Mirror what /observe (kind:'step') does: classifyAts(url) → ats/companyKey, then record.
  const cls = db.classifyAts('https://boards.greenhouse.io/acme/jobs/123');
  const demo = db.recordDemonstration({
    profileId: pid, sessionId: 's1', stepIndex: 0, action: 'fill',
    ats: cls.ats, companyKey: cls.companyKey,
    label: b.label, fieldType: 'number',
    selector: b.selector, xpath: b.xpath, attrs: b.attrs, html: b.html, value: '4',
    delayMs: 900, source: 'teach',
  });
  assert.equal(demo.ats, 'greenhouse', 'classifyAts mapped the url');
  assert.equal(demo.company_key, 'acme');
  assert.equal(demo.selector, '#yoe', 'CSS selector persisted');
  assert.equal(demo.xpath, '//*[@id="yoe"]', 'XPath persisted');
  assert.ok(String(demo.attrs).includes('yoe'), 'attribute signature persisted');
  assert.equal(demo.value, '4');
  assert.equal(demo.source, 'teach');
});

test('the credential rail still nulls value/html on a sensitive label', () => {
  const pid = db.ensureDefaultProfileId();
  const input = mk('INPUT', { id: 'pw', type: 'password' });
  const b = buildLocator(input, () => 'Password');
  const demo = db.recordDemonstration({
    profileId: pid, action: 'fill', label: b.label,
    selector: b.selector, xpath: b.xpath, attrs: b.attrs, html: '<input type=password value=secret>', value: 'secret',
    source: 'teach',
  });
  assert.equal(demo.selector, '#pw', 'we still know WHERE the field is');
  assert.equal(demo.value, null, 'credential value never stored');
  assert.equal(demo.html, null, 'credential html never stored');
});
