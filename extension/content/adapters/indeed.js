// Indeed adapter. Selectors derived from indeed-scraper, JobSpy, and indeed.com 2025 markup.
import { text, find, firstText, jsonLdJobPosting, descFromJsonLd, locFromJsonLd, salaryFromJsonLd, harvestSnippets, pickSalary, pickWorkMode, pickEmployment } from './base.js';

export const id = 'indeed';
export const name = 'Indeed';
export const matches = [/^https?:\/\/([a-z]{2,3}\.)?indeed\.com\//i];

const TITLE = ['[data-testid="jobsearch-JobInfoHeader-title"]', '.jobsearch-JobInfoHeader-title', 'h1[data-testid="jobTitle"]', 'h1.jobsearch-JobInfoHeader-title', 'h1'];
const COMPANY = ['[data-testid="inlineHeader-companyName"] a', '[data-testid="inlineHeader-companyName"]', 'div[data-company-name="true"]', '.jobsearch-InlineCompanyRating-companyHeader a'];
const LOCATION = ['[data-testid="job-location"]', '[data-testid="inlineHeader-companyLocation"]', '[data-testid="jobsearch-JobInfoHeader-companyLocation"]'];
const SALARY = ['[data-testid="job-compensation"]', '#salaryInfoAndJobType', '.css-1zr0ndj'];
const DESCRIPTION = ['#jobDescriptionText', '.jobsearch-jobDescriptionText', '[data-testid="jobsearch-JobComponent-description"]'];

export function getExternalId() {
  const url = new URL(location.href);
  const jk = url.searchParams.get('jk') || url.searchParams.get('vjk');
  if (jk) return jk;
  const m = location.pathname.match(/\/viewjob\/(.+)$/) || location.pathname.match(/\/rc\/clk\/(.+)$/);
  return m ? m[1] : '';
}

export function getContext() {
  const jp = jsonLdJobPosting();
  const title = jp?.title || firstText(TITLE);
  const company = jp?.hiringOrganization?.name || firstText(COMPANY);
  const loc = (jp ? locFromJsonLd(jp) : '') || firstText(LOCATION);
  let salary = (jp ? salaryFromJsonLd(jp) : '') || firstText(SALARY);
  const snippets = harvestSnippets();
  if (!salary) salary = pickSalary(snippets);
  const description = descFromJsonLd(jp) || (text(find(DESCRIPTION)) || '').slice(0, 8000);
  return {
    title, company, location: loc,
    compensation: salary,
    workMode: pickWorkMode(snippets),
    employmentType: pickEmployment(snippets),
    description,
    jobUrl: location.href,
    externalId: getExternalId(),
    source: 'Indeed'
  };
}

export function isApplyDialogOpen() {
  // Indeed Apply opens an iframe overlay (id starts with "indeedapply-modal" / "ia-Modal")
  return Boolean(document.querySelector('iframe[id*="indeedapply"], iframe[src*="indeed.com/applied"], #ia-Modal, [data-testid="iaModal"]'));
}

export function isSubmissionConfirmed() {
  // "Your application has been submitted" or "Applied" badge after success
  const body = (document.body.textContent || '').slice(0, 5000);
  if (/your application has been submitted|application submitted|applied to this job|you\s*'?ve already applied/i.test(body)) return true;
  if (document.querySelector('[data-testid="indeedApply-applied"], .ia-IndeedApplyButton-applied')) return true;
  return false;
}

export function isSubmitClick(el) {
  const t = (el.textContent || '').trim();
  const aria = el.getAttribute?.('aria-label') || '';
  return /^(submit application|continue|apply now)$/i.test(t) || /submit application|apply now/i.test(aria);
}
export function isApplyClick(el) {
  const t = (el.textContent || '').trim();
  const cls = (el.className || '').toString();
  return /^(apply now|apply on company site)$/i.test(t) || /indeedApplyButton/i.test(cls);
}
export const submitClickSelectors = ['button', 'a'];
