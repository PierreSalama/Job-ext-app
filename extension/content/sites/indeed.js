// Indeed hints — covers both the listing pages and smartapply.indeed.com.

import { qs, compactText } from '../lib/dom.js';

export default {
  id: 'indeed',
  match: (h) => /indeed\.([a-z.]+)$/.test(h) || /smartapply\.indeed\.com$/.test(h),

  getContext() {
    const title =
      compactText(qs('[data-testid="jobsearch-JobInfoHeader-title"]')?.textContent) ||
      compactText(qs('h1.jobsearch-JobInfoHeader-title')?.textContent) ||
      compactText(qs('[data-testid="simpler-jobTitle"]')?.textContent) || '';
    const company =
      compactText(qs('[data-testid="inlineHeader-companyName"]')?.textContent) ||
      compactText(qs('[data-company-name="true"]')?.textContent) ||
      compactText(qs('[data-testid="company-name"]')?.textContent) || '';
    const location =
      compactText(qs('[data-testid="inlineHeader-companyLocation"]')?.textContent) ||
      compactText(qs('[data-testid="job-location"]')?.textContent) || '';
    if (!title && !company) return null;
    return { title, company, location };
  },

  dialogSelector: '.ia-Modal, [data-testid="smartapply-container"]',

  isSubmitHint(txt) {
    return /submit your application|review your application/i.test(txt);
  },
};
