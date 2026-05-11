// Generic adapter — fallback for any site with a JSON-LD JobPosting tag.
// Covers: Ashby, Workable, BambooHR, RipplingATS, JazzHR, SmartRecruiters, Personio, Recruitee,
// many company career pages. Activated only when a JobPosting JSON-LD is detected.
import { genericContextFromJsonLd, text, firstText, find, harvestSnippets, pickSalary, pickWorkMode, pickEmployment } from './base.js';

export const id = 'generic';
export const name = 'Job Posting';
export const matches = [/.*/]; // catch-all but only activated by canActivate()

export function canActivate() {
  // Activate only when the page actually exposes a JobPosting JSON-LD,
  // OR has obvious "Apply" UI on the page.
  if (genericContextFromJsonLd()) return true;
  if (document.querySelector('button[type="submit"], .apply-button, [class*="apply"], [id*="apply"]')) {
    // and the page text contains job-relevant keywords
    const t = (document.body.textContent || '').slice(0, 3000).toLowerCase();
    if (/(job description|responsibilities|qualifications|requirements|about the role)/i.test(t)) return true;
  }
  return false;
}

export const id_ = 'generic';
export const name_ = 'Generic JobPosting';

export function getExternalId() {
  // Use canonical URL as the de-facto external id (already deduped via jobUrl).
  const link = document.querySelector('link[rel="canonical"]');
  return link ? link.href : '';
}

export function getContext() {
  const ctx = genericContextFromJsonLd() || {};
  if (!ctx.title) ctx.title = firstText(['h1', '[itemprop="title"]', '.job-title']);
  if (!ctx.company) ctx.company = firstText(['[itemprop="hiringOrganization"]', '.company-name', 'meta[property="og:site_name"]']);
  if (!ctx.location) ctx.location = firstText(['[itemprop="jobLocation"]', '.location', '.job-location']);
  if (!ctx.description) ctx.description = (text(find(['main', 'article', '.job-description', '#job-description', '.content'])) || '').slice(0, 8000);
  const snippets = harvestSnippets();
  if (!ctx.compensation) ctx.compensation = pickSalary(snippets);
  if (!ctx.workMode) ctx.workMode = pickWorkMode(snippets);
  if (!ctx.employmentType) ctx.employmentType = pickEmployment(snippets);
  ctx.jobUrl = location.href;
  ctx.externalId = getExternalId();
  ctx.source = 'Generic';
  return ctx;
}

export function isApplyDialogOpen() {
  return Boolean(document.querySelector('form[action*="apply" i], [class*="application-form"], #application-form'));
}
export function isSubmissionConfirmed() {
  const body = (document.body.textContent || '').slice(0, 5000);
  return /thank you for applying|application received|your application has been submitted|application sent/i.test(body);
}
export function isSubmitClick(el) {
  const t = (el.textContent || '').trim();
  return /^submit application$/i.test(t) || /^submit$/i.test(t);
}
export function isApplyClick(el) {
  const t = (el.textContent || '').trim();
  return /^apply\b/i.test(t);
}
export const submitClickSelectors = ['button[type="submit"]', 'button'];
