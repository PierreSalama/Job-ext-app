// JAT v11 — browser-fallback board search URL builder (pure, node-testable).
//
// Builds the search URLs the extension navigates to when it scrapes a board directly
// (JobSpy-failure fallback + the discovery combos loop). Three concerns beyond the bare
// keyword:
//   1. GEOGRAPHY — `location` is ALWAYS a place; if empty we fall back to the user's
//      `country`, so a LinkedIn search is never borderless ("remote" applied worldwide).
//   2. WORK MODE — remote/hybrid/onsite is a SEPARATE filter, NOT a location. On LinkedIn
//      it's `f_WT` (1=On-site, 2=Remote, 3=Hybrid; multiple joined with %2C); on Indeed,
//      remote adds Indeed's remote attribute filter.
//   3. FRESHNESS — newest-first ramp. LinkedIn `f_TPR=r<seconds>`; Indeed coarse
//      `&fromage=<days>` (sub-day tiers clamp to 1).

import { tierToIndeedDays } from './freshness.js';

const LINKEDIN_WT = { onsite: '1', remote: '2', hybrid: '3' };

function normModes(workModes) {
  const order = ['remote', 'hybrid', 'onsite'];
  const set = new Set((Array.isArray(workModes) ? workModes : []).map((m) => String(m).trim().toLowerCase()));
  return order.filter((m) => set.has(m));
}

// board, keyword, location → URL. opts:
//   easyApplyOnly (default true), workModes ([]), country ('Canada'), freshnessSeconds (null)
function buildSearchUrl(board, keyword, location, opts = {}) {
  const { easyApplyOnly = true, workModes = [], country = 'Canada', freshnessSeconds = null } = opts;
  const kw = encodeURIComponent(keyword);
  // Geography is mandatory: never let a search go out without a place. Empty location →
  // the user's country, so results stay inside the country (no borderless remote).
  const geo = String(location || '').trim() || String(country || '').trim() || 'Canada';
  const loc = encodeURIComponent(geo);
  const modes = normModes(workModes);

  if (board === 'indeed') {
    // Indeed packs filters into ONE `0kf` attribute group (`&sc=0kf:attr(A)attr(B);`).
    // Easily-apply = DSQF7; remote = DGTV2. Build the group from whatever is requested so
    // we never emit two conflicting &sc params (the last one would win and drop a filter).
    const attrs = [];
    if (easyApplyOnly) attrs.push('attr(DSQF7)');
    if (modes.includes('remote')) attrs.push('attr(DGTV2)');
    const sc = attrs.length ? `&sc=0kf%3A${attrs.join('')}%3B` : '';
    // Coarse freshness: Indeed only does whole days. Default to 7 when no ramp tier given.
    const fromage = freshnessSeconds != null ? tierToIndeedDays(freshnessSeconds) : 7;
    return `https://www.indeed.com/jobs?q=${kw}&sort=date&fromage=${fromage}${sc}&l=${loc}`;
  }
  if (board === 'glassdoor') {
    // Glassdoor has no public easy-apply-only URL filter (drivability sorted post-scrape).
    return `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${kw}&fromAge=7` + `&locKeyword=${loc}`;
  }
  // linkedin (default) — f_AL=true = Easy-Apply filter; DD = sort by date.
  const al = easyApplyOnly ? 'f_AL=true&' : '';
  // Work mode → f_WT (1/2/3), multiple joined with %2C.
  const wt = modes.length ? `&f_WT=${modes.map((m) => LINKEDIN_WT[m]).join('%2C')}` : '';
  // Freshness → f_TPR=r<seconds> (newest-first ramp). Omitted when no tier is supplied.
  const tpr = freshnessSeconds != null ? `&f_TPR=r${Number(freshnessSeconds)}` : '';
  return `https://www.linkedin.com/jobs/search/?${al}keywords=${kw}&sortBy=DD&location=${loc}${wt}${tpr}`;
}

export { buildSearchUrl, normModes };
