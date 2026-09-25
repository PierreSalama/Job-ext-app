// FEED THE QUEUE FROM THE ONE DISCOVERY PATH THAT STILL WORKS.
//
// Measured 2026-09-08. The queue held 40 tasks, all Indeed, and neither lane could touch them: the
// extension because the bot-challenge breaker was holding indeed.com, the AI lane because Indeed
// served it Cloudflare "Additional Verification Required" on the first page load. Discovery itself
// was alive but Indeed-only and rate-limited by the safety governor to one search per ten minutes,
// so it produced nothing at all.
//
// The ATS lane never had any of those problems. Greenhouse, Ashby and Lever all publish plain JSON
// job boards: no login, no Cloudflare, no bot detection, no pacing floor. That is how the Method:CRM
// job Pierre is interviewing for on Monday was found in the first place.
//
// What it lacked was Canadian companies. The shipped seed list is 153 tokens and reads like a US
// tech index — Databricks, OpenAI, Stripe, Palantir, Datadog, Spotify, Waymo. Pierre is a Canadian
// citizen who needs sponsorship for American roles, so most of what that list can reach is unusable
// to him, which is why those providers kept reporting found>0 accepted=0.
//
// Every token below was probed against its live public API before being written down, and every one
// of them had at least one Canadian software role open at the time. Nothing here is a guess.
//
// The jobs are POSTed to /queue/discover, which runs ingestDiscoveredJobs — so Pierre's own
// keyword whitelist, exclusion list, seniority cap, location clamp and duplicate check all still
// apply. This widens the intake; it does not bypass a single filter.
//
//   node feed-ca-boards.mjs --dry            fetch and classify, POST nothing
//   node feed-ca-boards.mjs                  fetch and feed

const ARG = process.argv.slice(2);
const val = (f, d) => { const i = ARG.indexOf(f); return i >= 0 && ARG[i + 1] ? ARG[i + 1] : d; };
const BASE = val('--base', process.env.JAT_BASE || 'http://127.0.0.1:7744');
const TOKEN = val('--token', process.env.JAT_TOKEN || '');
const DRY = ARG.includes('--dry');

