// DOES THE DASHBOARD ACTUALLY RENDER, OR DOES IT ONLY CONTAIN THE RIGHT STRINGS?
//
// dashboard-truth.test.mjs asserts against the SOURCE TEXT of app.js. That is the right tool for
// "the reasoning must stay next to the code", and it is worth nothing against the failure that
// actually takes the page down: a template that parses fine and throws at render. The response-rate
// fix nests an IIFE returning a template literal inside another template literal, reading a `let`
// declared two hundred lines earlier in the same function. `node --check` is happy with a great
// many arrangements of that which produce a blank page.
//
// So: boot the real module in jsdom against a stubbed server, and read the HTML that comes out.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(here, '..', 'extension', 'app');
const APP_HTML = fs.readFileSync(path.join(APP_DIR, 'app.html'), 'utf8');

// One server, shaped by the knobs each case cares about.
function makeFetch({ gmail, funnel, sessionNeedsYou = 0, awaitingInQueue = 0, live = {} }) {
  const bodies = {
    '/settings': {
      ok: true,
      settings: {
        appearance: {}, nodes: [],
        autoApply: {
          enabled: false, mode: 'paced', boards: ['linkedin', 'indeed'],
          keywords: ['developer'], excludeKeywords: [], locations: ['Toronto'],
          excludeLocations: [], excludeCompanies: [], workModes: ['onsite'],
          country: 'CA', easyApplyOnly: true, experienceYears: 3, seniorityMax: 'senior',
          maxPerDay: 40, maxPerHour: 8, minGapMinutes: 3, maxGapMinutes: 9,
          concurrency: 1, perSiteConcurrency: 1,
          windowStart: '04:00', windowEnd: '10:00', runAnytime: false,
          idleOnly: false, idleThresholdSeconds: 300,
          keepAwake: true, keepDisplayAwake: false, bringToFrontToHydrate: true,
          profileId: 'p1', resumeDocId: 'd1',
        },
      },
    },
    '/stats': {
      ok: true, total: 7827, thisWeek: 424, needsReview: 2,
      submittedTotal: 1036, submittedAuto: 354, submittedManual: 682, submittedToday: 26,
      byStatus: { submitted: 1036 }, bySource: { linkedin: 4982 },
      funnel,
    },
    '/queue/counts': { ok: true, counts: { queued: 46, awaiting_input: awaitingInQueue } },
    '/ai/status': { ok: true, codex: { available: false }, ollama: { available: false } },
    '/gmail/status': gmail,
    // Shaped from the REAL laptop payload read 2026-08-29 06:30 UTC, because the bug
    // this guards was only visible with real values: a run 210 hours old whose
    // "submitted" counter had therefore never reset.
    '/auto-apply/live': {
      ok: true, enabled: true, status: 'running', queuedDepth: 46, active: 0, concurrency: 1,
      startedAt: live.startedAt || new Date(Date.now() - 210 * 3600e3).toISOString(),
      running: [], activeSites: [],
      session: { needsYou: sessionNeedsYou, submitted: live.submitted ?? 177, readyForReview: 29,
                 parked: 136, skipped: 454, failed: 166, finished: 962 },
      pacing: { maxPerHour: 120, maxPerDay: 500, effectivePerHour: 120, bindingCap: 'hourly-cap',
                doneHour: live.doneHour ?? 0, doneDay: live.doneDay ?? 32, dispatchedDay: 175,
                minGapMinutes: 0, maxGapMinutes: 0.25, concurrency: 1 },
      runSummary: { since: '2026-08-20T12:32:48.567Z', rawRate: 0.174, supportedRate: 0.2595, drivable: 682,
                    counts: { dispatched: 1017, verified_done: 177, awaiting_review: 29, site_gate: 37,
                              bot_challenge: 1, flow_failed: 340, needs_you: 136, skipped: 242, in_flight: 55 } },
      health: {}, safety: null,
    },
    '/auto-apply/breakdown?days=7': { ok: true, reasons: [] },
    '/stats/activity?days=30': { ok: true, days: [] },
    // --- the three pages v11.138 added, which have never rendered outside a live node ---
    '/queue/parked': { ok: true, items: [], count: 0 },
    '/auto-apply/needs-you': { ok: true, items: [] },
    '/auto-apply/discovery-status': { ok: true, status: null },
    '/profiles': { ok: true, items: [{ id: 'p1', name: 'Default' }] },
    '/documents': { ok: true, items: [{ id: 'd1', name: 'resume.pdf', role: 'resume' }] },
    '/queue': { ok: true, items: [] },
  };
  return async (url) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '');
    const key = Object.keys(bodies).find((k) => p === k || p.startsWith(k + '?') || p.startsWith(k));
    const body = key ? bodies[key] : (p.startsWith('/jobs') ? { ok: true, items: [] } : { ok: true });
    return {
      ok: true, status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => 'application/json' },
    };
  };
}

