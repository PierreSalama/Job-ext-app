// Lever adapter — jobs.lever.co/{company}/{job-id}
import { genericContextFromJsonLd, text, firstText, find } from './base.js';

export const id = 'lever';
export const name = 'Lever';
export const matches = [/^https?:\/\/jobs\.lever\.co\//i];

export function getExternalId() {
  const m = location.pathname.match(/\/([0-9a-f-]{30,})\b/);
  return m ? m[1] : '';
}

export function getContext() {
  const ctx = genericContextFromJsonLd() || {};
  if (!ctx.title) ctx.title = firstText(['h2.posting-headline h2', '.posting-headline h2', 'h2', 'h1']);
  if (!ctx.company) {
    const m = location.pathname.match(/^\/([^\/]+)/);
    if (m) ctx.company = m[1].replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (!ctx.location) ctx.location = firstText(['.posting-categories .location', '.posting-categories div:nth-child(1)']);
  if (!ctx.employmentType) ctx.employmentType = firstText(['.posting-categories .commitment']);
  if (!ctx.description) ctx.description = (text(find(['.posting-page', '.section-wrapper.page-full-width'])) || '').slice(0, 8000);
  ctx.jobUrl = location.href;
  ctx.externalId = getExternalId();
  ctx.source = 'Lever';
  return ctx;
}

export function isApplyDialogOpen() {
  return Boolean(document.querySelector('#application-form, form[action*="apply"]'));
}
export function isSubmissionConfirmed() {
  return /thank you for applying|application received/i.test((document.body.textContent || '').slice(0, 5000)) ||
    location.pathname.endsWith('/thanks') || location.pathname.endsWith('/applied');
}
export function isSubmitClick(el) {
  const t = (el.textContent || '').trim();
  return /^submit application$/i.test(t) || /^submit$/i.test(t);
}
export function isApplyClick(el) {
  const t = (el.textContent || '').trim();
  return /^apply for this job$/i.test(t) || /^apply\b/i.test(t);
}
export const submitClickSelectors = ['button[type="submit"]', 'button'];
