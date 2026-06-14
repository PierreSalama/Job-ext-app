// JAT v11 — applied-jobs sync scraper.
// Reads the user's PAST applications off LinkedIn (/my-items/saved-jobs?cardType=APPLIED)
// and Indeed (myjobs). Fail-soft like discover.js: returns whatever it can read plus a
// human-readable note; never throws. Selectors drift — multiple fallbacks are used, and
// the importer dedups + dates everything, so partial reads are safe.

import { qsa, compactText } from './lib/dom.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function abs(href) { try { return new URL(href, location.href).href; } catch { return href || ''; } }

// "Applied 3 days ago" / "2 weeks ago" / "yesterday" / "Jan 5, 2025" → ISO (or '').
function parseApplied(text) {
  const t = (text || '').toLowerCase();
  const now = Date.now();
  if (!t) return '';
  if (/just now|today|aujourd|moments? ago/.test(t)) return new Date(now).toISOString();
  if (/yesterday|hier/.test(t)) return new Date(now - 86400e3).toISOString();
  const m = t.match(/(\d+)\s*(hour|hr|day|week|wk|month|mo|year|yr|jour|semaine|mois|an)/);
  if (m) {
    const n = Number(m[1]); const u = m[2];
    const mult = /hour|hr/.test(u) ? 3600e3 : /day|jour/.test(u) ? 86400e3
      : /week|wk|semaine/.test(u) ? 7 * 86400e3 : /month|mo|mois/.test(u) ? 30 * 86400e3
      : /year|yr|an/.test(u) ? 365 * 86400e3 : 0;
    if (mult) return new Date(now - n * mult).toISOString();
  }
  const d = Date.parse(text);
  return Number.isNaN(d) ? '' : new Date(d).toISOString();
}

async function autoScroll(rounds) {
  let lastH = 0;
  for (let i = 0; i < rounds; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(900);
    const h = document.body.scrollHeight;
    if (h === lastH && i > 2) break;   // list stopped growing
    lastH = h;
  }
}

const LI_SEL = 'li.reusable-search__result-container, .reusable-search__result-container, li[data-occludable-entity-urn], [data-view-name="job-card"], .entity-result, .scaffold-finite-scroll__content > li';
const IN_SEL = '[data-testid="myJobCard"], [data-testid*="jobCard"], #jobsToShow > div, .job_seen_beacon, [data-jk]';

function scrapeLinkedIn(max) {
  const out = [];
  for (const card of qsa(LI_SEL)) {
    if (out.length >= max) break;
    const link = card.querySelector('a[href*="/jobs/view/"], a.job-card-list__title, a[class*="title"], a[href*="currentJobId"]');
    const url = abs(link?.getAttribute('href') || '');
    const idm = url.match(/\/jobs\/view\/(\d+)/) || url.match(/currentJobId=(\d+)/);
    const title = compactText(link?.getAttribute('aria-label') || link?.textContent
      || card.querySelector('[class*="title"]')?.textContent || '').replace(/, verification.*/i, '');
    const company = compactText(card.querySelector('.entity-result__primary-subtitle, [class*="primary-description"], [class*="subtitle"]')?.textContent || '');
    const dateText = compactText(card.querySelector('time, [class*="footer"], [class*="insight"], [class*="metadata"]')?.textContent || '');
    if (!title) continue;
    out.push({ externalId: idm ? idm[1] : '', title, company, jobUrl: url, source: 'linkedin', appliedAt: parseApplied(dateText), appliedText: dateText });
  }
  return out;
}

function scrapeIndeed(max) {
  const out = [];
  for (const card of qsa(IN_SEL)) {
    if (out.length >= max) break;
    const link = card.querySelector('a[href*="/viewjob"], a[href*="jk="], a[class*="jobTitle"], h2 a, a');
    const url = abs(link?.getAttribute('href') || '');
    const jk = card.getAttribute('data-jk') || card.querySelector('[data-jk]')?.getAttribute('data-jk') || (url.match(/jk=([0-9a-f]+)/)?.[1]) || '';
    const title = compactText(card.querySelector('[class*="jobTitle"], h2, [data-testid*="title"]')?.textContent || link?.textContent || '');
    const company = compactText(card.querySelector('[data-testid="company-name"], [class*="companyName"], [class*="company"]')?.textContent || '');
    const dateText = compactText(card.querySelector('[data-testid*="date"], time, [class*="date"], [class*="status"]')?.textContent || '');
    if (!title) continue;
    out.push({ externalId: jk, title, company, jobUrl: url, source: 'indeed', appliedAt: parseApplied(dateText), appliedText: dateText });
  }
  return out;
}

function pageNote(found) {
  const t = compactText(document.body?.innerText || '').toLowerCase().slice(0, 4000);
  if (!found && /(sign in|join now|log ?in to|sign ?in to)/.test(t)) return 'looks like you’re signed out — log into the site in this browser, then sync again';
  if (/no applications|you have(n['’]| not) applied|haven['’]?t applied|no jobs to show/.test(t)) return 'no applied jobs found on this account';
  return found ? '' : 'couldn’t read the applied-jobs list (the page layout may have changed — tell Pierre to tune the selectors)';
}

export async function run({ source, max = 400 } = {}) {
  try {
    const host = location.hostname;
    const isLinked = /linkedin/.test(host) || source === 'linkedin';
    await sleep(1400);
    await autoScroll(isLinked ? 12 : 10);
    const jobs = isLinked ? scrapeLinkedIn(max) : scrapeIndeed(max);
    return { ok: true, source: isLinked ? 'linkedin' : 'indeed', jobs, found: jobs.length, note: pageNote(jobs.length) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), jobs: [], found: 0, note: 'applied-sync crashed: ' + String(e?.message || e) };
  }
}