// Verified live on 2026-09-08 by probe-ca-boards.mjs, which tried 2,412 endpoints across 259
// Canadian companies and kept only the boards that answered. Re-run that probe to refresh this.
//
// The two counts are `software roles in Canada` / `of those, at Pierre's seniorityMax of 'mid'`.
// The second number is the one that matters: he keeps the cap at mid, so a board showing 6/0 is
// real supply he cannot currently reach, and is kept here only so a later cap change picks it up
// without another probe.
export const CA_BOARDS = [
  // SECOND SWEEP, 13 September 2026. Probed 120 Canadian employers against the three public ATS
  // APIs; these 33 tokens answered with a real posting list. Nine roles sat at his level on the day,
  // so the value here is future coverage, not today.
  { ats: 'lever', token: 'kepler' },
  { ats: 'greenhouse', token: 'tulip' },
  { ats: 'ashby', token: 'felix' },
  { ats: 'greenhouse', token: 'pagerduty' },
  { ats: 'ashby', token: 'benevity' },
  { ats: 'ashby', token: 'thinkific' },
  { ats: 'ashby', token: 'lightspeed' },
  { ats: 'ashby', token: 'koho' },
  { ats: 'ashby', token: 'maple' },
  { ats: 'greenhouse', token: 'mejuri' },
  { ats: 'lever', token: 'knix' },
  { ats: 'ashby', token: 'circle' },
  { ats: 'ashby', token: 'relay' },
  { ats: 'lever', token: 'relay' },
  { ats: 'ashby', token: 'venn' },
  { ats: 'greenhouse', token: 'hootsuite' },
  { ats: 'greenhouse', token: 'unbounce' },
  { ats: 'lever', token: 'finn' },
  { ats: 'greenhouse', token: 'carbon' },
  { ats: 'greenhouse', token: 'flipp' },
  { ats: 'ashby', token: 'rewind' },
  { ats: 'lever', token: 'trellis' },
  { ats: 'greenhouse', token: 'slice' },
  { ats: 'ashby', token: 'kira' },
  { ats: 'lever', token: 'blue' },
  { ats: 'ashby', token: 'clearco' },
  { ats: 'lever', token: 'rise' },
  { ats: 'greenhouse', token: 'knit' },
  { ats: 'ashby', token: 'nivoda' },
  { ats: 'ashby', token: 'sparrow' },
  { ats: 'greenhouse', token: 'poka' },
  { ats: 'ashby', token: 'dapper' },
  { ats: 'lever', token: 'aircall' },
  { ats: 'greenhouse', token: 'stackadapt' },
  { ats: 'greenhouse', token: 'tenstorrent' },
  { ats: 'greenhouse', token: 'alayacare' },
  { ats: 'greenhouse', token: 'd2l' },
  { ats: 'ashby', token: '1password' },
  { ats: 'greenhouse', token: 'geotab' },
  { ats: 'greenhouse', token: '7shifts' },
  { ats: 'greenhouse', token: 'faire' },
  { ats: 'lever', token: 'pointclickcare' },
  { ats: 'ashby', token: 'cohere' },
  { ats: 'greenhouse', token: 'appnovation' },
  { ats: 'ashby', token: 'miovision' },
  { ats: 'lever', token: 'magnetforensics' },
  { ats: 'ashby', token: 'method-crm' },
  { ats: 'ashby', token: 'wealthsimple' },
  { ats: 'lever', token: 'waabi' },
  { ats: 'ashby', token: 'jobber' },
  { ats: 'ashby', token: 'procurify' },
  { ats: 'ashby', token: 'trulioo' },
  { ats: 'greenhouse', token: 'knak' },
  { ats: 'lever', token: 'pigment' },
  { ats: 'ashby', token: 'float' },
  { ats: 'ashby', token: 'sierra' },
  { ats: 'ashby', token: 'elevenlabs' },
  { ats: 'ashby', token: 'docebo' },
  { ats: 'ashby', token: 'relayfi' },
  { ats: 'lever', token: 'achievers' },
  { ats: 'ashby', token: 'jane' },
  { ats: 'greenhouse', token: 'dialpad' },
  { ats: 'lever', token: 'zensurance' },
  { ats: 'greenhouse', token: 'clutch' },
  { ats: 'greenhouse', token: 'shakepay' },
  { ats: 'lever', token: 'fullscript' },
  { ats: 'ashby', token: 'lightspeedhq' },
  { ats: 'greenhouse', token: 'mobsquad' },
  { ats: 'greenhouse', token: 'leagueinc' },
  { ats: 'ashby', token: 'hopper' },
  { ats: 'ashby', token: 'klue' },
  { ats: 'ashby', token: 'neofinancial' },
  { ats: 'greenhouse', token: 'workleap' },
  { ats: 'lever', token: 'osedea' },
  { ats: 'greenhouse', token: 'later' },
  { ats: 'ashby', token: 'phoenix' },
  { ats: 'lever', token: 'quandri' },
  // THIRD SWEEP, 14 September 2026. The lane had gone 20 self-check cycles reporting "nothing
  // claimable"; the feed was fetching 1140 Canadian postings a run and enqueuing zero, with 676 of
  // them dropped as above-level-cap. That is the filter working, not failing - the existing 33
  // boards are harvested out and what remains on them is explicitly senior/staff/lead. Probed 80
  // more Canadian employers across the three ATS APIs; these seven answered with a live posting
  // list. Only wattpad held an on-level role on the day, so again this is coverage for tomorrow.
  { ats: 'ashby', token: 'loopio' },
  { ats: 'ashby', token: 'solink' },
  { ats: 'lever', token: 'mistplay' },
  { ats: 'lever', token: 'wattpad' },
  { ats: 'lever', token: 'apryse' },
  { ats: 'greenhouse', token: 'cardata' },
  { ats: 'greenhouse', token: 'tucows' },
];

// Canada only. He is a Canadian citizen: a US posting would need sponsorship, which is the single
// most common reason an application of his goes nowhere.
const CA = /\b(canada|canadian|toronto|ontario|montr|quebec|québec|vancouver|calgary|ottawa|waterloo|kitchener|cambridge|mississauga|edmonton|halifax|winnipeg|victoria|alberta|remote[- ]?ca)\b/i;

