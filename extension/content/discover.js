// JAT v11 — auto-apply discovery: scrape Easy-Apply search-result cards.
// Runs in an already-loaded LinkedIn/Indeed search page (opened by the SW with
// the Easy-Apply filter). Waits for the lazy SPA list to render, reads cards via
// STABLE attributes, skips already-applied, detects "no results"/login walls,
// and returns a small batch + a human-readable note for the dashboard.
// Fail-soft: selector rot returns fewer jobs + a note, never throws.

import { qsa, compactText } from './lib/dom.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
function abs(href) { try { return new URL(href, location.href).href; } catch { return href || ''; } }

const LI_CARD_SEL = 'li[data-occludable-job-id], [data-job-id], .job-card-container, .jobs-search-results__list-item, .scaffold-layout__list-item';
const IN_CARD_SEL = '#mosaic-provider-jobcards .job_seen_beacon, [data-testid="slider_item"], .job_seen_beacon, a[data-jk], [data-jk]';

// Poll for the result list to render (LinkedIn/Indeed hydrate after load).
async function waitForCards(sel, ms = 12000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (qsa(sel).length) return true;
    await sleep(500);
  }
  return false;
}

function pageNote() {
  const t = (document.body?.innerText || '').toLowerCase();
  if (/no matching jobs found|no results found|we couldn['’]t find/i.test(t)) return 'site returned no matching jobs for this search';
  if (/\bsign in\b/.test(t) && /\bjoin now\b/.test(t) && !qsa(LI_CARD_SEL + ',' + IN_CARD_SEL).length) return 'looks like a sign-in wall — log into the site in this browser first';
  if (/(unusual activity|verify you|are you a human|captcha)/i.test(t)) return 'a security check appeared — open the site manually and pass it';
  return '';
}

// LinkedIn's job-card aria-label bleeds UI cruft into the title: a "with verification"
// badge suffix, and often the title doubled (visually-hidden + visible span). Clean it.
function cleanTitle(s) {
  let t = compactText(s || '');
  t = t.replace(/\s*[-–—]?\s*with verification\b/ig, '');     // verified-job badge text
  t = t.replace(/\s*\(verified\)\s*$/ig, '');
  const h = Math.floor(t.length / 2);                          // collapse an exactly-doubled title
  if (t.length > 6 && t.slice(0, h).trim() && t.slice(0, h).trim() === t.slice(h).trim()) t = t.slice(0, h).trim();
  return t.trim();
}

function scrapeLinkedIn(max) {
  const out = [];
  const seen = new Set();
  for (const card of qsa(LI_CARD_SEL)) {
    if (out.length >= max) break;
    const id = card.getAttribute('data-occludable-job-id')
      || card.getAttribute('data-job-id')
      || card.querySelector('[data-job-id]')?.getAttribute('data-job-id')
      || (card.querySelector('a[href*="/jobs/view/"]')?.getAttribute('href') || '').match(/\/jobs\/view\/(\d+)/)?.[1];
    if (id && seen.has(id)) continue;
    if (/\bapplied\b/.test((card.textContent || '').toLowerCase())) continue;   // skip already-applied
    const link = card.querySelector('a.job-card-list__title, a.job-card-container__link, a[href*="/jobs/view/"]');
    const title = cleanTitle(link?.getAttribute('aria-label') || link?.textContent || card.querySelector('[class*="job-card-list__title"]')?.textContent || '');
    const company = compactText(card.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle, [class*="subtitle"]')?.textContent || '');
    const loc = compactText(card.querySelector('.job-card-container__metadata-item, [class*="metadata-item"]')?.textContent || '');
    const jobUrl = id ? `https://www.linkedin.com/jobs/view/${id}/` : abs(link?.getAttribute('href'));
    if (!jobUrl || !title) continue;
    if (id) seen.add(id);
    out.push({ externalId: id ? String(id) : null, title, company, location: loc, jobUrl, source: 'linkedin' });
  }
  return out;
}

function scrapeIndeed(max, easyApplyOnly = true) {
  const out = [];
  const seen = new Set();
  for (const card of qsa(IN_CARD_SEL)) {
    if (out.length >= max) break;
    const jk = card.getAttribute('data-jk')
      || card.querySelector('[data-jk]')?.getAttribute('data-jk')
      || (card.querySelector('a[href*="jk="]')?.getAttribute('href') || '').match(/[?&]jk=([^&]+)/)?.[1];
    if (!jk || seen.has(jk)) continue;
    seen.add(jk);
    // Second guard (the URL DSQF7 filter is the first): only keep cards Indeed marks
    // "Easily apply" — the rest are external "apply on company site" jobs we can't drive.
    if (easyApplyOnly && !/easily apply|apply with indeed|indeed apply/i.test(card.textContent || '')) continue;
    const title = compactText(card.querySelector('a.jcs-JobTitle, h2 a, [id^="jobTitle"], [class*="jobTitle"]')?.textContent || '');
    const company = compactText(card.querySelector('[data-testid="company-name"], [class*="companyName"]')?.textContent || '');
    const loc = compactText(card.querySelector('[data-testid="text-location"], [class*="companyLocation"]')?.textContent || '');
    if (!title) continue;
    out.push({ externalId: jk, title, company, location: loc, jobUrl: `https://www.indeed.com/viewjob?jk=${encodeURIComponent(jk)}`, source: 'indeed' });
  }
  return out;
}

// Entry — wait for the list, scroll to load lazily, then scrape one page.
// Returns { ok, source, jobs, found (raw cards seen), note }.
export async function run({ source, max = 8, easyApplyOnly = true } = {}) {
  try {
    const host = location.hostname;
    const isLinkedIn = /linkedin/i.test(host) || source === 'linkedin';
    const sel = isLinkedIn ? LI_CARD_SEL : IN_CARD_SEL;

    await waitForCards(sel, 12000);
    // nudge the lazy list (both window + the inner scroll container LinkedIn uses)
    const scroller = document.querySelector('.jobs-search-results-list, .scaffold-layout__list, #mosaic-jobResults') || window;
    for (let i = 0; i < 5; i++) {
      try { (scroller === window ? window : scroller).scrollBy(0, rand(500, 1200)); } catch { window.scrollBy(0, 800); }
      await sleep(rand(600, 1400));
    }

    const found = qsa(sel).length;
    const jobs = (isLinkedIn ? scrapeLinkedIn(max) : scrapeIndeed(max, easyApplyOnly)).slice(0, max);
    const note = jobs.length ? '' : (pageNote() || (found ? `saw ${found} card(s) but couldn't read any (selectors may need tuning)` : 'no job cards rendered on the page'));
    return { ok: true, source: source || host, jobs, found, note };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), jobs: [], found: 0, note: 'discovery crashed: ' + String(e?.message || e) };
  }
}
