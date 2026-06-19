// Lever hints — jobs.lever.co postings + /apply forms.
// Account-less, no submit gate: a fully-auto platform (see EXTERNAL-ATS-PLAYBOOK).
// The /apply URL *is* the single-page form; the job page exposes an
// "Apply for this job" link (a.postings-btn) that the generic open path follows.

import { qs, compactText } from '../lib/dom.js';

export default {
  id: 'lever',
  match: (h) => /lever\.co$/.test(h),

  account: 'none',
  submitGate: null,

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

  // Tight application container — never document.body.
  formSelector: 'form[action*="/apply"], .application-form, #application-form',

  // The /apply URL already renders the form, so on /apply there is nothing to
  // open — return false (no-op). Off the /apply form, the generic open path
  // follows a.postings-btn ("Apply for this job") to …/apply, so openApply
  // stays a safe no-op here too. Idempotent, never submits.
  openApply() {
    return false;
  },

  // Lever's manual form has no honeypot fields.
  isHoneypot() {
    return false;
  },

  isSubmitHint(txt, el) {
    return /submit application/i.test(txt) ||
      (el?.matches?.('button.template-btn-submit') ?? false);
  },

  // Resume <input type=file>; Lever auto-parses it to pre-fill, so re-read
  // fields after the upload settles.
  fileInputSelector: '#resume-upload-input, input[name=resume]',

  confirmSignals: [
    /application (received|submitted)/i,
    /thank you for applying/i,
    /we'?ll be in touch/i,
  ],
};
