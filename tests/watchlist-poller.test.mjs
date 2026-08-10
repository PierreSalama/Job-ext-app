// The board poller. Scope was set by measurement, not ambition: probing all 27 watched companies
// against the public ATS JSON APIs on 2026-08-10 found exactly TWO reachable — Syntronic and
// Kepler, both on Lever. The other 25 run Workday, SuccessFactors or bespoke career pages and
// expose no public board, which is also why broad discovery never found them.
//
// So these tests pin a deliberately small mechanism: notify, never apply; alert once per posting;
// and never let a bad board take the whole poll down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const wl = require(path.join(here, '..', 'app', 'src', 'watchlist.js'));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');

const SYNTRONIC = {
  company: 'Syntronic',
  contact: 'Adam Ortner <adorxb@syntronic.com>',
  board: { ats: 'lever', token: 'syntronic' },
  enabled: true,
};

// Shaped like real Lever payloads, including the two French Montreal titles actually on their board.
const LEVER = [
  { id: '1', text: 'Python Developer', categories: { location: 'Kanata, ON' }, hostedUrl: 'https://jobs.lever.co/syntronic/1' },
  { id: '2', text: 'IT Support Developer', categories: { location: 'Toronto, ON' }, hostedUrl: 'https://jobs.lever.co/syntronic/2' },
  { id: '3', text: 'Développeur logiciel senior - Systèmes embarqués', categories: { location: 'Montreal, QC' }, hostedUrl: 'https://jobs.lever.co/syntronic/3' },
  { id: '4', text: 'RF Hardware Developer (ULF/VLF)', categories: { location: 'Kanata, ON' }, hostedUrl: 'https://jobs.lever.co/syntronic/4' },
  { id: '5', text: 'Office Administrator', categories: { location: 'Kanata, ON' }, hostedUrl: 'https://jobs.lever.co/syntronic/5' },
  { id: '6', text: 'Software Engineer', categories: { location: 'Stockholm, Sweden' }, hostedUrl: 'https://jobs.lever.co/syntronic/6' },
];
const okFetch = (payload = LEVER) => async () => ({ ok: true, status: 200, json: async () => payload });

test('a real Lever board yields alerts for the fitting roles', async () => {
  const r = await wl.pollBoards({ entries: [SYNTRONIC], fetchFn: okFetch() });
  const titles = r.alerts.map((a) => a.title);
  assert.ok(titles.includes('Python Developer'));
  assert.ok(titles.includes('IT Support Developer'));
  assert.ok(titles.includes('Développeur logiciel senior - Systèmes embarqués'), 'French titles must not be dropped');
  assert.equal(r.polled, 1);
});

test('non-software and out-of-country postings are left out', async () => {
  const r = await wl.pollBoards({ entries: [SYNTRONIC], fetchFn: okFetch() });
  const titles = r.alerts.map((a) => a.title);
  assert.ok(!titles.includes('Office Administrator'), 'not a role he would take');
  assert.ok(!titles.some((t) => t === 'Software Engineer'), 'Stockholm is not somewhere he can work');
});

test('every alert carries the WARM CONTACT — the whole reason this beats cold volume', async () => {
  const r = await wl.pollBoards({ entries: [SYNTRONIC], fetchFn: okFetch() });
  assert.ok(r.alerts.length > 0);
  for (const a of r.alerts) {
    assert.match(a.contact, /Adam Ortner/);
    assert.ok(a.url.startsWith('https://'), 'and a link he can act on');
    assert.equal(a.company, 'Syntronic');
  }
});

test('a posting alerts ONCE — a repeat every 12h trains him to ignore it', async () => {
  const seen = new Set();
  const first = await wl.pollBoards({ entries: [SYNTRONIC], seen, fetchFn: okFetch() });
  const second = await wl.pollBoards({ entries: [SYNTRONIC], seen, fetchFn: okFetch() });
  assert.ok(first.alerts.length > 0);
  assert.equal(second.alerts.length, 0, 'the same board twice must be silent the second time');
});

test('a NEW posting on an already-seen board still alerts', async () => {
  const seen = new Set();
  await wl.pollBoards({ entries: [SYNTRONIC], seen, fetchFn: okFetch() });
  const withNew = [...LEVER, { id: '99', text: 'Full Stack Developer', categories: { location: 'Toronto, ON' }, hostedUrl: 'https://jobs.lever.co/syntronic/99' }];
  const r = await wl.pollBoards({ entries: [SYNTRONIC], seen, fetchFn: okFetch(withNew) });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].title, 'Full Stack Developer');
});

test('a dead board does not take the whole poll down', async () => {
  const dead = { company: 'Dead Co', board: { ats: 'lever', token: 'nope' }, enabled: true };
  let call = 0;
  const fetchFn = async () => { call++; return call === 1 ? { ok: false, status: 404 } : { ok: true, status: 200, json: async () => LEVER }; };
  const r = await wl.pollBoards({ entries: [dead, SYNTRONIC], fetchFn });
  assert.ok(r.errors.some((e) => /Dead Co/.test(e)), 'the failure is reported');
  assert.ok(r.alerts.length > 0, 'and the healthy board still produced alerts');
});

test('a thrown fetch is caught rather than crashing the tick', async () => {
  const r = await wl.pollBoards({ entries: [SYNTRONIC], fetchFn: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(r.alerts.length, 0);
  assert.match(r.errors[0], /Syntronic: ECONNRESET/);
});

test('entries with no board, or disabled, are skipped entirely', async () => {
  let called = 0;
  const fetchFn = async () => { called++; return { ok: true, status: 200, json: async () => LEVER }; };
  const r = await wl.pollBoards({
    entries: [{ company: 'No Board' }, { ...SYNTRONIC, enabled: false }],
    fetchFn,
  });
  assert.equal(called, 0, 'a company with no public board costs no request');
  assert.equal(r.polled, 0);
  assert.equal(r.alerts.length, 0);
});

test('an unknown ATS is reported, not silently ignored', async () => {
  const r = await wl.pollBoards({ entries: [{ company: 'X', board: { ats: 'workday', token: 'x' }, enabled: true }], fetchFn: async () => { throw new Error('should not fetch'); } });
  assert.match(r.errors[0], /unknown ats "workday"/);
});

test('THE POLLER NEVER APPLIES — it notifies', () => {
  // Two companies with ~36 openings between them. At that size speed buys nothing and a tailored
  // application buys a lot, especially where a named recruiter has already screened him.
  const src = read('app', 'src', 'watchlist.js');
  const fn = src.slice(src.indexOf('async function pollBoards('));
  assert.doesNotMatch(fn, /queueAdd|upsertJob|ingestDiscovered/, 'the poller must not create applications');
});

test('the scope is documented where the next person will look', () => {
  const src = read('app', 'src', 'watchlist.js');
  assert.match(src, /TWO reachable/i, 'why this polls 2 companies and not 27 must be written down');
  assert.match(src, /Workday|SuccessFactors/, 'and what the other 25 actually run');
});
