// A saved "how did you hear about us" answer must satisfy the same question on any company's form.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const shape = createRequire(import.meta.url)(path.join(here, '..', 'app', 'src', 'answer-shape.js'));

test('heard-about answers travel across companies', () => {
  assert.equal(shape.brandConflict('How did you hear about Stripe?', 'How did you hear about us?'), false);
  assert.equal(shape.brandConflict('How did you hear about Stripe? *', 'how did you hear about us'), false);
  assert.equal(shape.recallAllowed('How did you hear about Stripe?', 'How did you hear about us?', 'LinkedIn'), true);
});
test('employment-relationship questions are still brand gated', () => {
  assert.equal(shape.brandConflict('Do you work for a reseller of Stripe?', 'Do you work for a reseller of Geotab?'), true);
  assert.equal(shape.recallAllowed('Have you previously worked at Stripe?', 'Have you previously worked at Geotab?', 'No'), false);
});
test('a company-named heard-about memory is still that company\'s', () => {
  assert.equal(shape.brandConflict('How did you hear about 1Password?', 'how did you hear about geotab?'), true);
  assert.equal(shape.brandConflict('How did you hear about 1Password?', 'How did you hear about Geotab?'), true);
});
