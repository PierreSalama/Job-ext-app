// LinkedIn adapter. Patterns derived from v4 (proven) plus signals from
// the open-source LinkedIn-Job-Apply-Bot, easyapplybot, and JobSpy projects.
import { text, find, firstText, jsonLdJobPosting, locFromJsonLd, salaryFromJsonLd, descFromJsonLd, harvestSnippets, pickSalary, pickWorkMode, pickEmployment } from './base.js';

export const id = 'linkedin';
export const name = 'LinkedIn';
export const matches = [/^https?:\/\/(www\.)?linkedin\.com\//i];

const TOPCARD = ['.job-details-jobs-unified-top-card__container--two-pane', '.jobs-unified-top-card', '.jobs-details'];
const TITLE = ['.job-details-jobs-unified-top-card__job-title h1', '.job-details-jobs-unified-top-card__job-title', '.jobs-unified-top-card__job-title h1', '.jobs-unified-top-card__job-title', 'h1.t-24', 'h1'];
const COMPANY = ['.job-details-jobs-unified-top-card__company-name a', '.job-details-jobs-unified-top-card__company-name', '.jobs-unified-top-card__company-name a', '.jobs-unified-top-card__company-name', 'a[href*="/company/"]'];
const LOCATION = ['.job-details-jobs-unified-top-card__primary-description-container .tvm__text--low-emphasis:first-child', '.job-details-jobs-unified-top-card__primary-description-container', '.jobs-unified-top-card__primary-description-without-tagline', '.jobs-unified-top-card__primary-description'];
const SALARY = ['.job-details-fit-level-preferences > button:first-child', '.job-details-jobs-unified-top-card__job-insight--highlight'];
const DESCRIPTION = ['#job-details', '.jobs-description__content', '.jobs-description-content__text'];

export function getExternalId() {
  const m = location.href.match(/[?&]currentJobId=(\d+)/) || location.href.match(/\/jobs\/view\/(\d+)/);
  if (m) return m[1];
  const e = document.querySelector('[data-job-id], [data-occludable-job-id]');
  return e ? (e.getAttribute('data-job-id') || e.getAttribute('data-occludable-job-id') || '') : '';
}

export function getContext() {
  const jp = jsonLdJobPosting();
  const top = find(TOPCARD) || document;
  const title = jp?.title || firstText(TITLE);
  const company = jp?.hiringOrganization?.name || firstText(COMPANY);
  const loc = (jp ? locFromJsonLd(jp) : '') || (firstText(LOCATION).split('·')[0] || '').trim();
  let salary = (jp ? salaryFromJsonLd(jp) : '') || firstText(SALARY);
  const snippets = harvestSnippets(top);
  if (!salary) salary = pickSalary(snippets);
  const workMode = pickWorkMode(snippets);
  const employmentType = pickEmployment(snippets);
  const description = descFromJsonLd(jp) || (text(find(DESCRIPTION)) || '').slice(0, 8000);
  const recruiterBlock = Array.from(document.querySelectorAll('section, div')).find((el) => /Meet the hiring team|People you can reach out to/i.test(text(el)));
  const recruiterName = recruiterBlock ? firstText(['strong', 'a'], recruiterBlock) : '';
  const recruiterTitle = recruiterBlock ? Array.from(recruiterBlock.querySelectorAll('span, div')).map(text).find((v) => /recruit|talent|hiring/i.test(v)) || '' : '';
  return {
    title, company, location: loc,
    compensation: salary, workMode, employmentType,
    description, recruiterName, recruiterTitle,
    jobUrl: location.href,
    externalId: getExternalId(),
    linkedinJobId: getExternalId(), // back-compat
    source: 'LinkedIn'
  };
}

export function isApplyDialogOpen() {
  return Boolean(Array.from(document.querySelectorAll('div.artdeco-modal[role="dialog"], [role="dialog"]'))
    .find((el) => /Easy Apply|Submit application|Review your application|Apply to /i.test(text(el))));
}

export function isSubmissionConfirmed() {
  if (document.getElementById('post-apply-modal') ||
      document.querySelector('[id^="post-apply"], [class*="post-apply-card"], [class*="jobs-post-apply"]')) return true;
  const top = find(TOPCARD);
  if (!top) return false;
  if (top.querySelector('.artdeco-inline-feedback--success, .post-apply-timeline, .jobs-s-apply-feedback')) return true;
  for (const b of top.querySelectorAll('button, a')) {
    if (/^applied\b/i.test(text(b))) return true;
  }
  const tt = text(top);
  if (/applied\s+\d+\s+\w+\s+ago/i.test(tt)) return true;
  if (/applied\s+(today|yesterday|just now)/i.test(tt)) return true;
  if (/your application was sent/i.test(tt) || /application sent/i.test(tt)) return true;
  return false;
}

// CSS selectors for click signals
export const submitClickSelectors = [
  'button[aria-label*="Submit application" i]',
  '.jobs-easy-apply-footer__submit-button',
  'button:not([disabled])'
];
export function isSubmitClick(el) {
  const t = (el.textContent || '').trim();
  const aria = el.getAttribute?.('aria-label') || '';
  const cls = (el.className || '').toString();
  return /^submit application$/i.test(t) || /^submit$/i.test(t) ||
         /submit application/i.test(aria) ||
         /jobs-easy-apply-footer__submit-button/i.test(cls);
}
export function isApplyClick(el) {
  const t = (el.textContent || '').trim();
  const aria = el.getAttribute?.('aria-label') || '';
  const cls = (el.className || '').toString();
  return /^easy apply$/i.test(t) || /^easy apply$/i.test(aria) || /jobs-apply-button/i.test(cls);
}
