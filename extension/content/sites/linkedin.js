// LinkedIn hints. Selectors rot quarterly — every lookup is multi-fallback
// and the generic pipeline still runs underneath.

import { qs, compactText } from '../lib/dom.js';

export default {
  id: 'linkedin',
  match: (h) => /linkedin\.com$/.test(h),

  getContext() {
    const title =
      compactText(qs('.job-details-jobs-unified-top-card__job-title h1')?.textContent) ||
      compactText(qs('.jobs-unified-top-card__job-title')?.textContent) ||
      compactText(qs('h1.t-24')?.textContent) ||
      compactText(qs('.jobs-details-top-card__job-title')?.textContent) || '';
    const company =
      compactText(qs('.job-details-jobs-unified-top-card__company-name a')?.textContent) ||
      compactText(qs('.job-details-jobs-unified-top-card__company-name')?.textContent) ||
      compactText(qs('.jobs-unified-top-card__company-name a')?.textContent) ||
      compactText(qs('a[href*="/company/"]')?.textContent) || '';
    const location =
      compactText(qs('.job-details-jobs-unified-top-card__primary-description-container .tvm__text')?.textContent) ||
      compactText(qs('.jobs-unified-top-card__bullet')?.textContent) || '';
    if (!title && !company) return null;
    return { title, company, location };
  },

  dialogSelector: '.jobs-easy-apply-modal, [data-test-modal][role="dialog"]',

  isSubmitHint(txt) {
    return /submit application/i.test(txt);
  },

  // The Easy Apply resume picker: cards with the previously-uploaded resumes.
  resumeNameSelectors: [
    '.jobs-document-upload__file-name',
    '[data-test-resume-card] .t-14.t-bold',
    '.jobs-resume-picker__resume-label',
  ],
};
