// Workday adapter — wd*.myworkdayjobs.com/* (covers thousands of enterprise employers).
import { text, firstText, find, harvestSnippets, pickWorkMode, pickEmployment, jsonLdJobPosting, descFromJsonLd, locFromJsonLd, salaryFromJsonLd } from './base.js';

export const id = 'workday';
export const name = 'Workday';
export const matches = [/^https?:\/\/[a-z0-9-]+\.wd[0-9]+\.myworkdayjobs\.com\//i];

export function getExternalId() {
  // URL pattern: /Job_R-12345 or _JR12345
  const m = location.pathname.match(/[\/_](R-?\d+|JR\d+|REQ\d+)/i);
  return m ? m[1] : '';
}

export function getContext() {
  const jp = jsonLdJobPosting();
  // Workday's "automation-id" data attributes are stable across tenants
  const title = jp?.title || firstText(['[data-automation-id="jobPostingHeader"]', 'h1', '[data-automation-id="job-title"]']);
  // Company comes from URL: tenant.wdN.myworkdayjobs.com
  let company = jp?.hiringOrganization?.name || '';
  if (!company) {
    const host = location.hostname.split('.')[0]; // tenant
    company = host.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  const loc = (jp ? locFromJsonLd(jp) : '') || firstText(['[data-automation-id="locations"]', '[data-automation-id="locations"] dd']);
  const description = descFromJsonLd(jp) || (text(find(['[data-automation-id="jobPostingDescription"]'])) || '').slice(0, 8000);
  const snippets = harvestSnippets();
  return {
    title, company, location: loc,
    compensation: jp ? salaryFromJsonLd(jp) : '',
    workMode: pickWorkMode(snippets),
    employmentType: pickEmployment(snippets),
    description,
    jobUrl: location.href,
    externalId: getExternalId(),
    source: 'Workday'
  };
}

export function isApplyDialogOpen() {
  // Workday shows multi-step wizard — detect autoCompleteApplication URL or form
  return location.href.includes('/apply') || Boolean(document.querySelector('[data-automation-id="applyDialog"]'));
}
export function isSubmissionConfirmed() {
  if (location.href.includes('/applicationStatus') || location.href.includes('/thankYou')) return true;
  return /thank you for applying|your application has been received|submission complete/i.test((document.body.textContent || '').slice(0, 5000));
}
export function isSubmitClick(el) {
  const t = (el.textContent || '').trim();
  const aria = el.getAttribute?.('aria-label') || '';
  const dataId = el.getAttribute?.('data-automation-id') || '';
  return /^submit$/i.test(t) || /submit|review and submit/i.test(aria) || /submit|finishApplication/i.test(dataId);
}
export function isApplyClick(el) {
  const t = (el.textContent || '').trim();
  const dataId = el.getAttribute?.('data-automation-id') || '';
  return /^apply\b/i.test(t) || /applyManually|applyAutoFillWithResume/i.test(dataId);
}
export const submitClickSelectors = ['button', '[role="button"]'];
