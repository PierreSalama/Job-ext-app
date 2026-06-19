// JAT v11 — Account-walled ATS hint-packs (Workday, iCIMS, Taleo).
//
// These platforms gate the application behind a candidate account / login, so
// there is no honest way to auto-submit. The old generic loop brute-forced them
// (clicking "Apply" 40× on Workday/BMO, stalling on login walls). Each adapter
// here carries account:'required', which tells the executor to PARK
// (awaiting_input) with a human-readable parkReason instead of driving the form.
//
// Evidence: docs/EXTERNAL-ATS-PLAYBOOK.md (live recon 2026-06-19).
// Unlike the other sites/*.js packs this module exports an ARRAY of adapters.

import { qs, compactText } from '../lib/dom.js';

// ── Workday — *.myworkdayjobs.com ─────────────────────────────────────────────
// Heavy shadow DOM + stable data-automation-id. Apply → "Autofill with Resume" /
// "Apply Manually" → "Create Account" or "Sign In". No application without an
// account, so we park BEFORE driving unless an authenticated session form is
// already present.
const workday = {
  id: 'workday',
  match: (h) => /myworkdayjobs\.com$|myworkdaysite\.com$/.test(h),

  account: 'required',
  submitGate: null,
  parkReason: 'Workday account required — sign in once and I will continue',

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

  // Signed-in detection: the create-account / sign-in step exposes signInLink,
  // createAccountLink, or a password field. If NONE of those are present after
  // the apply flow is open, treat the tab as already authenticated and allow the
  // executor to drive the session application form. Default (anything present,
  // or nothing decisive) → park. Pure read of the DOM; guarded.
  isSignedIn() {
    try {
      const wall =
        qs('[data-automation-id="signInLink"]') ||
        qs('[data-automation-id="createAccountLink"]') ||
        qs('input[type="password"]') ||
        qs('[data-automation-id="password"]');
      if (wall) return false;
      // Only consider it a driveable session if an actual application form with
      // fields is already on the page — otherwise we have not opened apply yet.
      const sessionForm =
        qs('[data-automation-id="formField-firstName"]') ||
        qs('[data-automation-id="legalNameSection_firstName"]') ||
        qs('[data-automation-id="quickApplyTitle"]');
      return !!sessionForm;
    } catch {
      return false;
    }
  },

  // Executor consults this: park unless an authenticated session form is up.
  shouldPark() {
    return !this.isSignedIn();
  },

  isSubmitHint(txt, el) {
    if (/^(submit|soumettre)$/i.test(compactText(txt))) return true;
    const auto = el?.getAttribute?.('data-automation-id') || '';
    return /bottom-navigation-(next|submit)-button/.test(auto) && /submit/i.test(txt);
  },

  stepAdvanceSelector: '[data-automation-id="bottom-navigation-next-button"]',
  fileInputSelector: '[data-automation-id="file-upload-input-ref"]',
};

// ── iCIMS — *.icims.com ───────────────────────────────────────────────────────
// Apply routes through /login (seen directly in the reached URLs). No account-
// less path → always park.
const icims = {
  id: 'icims',
  match: (h) => /icims\.com$/.test(h),

  account: 'required',
  submitGate: null,
  parkReason: 'iCIMS account/login required',

  getContext() {
    const title =
      compactText(qs('.iCIMS_Header h1')?.textContent) ||
      compactText(qs('.iCIMS_JobHeader')?.textContent) ||
      compactText(qs('h1')?.textContent) || '';
    const locationTxt =
      compactText(qs('.iCIMS_JobHeaderTag .row .col-xs-12')?.textContent) || '';
    if (!title) return null;
    return { title, company: '', location: locationTxt };
  },

  shouldPark() {
    return true;
  },
};

// ── Taleo — *.taleo.net ───────────────────────────────────────────────────────
// Classic Oracle Taleo requires a candidate account before applying → park.
const taleo = {
  id: 'taleo',
  match: (h) => /taleo\.net$/.test(h),

  account: 'required',
  submitGate: null,
  parkReason: 'Taleo account/login required',

  getContext() {
    const title =
      compactText(qs('.titlepage')?.textContent) ||
      compactText(qs('#requisitionDescriptionInterface\\.reqTitleLinkAction\\.row1')?.textContent) ||
      compactText(qs('h1')?.textContent) || '';
    if (!title) return null;
    return { title, company: '', location: '' };
  },

  shouldPark() {
    return true;
  },
};

export const wallAdapters = [workday, icims, taleo];
export default wallAdapters;