async function renderDashboard(opts) {
  const dom = new JSDOM(APP_HTML, {
    url: 'http://127.0.0.1:7744/app/?token=test-token#' + (opts.route || '/'),
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // The module installs a 1s interval at import time; left alive it keeps node:test from exiting.
  window.setInterval = () => 0;
  window.requestAnimationFrame = (fn) => { fn(0); return 0; };
  window.EventSource = class { constructor() { this.readyState = 0; } close() {} addEventListener() {} };
  window.fetch = makeFetch(opts);
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));

  for (const k of ['window', 'document', 'location', 'localStorage', 'navigator', 'HTMLElement',
    'Element', 'Node', 'CustomEvent', 'Event', 'getComputedStyle', 'EventSource', 'fetch',
    'requestAnimationFrame', 'setInterval', 'matchMedia', 'MutationObserver', 'IntersectionObserver']) {
    if (window[k] === undefined) continue;
    // Node 24 defines some of these (navigator) as getter-only on globalThis, so a plain
    // assignment throws. defineProperty works for both cases.
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
    catch { /* a global we cannot shadow is one the module will read from window anyway */ }
  }
  globalThis.chrome = undefined;

  await import(pathToFileURL(path.join(APP_DIR, 'app.js')).href + '?t=' + Math.random());

  // boot() is async through several awaits; give the microtask chain room to settle.
  for (let i = 0; i < 60; i++) await new Promise((r) => window.setTimeout(r, 5));
  return window.document.querySelector('#main')?.innerHTML || '';
}

const GMAIL_STALE_26D = {
  ok: true, enabled: true, configured: true, authorized: true, stale: false,
  lastResult: { at: new Date().toISOString() },
  health: { lastSuccessAt: new Date(Date.now() - 26 * 864e5).toISOString() },
};
const GMAIL_HEALTHY = {
  ok: true, enabled: true, configured: true, authorized: true, stale: false,
  lastResult: { at: new Date().toISOString() },
  health: { lastSuccessAt: new Date(Date.now() - 6 * 60000).toISOString() },
};
const ONE_REPLY = { submitted: 1036, responded: 1, interviews: 1, offers: 0 };

test('the dashboard renders at all', async () => {
  const html = await renderDashboard({ gmail: GMAIL_HEALTHY, funnel: ONE_REPLY });
  assert.ok(html.length > 2000, `#main came out ${html.length} chars — the view threw`);
  assert.match(html, /Response rate/);
  assert.match(html, /Submitted/);
});

test('a 26-day-stale Gmail sync suppresses the response-rate NUMBER', async () => {
  // The exact live condition: not failing, not flagged stale by the server — just not running.
  const html = await renderDashboard({ gmail: GMAIL_STALE_26D, funnel: ONE_REPLY });
  assert.match(html, /not counting/, 'it must say it is not measuring');
  assert.match(html, /the Gmail sync last succeeded/, 'and say why');
  const stat = html.slice(html.indexOf('Response rate'), html.indexOf('Response rate') + 400);
  assert.ok(!/>0%</.test(stat), 'a zero percent must not appear on the blind path');
});

test('a healthy sync still shows the rate, and 1-in-1036 is not "0%"', async () => {
  const html = await renderDashboard({ gmail: GMAIL_HEALTHY, funnel: ONE_REPLY });
  const stat = html.slice(html.indexOf('Response rate'), html.indexOf('Response rate') + 400);
  assert.match(stat, /&lt;1%|<1%/, '0.096% rounds to 0% and reads as a contradiction next to "1 replied"');
  assert.ok(!/not counting/.test(stat), 'a healthy sync must not be reported as blind');
});

test('a real rate is printed unchanged', async () => {
  const html = await renderDashboard({ gmail: GMAIL_HEALTHY, funnel: { submitted: 100, responded: 12, interviews: 3, offers: 0 } });
  const stat = html.slice(html.indexOf('Response rate'), html.indexOf('Response rate') + 400);
  assert.match(stat, /12%/);
});

test('the session needs-you card is labelled, and points at the backlog when it reads zero', async () => {
  const html = await renderDashboard({ gmail: GMAIL_HEALTHY, funnel: ONE_REPLY, sessionNeedsYou: 0, awaitingInQueue: 85 });
  assert.match(html, /Needs you · this session/);
  assert.match(html, /85 waiting overall/, 'zero-in-session beside 85-parked is the misleading case');
});

test('and does not nag when the session is the one holding the work', async () => {
  const html = await renderDashboard({ gmail: GMAIL_HEALTHY, funnel: ONE_REPLY, sessionNeedsYou: 4, awaitingInQueue: 85 });
  assert.match(html, /Needs you · this session/);
  assert.ok(!/waiting overall/.test(html), 'the pointer is for the zero case only');
});

