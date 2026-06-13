// Integration test: the REAL detector engine end-to-end in jsdom, with the
// extension runtime mocked. Proves the external-ATS capture flow actually fires
// a pipeline event (creates an entry) on arrival — the thing that was failing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const detectorUrl = pathToFileURL(path.join(here, '..', 'extension', 'content', 'detector.js')).href;

const sent = [];          // pipeline events the engine sends
const storage = {};       // chrome.storage.local backing

function setupChrome(handoff) {
  if (handoff) {
    storage['jat11.handoff'] = {
      [`${handoff.source}|${handoff.externalId}`]: {
        ctx: { title: handoff.title, company: handoff.company, location: '', description: '', compensation: '', workMode: '', employmentType: '', jobUrl: handoff.url },
        source: handoff.source, externalId: handoff.externalId, ts: Date.now(), url: handoff.url,
      },
    };
  }
  globalThis.chrome = {
    runtime: {
      id: 'test', lastError: null,
      getManifest: () => ({ version: '11.0.1' }),
      getURL: (p) => p,
      sendMessage: (msg, cb) => {
        if (msg?.type === 'pipeline-event') { sent.push(msg.data); cb && cb({ ok: true, jobId: 'job_1', action: 'created', statusChanged: true }); return; }
        if (msg?.type === 'api-call') { cb && cb({ ok: false }); return; }   // settings → defaults
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
    },
  };
}

function mount(html, url) {
  const dom = new JSDOM(`<!doctype html><html><head><title>Jonas Fall Internship - Various Departments</title></head><body>${html}</body></html>`, { url, pretendToBeVisual: true });
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('external-ATS (Workday) apply page creates an entry on arrival, via the board handoff', async () => {
  sent.length = 0;
  for (const k of Object.keys(storage)) delete storage[k];
  setupChrome({ source: 'linkedin', externalId: '4402649811', title: 'Jonas Fall Internship - Various Departments', company: 'Jonas Software', url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=4402649811' });
  mount(WORKDAY_APPLY, 'https://talentmanagementsolution.wd3.myworkdayjobs.com/en-US/Jonas/job/Toronto/Jonas-Fall-Internship_R45877-2/apply/applyManually?source=LinkedIn');

  const mod = await import(detectorUrl + '?t=' + Date.now().toString(36));
  mod.init();
  await wait(300);

  assert.ok(sent.length >= 1, 'no pipeline event was sent — the apply page was not captured');
  const ev = sent[0];
  assert.ok(['started', 'progressing'].includes(ev.stage), `expected started/progressing, got ${ev.stage}`);
  // Identity must come from the board handoff, not the Workday vendor host.
  assert.equal(ev.job.company, 'Jonas Software', `company should be the employer, got "${ev.job.company}"`);
  assert.match(ev.job.title, /Jonas Fall Internship/, `title should be the job, got "${ev.job.title}"`);
  assert.equal(ev.job.source, 'linkedin', `source should carry from the board, got "${ev.job.source}"`);

  // Clean up the engine's resident timers so the test process exits promptly.
  try { globalThis.window.dispatchEvent(new globalThis.Event('pagehide')); } catch {}
});
