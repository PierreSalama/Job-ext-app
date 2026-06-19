// Ashby hints — jobs.ashbyhq.com. React SPA, NO <form> element.
// The …/application route IS the form (hydrated client-side); the bare job page
// shows an "Apply for this job" link/button that navigates there. Account-less,
// no CAPTCHA → fully drivable. Core fields use stable _systemfield_* names; every
// custom question carries a UUID `name`, so those must be mapped by the label
// element rendered as a SIBLING inside the field group (not <label for>) — the
// generic detector handles that, this pack only sharpens the stable anchors.
// Selectors rot; the generic pipeline still runs under these hints.

import { qs, compactText } from '../lib/dom.js';

export default {
  id: 'ashby',
  match: (h) => /ashbyhq\.com$/.test(h),

  // Account-less, no submit gate — executor may drive to completion.
  account: 'none',
  submitGate: null,

  getContext() {
    // Ashby sets document.title to "<Job Title> @ <Company>" / "<Job Title> - <Company>".
    const docTitle = compactText(document.title)
      .replace(/\s*[@|·\-–—]\s*[^@|·\-–—]+$/, '');
    const title =
      compactText(qs('h1')?.textContent) ||
      docTitle ||
      compactText(document.title) || '';
    // Company is the first path segment after the host: jobs.ashbyhq.com/<company>/...
    const seg = location.pathname.split('/').filter(Boolean)[0] || '';
    const company = /^[\w.-]+$/.test(seg) ? seg.replace(/-/g, ' ') : '';
    const locationTxt =
      compactText(qs('[class*="_location" i]')?.textContent) || '';
    if (!title) return null;
    return { title, company, location: locationTxt };
  },

  // No <form> element exists — target the hydrated application container.
  // NEVER document.body, and NEVER a bare always-present container like `main`:
  // on the BARE job page (before navigation to /application) a `main` exists and
  // would latch haveForm/everHadForm at step 1, suppressing the generic open-path
  // that navigates to the real form. Tight selectors only → packRoot stays null on
  // the bare page so the allowOpen nav opener can reach /application.
  //
  // Ashby ships STABLE semantic class hooks (`ashby-application-form-container`,
  // `ashby-application-form-section-container`) alongside its obfuscated
  // `_jobPostingForm_*` classes, plus a `div#form` wrapper — verified live
  // (jobs.ashbyhq.com/*/application, 2026-06-19). The earlier `[class*="_form"]`
  // matched NONE of these ("_jobPostingForm" has no "_form" substring), so
  // packRoot stayed null and the application form was never scoped → the run
  // failed. Anchor to the semantic hooks (and a name-scoped #form) instead.
  formSelector:
    '.ashby-application-form-container, ' +
    '[class*="_jobPostingForm"], ' +
    '.ashby-application-form-section-container, ' +
    '#form:has(input[name="_systemfield_name"]), ' +
    '[data-testid*="application" i]',

  // Reveal/navigate to the form. The open path already waits for hydration.
  // Idempotent + submit-safe: if we're already on …/application, do nothing and
  // let the present form be filled. If not, and an "Apply for this job"
  // link/button exists, returning false lets the generic nav opener handle it.
  openApply() {
    try {
      if (/\/application(\/|$|\?)/.test(location.pathname + location.search)) {
        return false; // form already present — nothing to open.
      }
      const apply = qs('a[href*="/application" i]');
      if (apply?.href) { return false; } // generic nav handles the href.
    } catch {}
    return false;
  },

  // Core stable system fields (anti-rot anchors for the generic field mapper).
  fieldMap: {
    _systemfield_name: 'fullName',
    _systemfield_email: 'email',
  },
  coreFieldSelectors: {
    name: 'input[name="_systemfield_name"]',
    email: 'input[name="_systemfield_email"]',
  },

  // Resume: real file input (may be hidden — set .files directly). The visible
  // affordance is an "Upload File" button; Ashby also offers an Autofill that
  // parses the resume → re-read fields AFTER upload settles.
  fileInputSelector: 'input[type=file]',
  fileAffordanceSelector: 'button[class*="_upload" i], button',

  isSubmitHint(txt, el) {
    return /submit application/i.test(txt || '') ||
      (el?.matches?.('button[class*="_primary"]') ?? false);
  },

  confirmSignals: [
    /application (submitted|received)/i,
    /thank/i,
    /we received/i,
  ],
};
