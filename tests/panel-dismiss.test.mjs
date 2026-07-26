// Dismiss must STICK. Pierre: "whenever I try to dismiss it, it won't go away, and it
// keeps popping back up." Cause: the panel's onDismiss was a no-op, so the node was
// removed but nothing was recorded — and EVERY persist / mutation / step-advance calls
// paintPanel(), which rebuilt it immediately.
//
// This lives in its OWN FILE on purpose: the detector installs document-level listeners
// and timers against module-scope globals, so two of these jsdom scenarios in one file
// contaminate each other (a previous instance's retry fires against the new document and
// tears the panel down). node --test gives each FILE a fresh process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const detectorUrl = pathToFileURL(path.join(here, '..', 'extension', 'content', 'detector.js')).href;
const PANEL = '#jat11-panel';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const sent = [];
const storage = {
  'jat11.handoff': {
    'linkedin|999': {
      ctx: { title: 'Field Technician', company: 'Acme', location: '', description: '', compensation: '', workMode: '', employmentType: '', jobUrl: 'https://www.linkedin.com/jobs/view/999' },
      source: 'linkedin', externalId: '999', ts: Date.now(), url: 'https://www.linkedin.com/jobs/view/999',
    },
  },
};

globalThis.chrome = {
  runtime: {
    id: 'test', lastError: null,
    getManifest: () => ({ version: '11.0.1' }),
    getURL: (p) => p,
    sendMessage: (msg, cb) => {
      if (msg?.type === 'pipeline-event') { sent.push(msg.data); cb && cb({ ok: true, jobId: 'job_1', action: 'created' }); return; }
      if (msg?.type === 'api-call') { cb && cb({ ok: false }); return; }
      cb && cb({ ok: true });
    },
  },
  storage: {
    local: {
      get: (key) => {
        const out = {};
        if (typeof key === 'string') out[key] = storage[key];
        else if (Array.isArray(key)) key.forEach((k) => { out[k] = storage[k]; });
        else if (key && typeof key === 'object') Object.keys(key).forEach((k) => { out[k] = storage[k] ?? key[k]; });
        return Promise.resolve(out);
      },
      set: (obj) => { Object.assign(storage, obj); return Promise.resolve(); },
    },
    onChanged: { addListener: () => {} },
  },
};

const WORKDAY_APPLY = `
<div data-automation-id="applyFlowPage">
  <h2 data-automation-id="applyFlowPageHeader">My Information</h2>
  <label for="src">How Did You Hear About Us?*</label>
  <select id="src" required><option>Select One</option></select>
  <label for="country">Country*</label><select id="country" required><option>Canada</option></select>
  <label for="fn">First Name*</label><input id="fn" data-automation-id="legalNameSection_firstName" required value="Pierre" />
  <label for="ln">Last Name*</label><input id="ln" required value="Salama" />
  <button type="button" data-automation-id="bottom-navigation-next-button">Next</button>
</div>`;

function mount(html, url) {
  const dom = new JSDOM(`<!doctype html><html><head><title>Apply</title></head><body>${html}</body></html>`, { url, pretendToBeVisual: true });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = function () { return { width: 120, height: 22, top: 10, left: 10, right: 130, bottom: 32, x: 10, y: 10 }; };
  Object.defineProperty(w.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 120; } });
  Object.defineProperty(w.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 22; } });
  for (const k of ['window', 'document', 'location', 'Element', 'Node', 'HTMLElement', 'HTMLInputElement', 'NodeFilter', 'getComputedStyle', 'MutationObserver', 'sessionStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'CustomEvent', 'Event', 'MouseEvent']) {
    if (w[k] !== undefined) globalThis[k] = w[k];
  }
  globalThis.CSS = w.CSS || { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
  return w;
}

test('dismissing the panel keeps it closed through later progress, step-advance and mutations', async () => {
  const w = mount(WORKDAY_APPLY, 'https://co.wd3.myworkdayjobs.com/en-US/x/job/Toronto/Field-Tech_R1/apply/applyManually');
  const mod = await import(detectorUrl);
  mod.init();
  await wait(400);

  const panel = w.document.querySelector(PANEL);
  assert.ok(panel, 'panel should be visible once the apply flow started');
  const dismissBtn = panel.querySelector('[data-act="dismiss"]');
  assert.ok(dismissBtn, 'panel should have a Dismiss button');

  dismissBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(350);   // dismissPanel removes the node after a 240ms fade
  assert.equal(w.document.querySelector(PANEL), null, 'panel should be gone right after Dismiss');

  // Everything that calls paintPanel(): field edit, change event, step advance, DOM mutation.
  const fn = w.document.querySelector('#fn');
  fn.value = 'Changed';
  fn.dispatchEvent(new w.Event('input', { bubbles: true }));
  fn.dispatchEvent(new w.Event('change', { bubbles: true }));
  w.document.querySelector('[data-automation-id="bottom-navigation-next-button"]')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  w.document.body.appendChild(w.document.createElement('div'));   // mutation observer tick
  await wait(1000);   // covers the 500ms delayed step-advance re-paint

  assert.equal(w.document.querySelector(PANEL), null,
    'panel must STAY dismissed — it reappeared after form progress / step advance');

  // Capture itself must NOT stop: dismiss is a display action, tracking continues.
  assert.ok(sent.length >= 1, 'capture should still be running after a dismiss');

  try { w.dispatchEvent(new w.Event('pagehide')); } catch {}
});
