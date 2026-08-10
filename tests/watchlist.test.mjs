// The company watchlist. Built because two months of cold volume produced two interviews and no
// job worth taking, while Pierre now holds something volume cannot manufacture: a phone screen at
// Syntronic (2026-07-23) and a named recruiter, Adam Ortner, who closed the loop decently when the
// Montreal req was cancelled by their Director on 2026-08-10.
//
// The two properties that make it worth having, and that a later "simplification" would break:
//   1. A watch NEVER auto-applies. Sending a generic auto-application to a warm contact's company
//      spends the relationship instead of using it.
//   2. Matching ignores the keyword list. "Anything Syntronic posts" is a different question from
//      "anything matching my search terms", and the relevance gate must not get a vote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const wl = require(path.join(here, '..', 'app', 'src', 'watchlist.js'));
const { DEFAULTS } = require(path.join(here, '..', 'app', 'src', 'config.js'));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');

const SYNTRONIC = { company: 'Syntronic', contact: 'Adam Ortner <adorxb@syntronic.com>', note: 'phone screen 2026-07-23', enabled: true };

// ---- matching the corporate-name family --------------------------------------------------------

test('one watch entry catches the whole naming family', () => {
  for (const name of ['Syntronic', 'Syntronic Inc.', 'Syntronic R&D Canada', 'SYNTRONIC AB', 'Syntronic Technologies Ltd']) {
    assert.equal(wl.matchesWatch(name, 'Syntronic'), true, `${name} is Syntronic`);
  }
});

test('a different company is not a match', () => {
  for (const name of ['Syntel', 'Synopsys', 'Sync Technologies', 'Tronic Systems']) {
    assert.equal(wl.matchesWatch(name, 'Syntronic'), false, `${name} is not Syntronic`);
  }
});

test('matching works when the POSTING name is the longer one, and when the watch is', () => {
  assert.equal(wl.matchesWatch('Automated DesignWorks Inc.', 'Automated DesignWorks'), true);
  assert.equal(wl.matchesWatch('DesignWorks', 'DesignWorks Canada Ltd'), true);
});

test('corporate furniture is stripped, not treated as the name', () => {
  assert.equal(wl.normalizeCompany('Syntronic R&D Canada Inc.'), 'syntronic');
  assert.equal(wl.normalizeCompany('Acme Technologies Solutions Ltd.'), 'acme');
});

test('a company whose whole name IS furniture cannot become a wildcard', () => {
  // "Group Ltd" normalises to nothing; it must match nothing rather than everything.
  assert.equal(wl.normalizeCompany('Group Ltd.'), '');
  assert.equal(wl.matchesWatch('Any Company At All', 'Group Ltd.'), false);
});

test('a very short residue does not match half the market', () => {
  assert.equal(wl.matchesWatch('Core Systems International', 'IBM'), false);
  assert.equal(wl.matchesWatch('Some Big Co', 'Co'), false, 'a 2-char watch is too generic to fire');
});

// ---- selecting watches for a job ---------------------------------------------------------------

test('a posting from a watched company returns the entry, with the contact attached', () => {
  const hits = wl.watchesFor({ company: 'Syntronic R&D Canada', title: 'Anything' }, [SYNTRONIC]);
  assert.equal(hits.length, 1);
  assert.match(hits[0].contact, /Adam Ortner/, 'the point is to write to a person, not a careers page');
});

test('the keyword list gets NO vote — an off-keyword title from a watched company still hits', () => {
  // "Business Systems Developer" is not in his search keywords. From Syntronic it still matters.
  const hits = wl.watchesFor({ company: 'Syntronic', title: 'Embedded Test Technician' }, [SYNTRONIC]);
  assert.equal(hits.length, 1);
});

test('every SITE of a watched company counts, not just the one he interviewed at', () => {
  // The Montreal req died; Ottawa/Kanata and elsewhere are exactly where the next one appears.
  for (const location of ['Montréal, QC', 'Ottawa, ON', 'Kanata, ON', 'Remote, Canada']) {
    assert.equal(wl.watchesFor({ company: 'Syntronic', title: 'Developer', location }, [SYNTRONIC]).length, 1);
  }
});

