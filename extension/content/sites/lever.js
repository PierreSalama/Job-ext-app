// Lever hints — jobs.lever.co postings + /apply forms.

import { qs, compactText } from '../lib/dom.js';

export default {
  id: 'lever',
  match: (h) => /lever\.co$/.test(h),

  getContext() {
    const title =
      compactText(qs('.posting-headline h2')?.textContent) ||
      compactText(qs('.posting-header h2')?.textContent) || '';
    // Company from the subdomain: jobs.lever.co/<company>/... uses path instead.
    const seg = location.pathname.split('/').filter(Boolean)[0] || '';
    const company = /^[\w-]+$/.test(seg) ? seg.replace(/-/g, ' ') : '';
    const locationTxt =
      compactText(qs('.posting-categories .location')?.textContent) ||
      compactText(qs('.sort-by-time.posting-category')?.textContent) || '';
    if (!title) return null;
    return { title, company, location: locationTxt };
  },

  formSelector: '#application-form, .application-form',

  isSubmitHint(txt, el) {
    return /submit application/i.test(txt) ||
      (el?.matches?.('button[type="submit"].template-btn-submit') ?? false);
  },
};
