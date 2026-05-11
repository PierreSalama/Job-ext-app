// Glassdoor adapter — based on glassdoor-scraper, JobSpy, glassdoor 2025 markup.
import { text, find, firstText, jsonLdJobPosting, locFromJsonLd, salaryFromJsonLd, descFromJsonLd, harvestSnippets, pickSalary, pickWorkMode, pickEmployment } from './base.js';

export const id = 'glassdoor';
export const name = 'Glassdoor';
export const matches = [/^https?:\/\/(www\.)?glassdoor\.(com|co\.[a-z]+|ca|de|fr|es|it|nl)\//i];

const TITLE = ['[data-test="job-title"]', '.JobDetails_jobTitle__Rw_gn', 'h1[data-test="jobTitle"]', 'h1'];
const COMPANY = ['[data-test="employer-name"]', '.EmployerProfile_employerName__7fEYV', 'div[data-test="employerName"]'];
const LOCATION = ['[data-test="location"]', '.JobDetails_location__MbnUM'];
const SALARY = ['[data-test="detailSalary"]', '.JobDetails_salary__MoMTl'];
const DESCRIPTION = ['[data-test="jobDescriptionContent"]', '.JobDetails_jobDescription__uW_fK', '.jobDescriptionContent'];

export function getExternalId() {
  const m = location.pathname.match(/jobListingId=(\d+)/) || location.search.match(/jobListingId=(\d+)/);
  if (m) return m[1];
  const m2 = location.pathname.match(/JV.*?_KO\d+,\d+_IC(\d+)/);
  if (m2) return m2[1];
  const m3 = location.pathname.match(/-JV_(\d+)/);
  return m3 ? m3[1] : '';
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
    source: 'Glassdoor'
  };
}

export function isApplyDialogOpen() {
  return Boolean(document.querySelector('[data-test="apply-modal"], .applyButton-modal, .ApplyButton__applyModal'));
}
export function isSubmissionConfirmed() {
  const body = (document.body.textContent || '').slice(0, 5000);
  return /application submitted|you have applied|you\s*'?ve applied/i.test(body);
}
export function isSubmitClick(el) {
  const t = (el.textContent || '').trim();
  return /^(submit|submit application|finish)$/i.test(t);
}
export function isApplyClick(el) {
  const t = (el.textContent || '').trim();
  const cls = (el.className || '').toString();
  return /^easy apply$/i.test(t) || /^apply now$/i.test(t) || /applyButton/i.test(cls);
}
export const submitClickSelectors = ['button', 'a'];