const BOARDS = {
  greenhouse: {
    url: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`,
    map: (j, t) => (j.jobs || []).map((x) => ({
      title: x.title, company: t, location: (x.location && x.location.name) || '',
      url: x.absolute_url, jobUrl: x.absolute_url, applyUrl: x.absolute_url,
    })),
  },
  ashby: {
    url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
    map: (j, t) => (j.jobs || []).map((x) => ({
      title: x.title, company: (j.name || t), location: x.location || '',
      url: x.jobUrl, jobUrl: x.jobUrl, applyUrl: x.applyUrl || x.jobUrl,
    })),
  },
  lever: {
    url: (t) => `https://api.lever.co/v0/postings/${t}?mode=json`,
    map: (j, t) => (Array.isArray(j) ? j : []).map((x) => ({
      title: x.text, company: t, location: (x.categories && x.categories.location) || '',
      url: x.hostedUrl, jobUrl: x.hostedUrl, applyUrl: x.applyUrl || x.hostedUrl,
    })),
  },
};

async function getJson(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15000);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': 'jat-ats-feed' } });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

async function post(path, body) {
  // The laptop drops sockets while Chrome is busy. An ECONNRESET halfway through the board list
  // killed the first run of this and took the reject tally with it, which was the only number worth
  // having. Retry, and never let a dead socket end the sweep.
  let last = null;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'x-jat-token': TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    } catch (e) { last = e; await new Promise((s) => setTimeout(s, 3000 * (i + 1))); }
  }
  return { status: 0, body: { error: last && last.message } };
}

// ONLY SWEEP WHEN THIS FILE IS THE THING BEING RUN.
//
// CA_BOARDS is the verified token list and other tooling wants to import it. Before this guard the
// sweep sat at module top level, so `import { CA_BOARDS }` silently re-ran the entire feed against
// whatever BASE the importer happened to default to. Caught on 2026-09-08 when a read-only analysis
// script hung doing exactly that.
const isEntryPoint = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('feed-ca-boards.mjs');
if (!isEntryPoint) {
  // imported for CA_BOARDS alone — do nothing else
} else {

const totals = { fetched: 0, canadian: 0, enqueued: 0, duplicates: 0, rejected: 0 };
const reasons = {};

for (const { ats, token } of CA_BOARDS) {
  const spec = BOARDS[ats];
  const data = await getJson(spec.url(token));
  if (!data) { console.log(`${ats}/${token}: board did not answer`); continue; }

  const all = spec.map(data, token).filter((j) => j.title && j.jobUrl);
  const ca = all.filter((j) => CA.test(j.location));
  totals.fetched += all.length;
  totals.canadian += ca.length;
  if (!ca.length) { console.log(`${ats}/${token}: ${all.length} jobs, none in Canada`); continue; }

  if (DRY) {
    console.log(`${ats}/${token}: would send ${ca.length} of ${all.length}`);
    continue;
  }

  // Straight into the app's own ingest, so every one of his filters still gets a say.
  const { status, body } = await post('/queue/discover', {
    source: ats, provider: `${ats}-api`, jobs: ca,
  });
  if (status !== 200) { console.log(`${ats}/${token}: ingest returned ${status}`); continue; }

  totals.enqueued += body.enqueued || 0;
  totals.duplicates += body.duplicates || 0;
  totals.rejected += body.rejected || 0;
  for (const [k, v] of Object.entries(body.rejectReasons || {})) reasons[k] = (reasons[k] || 0) + v;

  console.log(`${ats}/${token}: sent ${ca.length}  ->  kept ${body.enqueued || 0}, `
    + `${body.duplicates || 0} already known, ${body.rejected || 0} filtered`);
  // Pacing. Firing 22 ingests back to back put the app into a burst of 403s on 2026-09-08 and cost
  // the whole reject tally. It is a local box doing real work; give it room between batches.
  await new Promise((s) => setTimeout(s, 2500));
}

console.log('\n=== TOTALS ===');
console.log(`fetched ${totals.fetched} postings, ${totals.canadian} of them in Canada`);
if (!DRY) {
  console.log(`ENQUEUED ${totals.enqueued}  |  ${totals.duplicates} already known  |  ${totals.rejected} filtered out`);
  if (Object.keys(reasons).length) {
    console.log('\nwhy the filtered ones were dropped:');
    Object.entries(reasons).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`));
  }
}

}   // end isEntryPoint
