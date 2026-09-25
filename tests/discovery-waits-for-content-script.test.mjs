// Indeed discovery gave up with "could not reach the search page (content script not ready?)".
// It must go through sendTaskWhenReady (inject + retry), never a bare one-shot sendMessage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
test('discover-search is sent with inject-and-retry', () => {
  assert.match(src, /sendTaskWhenReady\(tab\.id, \{ type: 'jat11\.discover-search'/);
  assert.doesNotMatch(src, /chrome\.tabs\.sendMessage\(tab\.id, \{ type: 'jat11\.discover-search'/);
});
