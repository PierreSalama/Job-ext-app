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

  // The /apply URL already renders the form, so on /apply there is nothing to open.
  // OFF the form (the job-description page), the CTA is a PLAIN anchor (a.postings-btn,
  // "Apply for this job") — which the generic advance scanner never considered (it only
  // enumerates button/[role=button]), so the child used to stall at "no generic advance
  // found" and fail with everHadForm=false. CLICK that visible apply link to navigate to
  // …/apply where the form renders. Idempotent (no-op once the form is present) and never
  // a submit. This is the legitimate Apply CTA — no CAPTCHA/bot-detection interaction.
  openApply() {
    if (qs(this.formSelector)) return false;          // form already on the page → nothing to open
    const a = qs('a.postings-btn, a[href*="/apply"]');
    if (!a) return false;
    const label = compactText(a.textContent) || '';
    if (/submit/i.test(label)) return false;          // never click a submit control
    a.click();
    return true;
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