// ---------------------------------------------------------------------------------------
// THE THREE PAGES v11.138.0 ADDED HAVE NEVER RENDERED ANYWHERE BUT A LIVE NODE.
//
// Apply settings and Needs you were built on 26 August and the laptop has been on 11.129.0
// ever since -- read off its live nav on 28 August, neither route exists there. When that
// build finally lands, a page that throws is indistinguishable from the wait he has already
// had, except worse. These are the smoke tests that were missing.
//
// /aa-settings dereferences settings.autoApply.boards on its first line, so "no settings" is
// a throw rather than an empty page. That is the exact shape a fresh install has.
// ---------------------------------------------------------------------------------------
test('Apply settings renders, with the controls actually on it', async () => {
  const html = await renderDashboard({ route: '/aa-settings', gmail: GMAIL_HEALTHY, funnel: ONE_REPLY });
  assert.ok(html.length > 2000, `#main came out ${html.length} chars — the view threw`);
  // The whole point of the page, in the words it actually uses: every control one click
  // away, with the pacing visible rather than buried under the question wall.
  for (const label of [/Max \/ day/, /Max \/ hour/, /Gap min/, /Keywords/, /Attach r/,
                       /Easy Apply only/, /Job boards/, /Max seniority/]) {
    assert.match(html, label, `Apply settings is missing ${label}`);
  }
  // and it must be reachable in one screen, not paged behind anything
  assert.match(html, /Save settings/, 'a settings page you cannot save is not a settings page');
});

test('Needs you renders when there is nothing to answer', async () => {
  // The empty state is the one nobody looks at, and the one everybody hits first.
  const html = await renderDashboard({ route: '/needs-you', gmail: GMAIL_HEALTHY, funnel: ONE_REPLY });
  assert.ok(html.length > 400, `#main came out ${html.length} chars — the view threw`);
  assert.match(html, /Needs you/);
});

test('Auto-apply renders, including the honest-rate panel', async () => {
  const html = await renderDashboard({ route: '/queue', gmail: GMAIL_HEALTHY, funnel: ONE_REPLY });
  assert.ok(html.length > 2000, `#main came out ${html.length} chars — the view threw`);
  assert.match(html, /Auto-apply/i);
});

test('every route survives a server that answers nothing useful', async () => {
  // A fresh install, a node mid-restart, a remote node half-awake: every endpoint returns
  // {ok:true} and nothing else. None of these pages may throw on that.
  for (const route of ['/', '/queue', '/needs-you', '/aa-settings']) {
    const html = await renderDashboard({
      route, gmail: null, funnel: { submitted: 0, responded: 0, interviews: 0, offers: 0 }, bare: true,
    });
    assert.ok(html.length > 100, `${route} rendered ${html.length} chars against an empty server`);
  }
});

// ---------------------------------------------------------------------------------------
// A RUN THAT IS NEVER STOPPED HAS A COUNTER THAT IS NEVER RESET.
//
// Read off the live laptop 2026-08-29 06:30 UTC: session.submitted = 177, startedAt =
// 2026-08-20T12:32:48Z. That is 210 hours. The panel rendered "submitted 177" with no
// timeframe on the label and "~120 applications/hour at current settings" underneath, so
// 177 read as roughly a day's work and the 120 read as the rate. It was nine days of work
// at 0.84/hour, and 120 was the CAP. Pierre spotted it himself: "I don't think it did one
// seventy seven in twenty four hours."
// ---------------------------------------------------------------------------------------
test('a long-running counter is labelled with how long it has been running', async () => {
  const html = await renderDashboard({ route: '/queue', gmail: GMAIL_HEALTHY, funnel: ONE_REPLY });
  assert.match(html, /submitted · 8d run|submitted · 9d run/,
    'an unqualified "submitted" beside a 210-hour total is the defect');
  assert.match(html, /reset only when the run does/, 'and the page must say why it never resets');
});

test('today and this hour are shown separately, against their caps', async () => {
  const html = await renderDashboard({ route: '/queue', gmail: GMAIL_HEALTHY, funnel: ONE_REPLY });
  assert.match(html, /Today/);
  assert.match(html, /This hour/);
  assert.match(html, /32<span class="rate-of">\/ 500 cap/, "today's real number against the daily cap");
  assert.match(html, /175 dispatched today/);
});

test('the ACHIEVED rate is computed, not the permitted one', async () => {
  const html = await renderDashboard({ route: '/queue', gmail: GMAIL_HEALTHY, funnel: ONE_REPLY });
  assert.match(html, /Actually achieving/);
  assert.match(html, /0\.84<span class="rate-of">\/ hour/, '177 submits over 210 hours is 0.84/h');
  assert.match(html, /Ceiling at your settings/, 'the cap stays, labelled as a cap');
  assert.match(html, /you are getting <b>1%<\/b> of it/, '0.84 against a 120/h ceiling');
});

test('a fresh run does not claim a rate it cannot know yet', async () => {
  // Ten minutes in, submits-per-hour is noise. Say nothing rather than something wrong.
  const html = await renderDashboard({
    route: '/queue', gmail: GMAIL_HEALTHY, funnel: ONE_REPLY,
    live: { startedAt: new Date(Date.now() - 10 * 60000).toISOString(), submitted: 2 },
  });
  assert.match(html, /submitted · this run/, 'under an hour there is no age to quote');
  assert.ok(!/reset only when the run does/.test(html), 'the caveat is for long runs only');
});
