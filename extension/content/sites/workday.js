// Workday hints — heavy shadow DOM + stable data-automation-id attributes.

import { qs, compactText } from '../lib/dom.js';

export default {
  id: 'workday',
  match: (h) => /myworkdayjobs\.com$|myworkdaysite\.com$/.test(h),

  getContext() {
    const title =
      compactText(qs('[data-automation-id="jobPostingHeader"]')?.textContent) ||
      compactText(qs('h1[data-automation-id]')?.textContent) || '';
    // Company is usually the tenant — derive from hostname subdomain.
    const sub = location.hostname.split('.')[0];
    const company = sub && sub !== 'www' ? sub.replace(/-/g, ' ') : '';
    const locationTxt =
      compactText(qs('[data-automation-id="locations"] dd')?.textContent) ||
      compactText(qs('[data-automation-id="location"]')?.textContent) || '';
    if (!title) return null;
    return { title, company, location: locationTxt };
  },

  isSubmitHint(txt, el) {
    if (/^(submit|soumettre)$/i.test(txt.trim())) return true;
    const auto = el?.getAttribute?.('data-automation-id') || '';
    return /bottom-navigation-(next|submit)-button/.test(auto) && /submit/i.test(txt);
  },

  stepAdvanceSelector: '[data-automation-id="bottom-navigation-next-button"]',
  fileInputSelector: '[data-automation-id="file-upload-input-ref"]',
};
