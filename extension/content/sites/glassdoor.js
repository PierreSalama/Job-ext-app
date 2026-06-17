// Glassdoor hints — covers the job-listing / overview pages and the Easy-Apply dialog.
// Glassdoor's "Easy Apply" stays in-page (a modal); "Apply on company site" hands off to an
// external ATS — the existing handoff/external path (detector.js + classifyAts on the
// destination) takes that, so this pack only contributes selector hints + submit detection.
// Selectors rot; every lookup is multi-fallback and the generic pipeline still runs under it.

import { qs, compactText } from '../lib/dom.js';

export default {
  id: 'glassdoor',
  match: (h) => /glassdoor\.([a-z.]+)$/.test(h),

  getContext() {
    const title =
      compactText(qs('[data-test="job-title"]')?.textContent) ||
      compactText(qs('[data-test="jobTitle"]')?.textContent) ||
      compactText(qs('.JobDetails_jobTitle__ , .css-17x2pwl')?.textContent) ||
      compactText(qs('h1[id^="jd-job-title"]')?.textContent) ||
      compactText(qs('h1')?.textContent) || '';
    const company =
      compactText(qs('[data-test="employer-name"]')?.textContent) ||
      compactText(qs('[data-test="employerName"]')?.textContent) ||
      compactText(qs('.EmployerProfile_employerName__ , .css-16nw49e')?.textContent) ||
      compactText(qs('[class*="employerName" i]')?.textContent) || '';
    const location =
      compactText(qs('[data-test="location"]')?.textContent) ||
      compactText(qs('[data-test="emp-location"]')?.textContent) ||
      compactText(qs('[class*="location" i]')?.textContent) || '';
    if (!title && !company) return null;
    return { title, company, location };
  },

  // The in-page Easy-Apply modal (and the legacy iframe-hosted apply form).
  dialogSelector: '[data-test="ApplyModal"], [class*="JobApply"], [role="dialog"][aria-modal="true"], iframe[id*="apply" i]',

  isSubmitHint(txt) {
    return /submit (your )?application|apply now\b/i.test(txt);
  },

  // Easy-Apply resume picker cards (when Glassdoor reuses a previously-uploaded resume).
  resumeNameSelectors: [
    '[data-test="resume-name"]',
    '[class*="resumeName" i]',
    '[class*="fileName" i]',
  ],
};