test('a disabled entry stops firing without being deleted', () => {
  assert.equal(wl.watchesFor({ company: 'Syntronic' }, [{ ...SYNTRONIC, enabled: false }]).length, 0);
});

test('a job with no company matches nothing', () => {
  assert.equal(wl.watchesFor({ title: 'Developer' }, [SYNTRONIC]).length, 0);
  assert.equal(wl.watchesFor({ company: '' }, [SYNTRONIC]).length, 0);
});

test('an empty watchlist is simply inert', () => {
  assert.deepEqual(wl.watchesFor({ company: 'Syntronic' }, []), []);
  assert.deepEqual(wl.watchesFor({ company: 'Syntronic' }, undefined), []);
});

test('the alert carries everything needed to act', () => {
  const a = wl.alertFor({ id: 'job_1', title: 'Business Systems Developer', company: 'Syntronic', location: 'Ottawa, ON', jobUrl: 'https://x/1', source: 'linkedin' }, SYNTRONIC);
  for (const k of ['jobId', 'title', 'company', 'location', 'url', 'contact', 'note', 'at']) {
    assert.ok(a[k] !== undefined, `alert carries ${k}`);
  }
  assert.match(a.contact, /adorxb@syntronic\.com/);
});

// ---- wiring: flags, never applications ---------------------------------------------------------

test('a watch NEVER queues an application', () => {
  const src = read('app', 'src', 'server.js');
  const block = src.slice(src.indexOf('const watchAlerts = [];'), src.indexOf("broadcast('queue.updated', { action: 'discover'"));
  assert.doesNotMatch(block, /queueAdd/, 'a watch raises a flag — it must never auto-apply');
  assert.match(block, /recordEvent/, 'but it does leave a trace on the job');
});

test('the watch check runs BEFORE jobFit so the relevance gate cannot veto it', () => {
  const src = read('app', 'src', 'server.js');
  const fn = src.slice(src.indexOf('function ingestDiscoveredJobs('));
  const iWatch = fn.indexOf('watchlist.watchesFor');
  const iFit = fn.indexOf('const verdict = jobFit(jd, s);');
  assert.ok(iWatch > -1 && iWatch < iFit, 'a watched company must surface even off-keyword');
});

test('alerts are deduped, or a daily repeat trains him to ignore them', () => {
  const src = read('app', 'src', 'server.js');
  assert.match(src, /watchSeen:/, 'discovery re-finds the same posting every sweep');
});

test('the watchlist ships EMPTY — a company list is personal, not a default', () => {
  assert.deepEqual(DEFAULTS.autoApply.watchlist, []);
});

test('watchlist-sourced jobs are TAGGED, so the 12.5% claim can settle itself', () => {
  // The case for the whole mechanism rests on a 12.5%-vs-4.5% response rate measured over 16
  // applications, with overlapping confidence intervals. The only way to settle that is to let it
  // generate its own evidence — and a source tag is unambiguous where a regex over titles is not.
  // A regex over titles is precisely what produced a wrong answer the first time this was measured.
  const src = read('app', 'src', 'server.js');
  assert.match(src, /watchedUrls\.has\(jd\.jobUrl\) \? \['auto-apply', 'watchlist'\] : \['auto-apply'\]/,
    'a watched-company job carries a distinct tag');
  const i = src.indexOf('const watchedUrls = new Set()');
  const j = src.indexOf("tags: watchedUrls.has(jd.jobUrl)");
  assert.ok(i > -1 && i < j, 'the set is built before ingest uses it');
});

test('tagging does not change which jobs get queued — it only labels them', () => {
  // The watchlist must never become a volume mechanism. Its value is applying EARLY to a SMALL
  // number of well-chosen employers; if it started queueing extra work, the selection has gone
  // wrong rather than the throughput going right.
  const src = read('app', 'src', 'server.js');
  const fn = src.slice(src.indexOf('function ingestDiscoveredJobs('), src.indexOf('function withinWindow('));
  const gate = fn.slice(fn.indexOf('const verdict = jobFit(jd, s);'), fn.indexOf('ranked.push'));
  assert.doesNotMatch(gate, /watched/, 'a watched company gets no exemption from the relevance/fit gates at ingest');
});
