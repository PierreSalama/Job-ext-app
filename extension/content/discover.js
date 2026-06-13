// JAT v11 — auto-apply discovery: scrape Easy-Apply search-result cards.
// Runs in an already-loaded LinkedIn/Indeed search page (opened by the SW with
// the Easy-Apply filter). Reads result cards via STABLE attributes, confirms
// Easy-Apply where it can, skips already-applied, and returns a small batch.
// Fail-soft: selector rot returns fewer jobs, never throws.

import { qsa, compactText } from './lib/dom.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
function abs(href) { try { return new URL(href, location.href).href; } catch { return href || ''; } }

function scrapeLinkedIn(max) {
  const out = [];
  const seen = new Set();
  const cards = qsa('li[data-occludable-job-id], .job-card-container, .jobs-search-results__list-item, [data-job-id]');
  for (const card of cards) {
    if (out.length >= max) break;
    const id = card.getAttribute('data-occludable-job-id')
      || card.getAttribute('data-job-id')
      || card.querySelector('[data-job-id]')?.getAttribute('data-job-id')
      || (card.querySelector('a[href*="/jobs/view/"]')?.getAttribute('href') || '').match(/\/jobs\/view\/(\d+)/)?.[1];
    if (id && seen.has(id)) continue;
    const cardText = (card.textContent || '').toLowerCase();
    if (/\bapplied\b/.test(cardText)) continue;                         // skip already-applied
    if (/\beasy apply\b/.test(cardText) === false && !/f_al=true/i.test(location.search)) {
      // not on an Easy-Apply-filtered search and no badge → skip (can't finish it)
      continue;
    }
    const link = card.querySelector('a.job-card-list__title, a.job-card-container__link, a[href*="/jobs/view/"]');
    const title = compactText(link?.textContent || card.querySelector('[class*="job-card-list__title"]')?.textContent || '');
    const company = compactText(card.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle, [class*="subtitle"]')?.textContent || '');
    const location = compactText(card.querySelector('.job-card-container__metadata-item, [class*="metadata-item"]')?.textContent || '');
    const jobUrl = id ? `https://www.linkedin.com/jobs/view/${id}/` : abs(link?.getAttribute('href'));
    if (!jobUrl || !title) continue;
    if (id) seen.add(id);
    out.push({ externalId: id ? String(id) : null, title, company, location, jobUrl, source: 'linkedin' });
  }
  return out;
}

function scrapeIndeed(max) {
  const out = [];
  const seen = new Set();
  const cards = qsa('#mosaic-provider-jobcards .job_seen_beacon, [data-testid="slider_item"], .job_seen_beacon, a[data-jk], [data-jk]');
  for (const card of cards) {
    if (out.length >= max) break;
    const jk = card.getAttribute('data-jk')
      || card.querySelector('[data-jk]')?.getAttribute('data-jk')
      || (card.querySelector('a[href*="jk="]')?.getAttribute('href') || '').match(/[?&]jk=([^&]+)/)?.[1];
    if (!jk || seen.has(jk)) continue;
    seen.add(jk);
    const title = compactText(card.querySelector('a.jcs-JobTitle, h2 a, [id^="jobTitle"], [class*="jobTitle"]')?.textContent || '');
    const company = compactText(card.querySelector('[data-testid="company-name"], [class*="companyName"]')?.textContent || '');
    const location = compactText(card.querySelector('[data-testid="text-location"], [class*="companyLocation"]')?.textContent || '');
    if (!title) continue;
    out.push({ externalId: jk, title, company, location, jobUrl: `https://www.indeed.com/viewjob?jk=${encodeURIComponent(jk)}`, source: 'indeed' });
  }
  return out;
}

// Entry — scroll to load lazy cards (human-ish cadence), then scrape one page.
export async function run({ source, max = 8 } = {}) {
  try {
    for (let i = 0; i < 4; i++) { window.scrollBy(0, rand(500, 1200)); await sleep(rand(700, 1800)); }
    const host = location.hostname;
    let jobs = [];
    if (/linkedin/i.test(host) || source === 'linkedin') jobs = scrapeLinkedIn(max);
    else if (/indeed/i.test(host) || source === 'indeed') jobs = scrapeIndeed(max);
    return { ok: true, source: source || host, jobs: jobs.slice(0, max) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), jobs: [] };
  }
}
