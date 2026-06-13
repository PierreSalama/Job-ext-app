// Greenhouse hints — both boards.greenhouse.io and embedded iframes
// (the iframe case is why the v11 manifest runs in all_frames).

import { qs, compactText } from '../lib/dom.js';

export default {
  id: 'greenhouse',
  match: (h) => /greenhouse\.io$/.test(h),

  getContext() {
    const title =
      compactText(qs('.app-title')?.textContent) ||
      compactText(qs('h1.section-header')?.textContent) ||
      compactText(qs('.job__title h1')?.textContent) || '';
    const company =
      compactText(qs('.company-name')?.textContent).replace(/^at\s+/i, '') ||
      compactText(qs('.job__company')?.textContent) || '';
    const locationTxt =
      compactText(qs('.location')?.textContent) ||
      compactText(qs('.job__location')?.textContent) || '';
    if (!title) return null;
    return { title, company, location: locationTxt };
  },

  formSelector: '#application_form, #application-form, .application--form',

  isSubmitHint(txt, el) {
    return el?.id === 'submit_app' || /submit application/i.test(txt);
  },
};
