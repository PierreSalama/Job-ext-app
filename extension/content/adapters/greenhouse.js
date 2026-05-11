// Greenhouse adapter — boards.greenhouse.io and embedded boards (job-boards.greenhouse.io).
// Greenhouse is a major ATS used by thousands of startups. Renders clean JSON-LD.
import { genericContextFromJsonLd, text, firstText, find, descFromJsonLd, jsonLdJobPosting } from './base.js';

export const id = 'greenhouse';
export const name = 'Greenhouse';
export const matches = [
  /^https?:\/\/(boards|job-boards)\.greenhouse\.io\//i,
  /^https?:\/\/[^/]+\.greenhouse\.io\//i
];

export function getExternalId() {
  const m = location.pathname.match(/\/jobs\/(\d+)/);
  if (m) return m[1];
  const url = new URL(location.href);
  return url.searchParams.get('gh_jid') || '';
}

export function getContext() {
  // 1. Try JSON-LD first (Greenhouse provides clean schema.org)
  const ctx = genericContextFromJsonLd() || {};
  // 2. Fallback DOM scraping
  if (!ctx.title) ctx.title = firstText(['h1.app-title', '.app-title', 'h1']);
  if (!ctx.company) ctx.company = firstText(['.company-name', '.app-company-link', '[class*="company"]']);
  if (!ctx.location) ctx.location = firstText(['.location', '.app-location', 'div.location']);
  if (!ctx.description) ctx.description = (text(find(['#content', '.app-description', '.content'])) || '').slice(0, 8000);
  // Company from URL subdomain if still missing (boards.greenhouse.io/companyname)
  if (!ctx.company) {
    const m = location.pathname.match(/^\/([^\/]+)\//);
    if (m) ctx.company = m[1].replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  ctx.jobUrl = location.href;
  ctx.externalId = getExternalId();
  ctx.source = 'Greenhouse';
  return ctx;
}

export function isApplyDialogOpen() {
  // Greenhouse application form is inline at /jobs/123#app
  return Boolean(document.querySelector('#application_form, form[action*="apply"]'));
}
export function isSubmissionConfirmed() {
  const body = (document.body.textContent || '').slice(0, 5000);
  return /thank you for applying|application received|we have received your application/i.test(body) ||
    Boolean(document.querySelector('#application_thank_you, .thank-you'));
}
export function isSubmitClick(el) {
  const t = (el.textContent || '').trim();
  return /^submit application$/i.test(t) || /^apply for this job$/i.test(t);
}
export function isApplyClick(el) {
  const t = (el.textContent || '').trim();
  return /^apply\b/i.test(t) || /^I'm interested\b/i.test(t);
}
export const submitClickSelectors = ['button[type="submit"]', 'input[type="submit"]', 'button'];
