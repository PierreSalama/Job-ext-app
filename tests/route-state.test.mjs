import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.location = { href: 'https://www.linkedin.com/jobs/view/123' };
const route = await import('../extension/content/route.js');

function el({ text = '', aria = '', href = '', target = '' } = {}) {
  const attrs = { 'aria-label': aria, href, target };
  return {
    textContent: text, value: '', href,
    getAttribute(name) { return attrs[name] || ''; },
  };
}

test('LinkedIn Easy Apply is never classified as external handoff', () => {
  const r = route.classifyApplyControl(el({ text: 'Apply', aria: 'Easy Apply to this job' }));
  assert.equal(r.state, 'linkedin_easy_apply_modal');
  assert.equal(route.applyRouteForState(r.state), 'easy-apply');
});

test('external routes require explicit off-origin or company-site evidence', () => {
  assert.equal(route.classifyApplyControl(el({ text: 'Apply' })).state, 'unknown');
  assert.equal(route.classifyApplyControl(el({ text: 'Company homepage', href: 'https://acme.com' })).state, 'unknown');
  assert.equal(route.classifyApplyControl(el({ text: 'Apply', href: 'https://jobs.acme.com/42', target: '_blank' })).state, 'external_new_tab');
  assert.equal(route.classifyApplyControl(el({ text: 'Apply on company website' })).state, 'external_same_tab');
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
