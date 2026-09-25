// WHY a discovery batch accepted nothing.
//
// Measured 2026-09-08: four ATS batches in a row reported "found 20, accepted 0" and there was no
// way to tell whether the filters were correctly rejecting off-target roles or silently discarding
// every good one. At the same moment the runnable queue had collapsed to a single host, so that
// distinction was the difference between "supply is fine, the postings are wrong" and "a filter is
// broken and the night is lost".
//
// The counter existed. The reason did not. These tests pin the normalisation, because the reasons
// carry specifics — a company name, a salary figure — and counting them raw would give every
// posting its own unique key and be exactly as useless as the bare number was.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.join(here, '..', 'app', 'src', 'server.js'), 'utf8');

// The normaliser lives inside ingestDiscoveredJobs, which needs a database and a settings row to
// call. Lift the gate ladder out of the source and exercise it directly: this asserts the mapping
// itself, which is the part that silently rots when a reason string is reworded.
function extractNormaliser() {
  const start = serverSrc.indexOf('const gate = /above your level cap/');
  assert.ok(start > 0, 'the reject-reason normaliser is no longer in server.js under that shape');
  const end = serverSrc.indexOf(';', serverSrc.indexOf(': r;', start));
  const body = serverSrc.slice(start, end + 1);
  // eslint-disable-next-line no-new-func
  return new Function('r', `${body} return gate;`);
}
const gateFor = extractNormaliser();

test('every jobFit rejection reason maps to a named gate, not to itself', () => {
  // These strings are copied from the `return { ok: false, reason: ... }` sites in jobFit. If one
  // is reworded and this mapping is not, the tally quietly degrades to raw text — which is the
  // failure this whole change exists to prevent, so fail loudly instead.
  const cases = {
    'above your level cap (mid)': 'above-level-cap',
    'academic/research role (postdoc/PhD/faculty) — off-target': 'academic-role',
    'excluded keyword "senior"': 'excluded-keyword',
    'excluded company "Acme Corp"': 'excluded-company',
    'excluded location "Texas"': 'excluded-location',
    'outside Canada (Austin, TX)': 'outside-country',
    'below your salary floor — stated pay tops out at ~85,000 CAD/yr, below 90,000': 'below-salary-floor',
    'off-target: title matches none of your keywords': 'title-keyword-miss',
  };
  for (const [reason, expected] of Object.entries(cases)) {
    assert.equal(gateFor(reason), expected, `"${reason}" should count as ${expected}`);
  }
});

test('specifics are collapsed so two rejections of the same kind share one key', () => {
  // The whole point: 30 postings rejected by the salary floor must read as one number, not as 30
  // separate reasons that each differ only by the dollar figure.
  assert.equal(
    gateFor('below your salary floor — stated pay tops out at ~85,000 CAD/yr, below 90,000'),
    gateFor('below your salary floor — stated pay tops out at ~62,500 CAD/yr, below 90,000'),
  );
  assert.equal(gateFor('excluded company "Acme"'), gateFor('excluded company "Globex"'));
  assert.equal(gateFor('above your level cap (mid)'), gateFor('above your level cap (entry)'));
});

test('an unrecognised reason survives verbatim rather than being lost', () => {
  // A new gate added later must still show up in the tally, even before anyone teaches the
  // normaliser about it. Silently bucketing it as "unknown" would hide the very thing worth seeing.
  assert.equal(gateFor('some brand new gate nobody mapped yet'), 'some brand new gate nobody mapped yet');
});

test('ingestDiscoveredJobs returns the tally, and both discovery paths record it', () => {
  assert.match(serverSrc, /return \{ enqueued, rejected, punished, duplicates, watchAlerts, rejectReasons \}/,
    'ingestDiscoveredJobs must return rejectReasons or nothing downstream can record it');

  for (const rel of [['app', 'src', 'discovery', 'index.js'], ['app', 'src', 'discovery', 'ats-boards.js']]) {
    const src = fs.readFileSync(path.join(here, '..', ...rel), 'utf8');
    assert.match(src, /rejectReasons: intake\.rejectReasons \|\| \{\}/,
      `${rel.join('/')} must carry the tally into the batch diagnostics`);
  }
});

test('rejected is still counted exactly once per rejected posting', () => {
  // noteReject replaced three bare `rejected++` sites. If any survives, or if one path both calls
  // noteReject AND increments, the totals stop matching the tally and the numbers lie.
  const fn = serverSrc.slice(serverSrc.indexOf('function ingestDiscoveredJobs'), serverSrc.indexOf('function withinWindow'));
  const bare = fn.match(/(?<!\w)rejected\+\+/g) || [];
  assert.equal(bare.length, 1, 'the only rejected++ should be the one inside noteReject');
  assert.match(fn, /const noteReject = \(reason\) => \{\s*rejected\+\+/);
});

test('the extension search lane explains itself when it keeps nothing', () => {
  // /queue/discover is the extension's own search: it opens a real search page in Pierre's
  // logged-in session and posts what it scraped. It is also the lane that spends the LinkedIn
  // search budget, 8 of 8 in an hour on 2026-09-08, while the runnable queue held zero LinkedIn
  // jobs and was 100% Indeed - which is exactly why the node had nothing to fall back on when
  // Indeed started serving Cloudflare.
  //
  // The reasons were already computed on this path and then discarded, because this caller passes
  // batchId:null and the tally is only ever persisted onto a batch. A search could bring back
  // thirty jobs, drop all thirty, and leave no trace.
  const handler = serverSrc.slice(serverSrc.indexOf("pathname === '/queue/discover'"));
  const block = handler.slice(0, handler.indexOf('return sendJson'));
  assert.match(block, /result\.rejectReasons/, 'the reasons must reach the log, not just be computed');
  assert.match(block, /if \(jobs\.length && !result\.enqueued\)/,
    'log only when a search found something and kept none of it');
});
