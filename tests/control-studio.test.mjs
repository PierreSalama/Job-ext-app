import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

test('Control Studio renders complete controls and gates submit/recovery decisions', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.com/jobs/1' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  const { createSupervisor } = await import('../extension/content/supervise.js');
  const changes = [];
  const supervisor = createSupervisor({ onSettings: (value) => changes.push(value) });
  supervisor.show();

  const panel = document.querySelector('#jat11-teach');
  assert.ok(panel, 'unified panel is rendered');
  const labels = [...panel.querySelectorAll('button')].map((button) => button.textContent);
  for (const expected of ['Pause', 'Next / Approve', 'Wrong / Fix this', 'Apply this job', 'Retry step', 'Skip job', 'Skip + next', 'Stop session']) {
    assert.ok(labels.includes(expected), `control is present: ${expected}`);
  }
  assert.match(panel.textContent, /Robot sees/);
  assert.match(panel.textContent, /Session tuning/);

  const submit = supervisor.beforeSubmit({ text: 'Final submit ready' });
  [...panel.querySelectorAll('button')].find((button) => button.textContent === 'Apply this job').click();
  assert.equal(await submit, 'apply', 'final submit waits for its dedicated command');

  const recovery = supervisor.recoveryDecision({ reason: 'stalled x3' });
  [...panel.querySelectorAll('button')].find((button) => button.textContent === 'Retry step').click();
  assert.equal(await recovery, 'retry', 'stalled flows wait for a recovery command');

  const confidence = panel.querySelector('input[step="0.05"]');
  confidence.value = '0.9';
  confidence.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(changes.at(-1).confidence, 0.9, 'session tuning is emitted live');

  supervisor.destroy();
  dom.window.close();
  delete globalThis.window;
  delete globalThis.document;
});
