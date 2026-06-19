import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const dom = new JSDOM('<!doctype html>', { url: 'https://www.linkedin.com/jobs/view/123' });
globalThis.location = dom.window.location;
const route = await import('../extension/content/route.js');

function el(html) {
  const d = new JSDOM(html, { url: 'https://www.linkedin.com/jobs/view/123' });
  return d.window.document.body.firstElementChild;
}

test('LinkedIn Easy Apply is never classified as external handoff', () => {
  const r = route.classifyApplyControl(el('<button class="jobs-apply-button" aria-label="Easy Apply to this job">Apply</button>'));
  assert.equal(r.state, 'linkedin_easy_apply_modal');
  assert.equal(route.applyRouteForState(r.state), 'easy-apply');
});

test('external routes require explicit off-origin or company-site evidence', () => {
  assert.equal(route.classifyApplyControl(el('<button>Apply</button>')).state, 'unknown');
  assert.equal(route.classifyApplyControl(el('<a href="https://acme.com">Company homepage</a>')).state, 'unknown');
  assert.equal(route.classifyApplyControl(el('<a href="https://jobs.acme.com/42" target="_blank">Apply</a>')).state, 'external_new_tab');
  assert.equal(route.classifyApplyControl(el('<button>Apply on company website</button>')).state, 'external_same_tab');
});

test('observed transitions distinguish modal, child tab, and same-tab navigation', () => {
  assert.equal(route.observeRoute({ dialogOpen: true }).state, 'linkedin_easy_apply_modal');
  assert.equal(route.observeRoute({ childCaptured: true }).state, 'external_new_tab');
  assert.equal(route.observeRoute({ beforeUrl: 'https://linkedin.com/jobs/1', afterUrl: 'https://jobs.acme.com/apply' }).state, 'external_same_tab');
});

test('service worker owns same-tab external navigation before the source executor unloads', () => {
  const src = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(src, /waitForExternalTarget/);
  assert.match(src, /beforeHost\s*!==\s*afterHost/);
  assert.match(src, /same-tab external handoff/i);
});

test('login URLs can never count as submission confirmation', async () => {
  const success = await import('../extension/content/signals/success.js');
  assert.equal(success.urlLooksLikeSuccess('https://careers.example.com/applied?stepname=login'), false);
  assert.equal(success.urlLooksLikeSuccess('https://careers.example.com/application/thank-you'), true);
});
