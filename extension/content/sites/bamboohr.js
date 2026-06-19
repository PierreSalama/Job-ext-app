// BambooHR hints — *.bamboohr.com/careers/<id>.
// ⚠️ CAPTCHA-gated: a reCAPTCHA "I'm not a robot" sits above the submit button,
// so the executor FILLS the whole form then PARKS for a human to solve + submit.
// Never auto-solve the CAPTCHA. Evidence: docs/EXTERNAL-ATS-PLAYBOOK.md (BambooHR).

import { qs, compactText } from '../lib/dom.js';

// Honeypot label/placeholder copy BambooHR uses on its anti-bot trap field.
const HONEYPOT_TEXT_RX = /leave this field blank/i;

export default {
  id: 'bamboohr',
  match: (h) => /bamboohr\.com$/.test(h),

  // Account-less platform, but submit is reCAPTCHA-gated → fill then park.
  account: 'none',
  submitGate: 'captcha',

  getContext() {
    const title =
      compactText(qs('h1.fab-Job__title')?.textContent) ||
      compactText(qs('[class*="Job__title"]')?.textContent) ||
      compactText(qs('h1')?.textContent) || '';
    // Company is the tenant subdomain: <company>.bamboohr.com.
    const sub = location.hostname.split('.')[0];
    const company = sub && sub !== 'www' ? sub.replace(/-/g, ' ') : '';
    const locationTxt =
      compactText(qs('[class*="Job__location"]')?.textContent) ||
      compactText(qs('[class*="location"]')?.textContent) || '';
    if (!title) return null;
    return { title, company, location: locationTxt };
  },

  // Tight application container: the section holding the firstName field; fall
  // back to the dedicated ApplicationForm container. NEVER document.body and NEVER
  // a bare `form` — a stray search/newsletter/locale <form> on the career page
  // would latch haveForm/everHadForm before "Apply for This Job" is clicked,
  // starving openApply() (the only thing that reveals the real application form).
  formSelector:
    'form:has(input[name="firstName"]), ' +
    'fieldset:has(input[name="firstName"]), ' +
    '[class*="ApplicationForm"]',

  // Reveal the form: the job page shows "Apply for This Job"
  // (button.MuiButton-root.fabric); clicking it renders the application form at
  // the BOTTOM of the SAME page (no iframe, no new tab). Idempotent + safe:
  // if the form is already present we do nothing and report no action.
  openApply() {
    // Already revealed → nothing to do.
    if (qs('input[name="firstName"]')) return false;

    const candidates = [
      ...document.querySelectorAll(
        'button.MuiButton-root.fabric, button.MuiButton-root, button, a'
      ),
    ];
    const opener = candidates.find((el) =>
      /apply for this job/i.test(compactText(el.textContent || ''))
    );
    if (!opener) return false;
    try { opener.click(); } catch { return false; }
    return true;
  },

  // Anti-bot trap to SKIP: name starts with "nickname_", OR the field's label /
  // placeholder says "leave this field blank". Filling it flags the application.
  isHoneypot(el) {
    if (!el) return false;
    const name = el.name || el.getAttribute?.('name') || '';
    if (/^nickname_/i.test(name)) return true;
    const placeholder = el.placeholder || el.getAttribute?.('placeholder') || '';
    if (HONEYPOT_TEXT_RX.test(placeholder)) return true;
    // Associated <label for=id> or wrapping <label>.
    try {
      const id = el.id;
      if (id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl && HONEYPOT_TEXT_RX.test(compactText(lbl.textContent))) return true;
      }
      const wrap = el.closest?.('label');
      if (wrap && HONEYPOT_TEXT_RX.test(compactText(wrap.textContent))) return true;
    } catch {}
    const aria = el.getAttribute?.('aria-label') || '';
    if (HONEYPOT_TEXT_RX.test(aria)) return true;
    return false;
  },

  isSubmitHint(txt, el) {
    if (/submit application/i.test(txt || '')) return true;
    const isSubmitBtn = el?.matches?.('button[type="submit"]') ?? false;
    return isSubmitBtn && /submit/i.test(compactText(el?.textContent || ''));
  },

  fileInputSelector: 'input[type=file]',

  confirmSignals: [/application (submitted|received)/i, /thank you/i],
};
