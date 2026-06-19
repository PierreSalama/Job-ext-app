// Greenhouse hints — job-boards.greenhouse.io (modern) + boards.greenhouse.io
// (legacy) + embedded iframes (the iframe case is why the v11 manifest runs in
// all_frames). Account-less + no submit gate => FULLY AUTO (see EXTERNAL-ATS-PLAYBOOK.md).
//
// Modern GH auto-generates input ids/names, so core fields CANNOT be mapped by
// `name`. Instead we map by the visible <label> text (First Name / Last Name /
// Email / Country / Phone). The resume affordance is a "Attach" pill button but
// the real <input type=file> is hidden — set its `.files` directly.

import { qs, compactText } from '../lib/dom.js';

// Canonical profile key -> regexes that match the visible <label> text. Order
// matters: "Last Name" must be tested before "Name"/"First Name" so the more
// specific label wins. Kept tight to avoid grabbing custom-question labels.
const LABEL_MAP = [
  ['lastName',  /\blast\s*name\b/i],
  ['firstName', /\bfirst\s*name\b/i],
  ['email',     /\be-?mail\b/i],
  ['phone',     /\bphone\b/i],
  ['country',   /\bcountry\b/i],
];

export default {
  id: 'greenhouse',
  match: (h) => /greenhouse\.io$/.test(h),

  // Account-less, no CAPTCHA → executor may drive to completion.
  account: 'none',
  submitGate: null,

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

  // Tight application container — NEVER document.body. Modern uses
  // #application-form, legacy uses #application_form, some themes .application--form.
  formSelector: '#application-form, #application_form, .application--form',

  // The form is embedded on the job page (single page). Some themes show an
  // "Apply" pill that just scrolls to the form. Idempotent + never submits:
  // returns true only if it acted (clicked an opener / scrolled the form in).
  openApply() {
    try {
      // If the form is already present, just ensure it's in view.
      const form = qs(this.formSelector);
      if (form) {
        form.scrollIntoView?.({ block: 'start' });
        return false; // form already revealed; we didn't navigate/open anything
      }
      // Some themes gate the form behind an "Apply" pill that scrolls to it.
      const pills = document.querySelectorAll('a.btn--pill, button.btn--pill, a[href*="#app"], #apply_button');
      for (const el of pills) {
        const t = compactText(el.textContent);
        if (/^apply\b/i.test(t) && !/submit/i.test(t)) {
          el.click();
          return true;
        }
      }
    } catch {}
    return false;
  },

  // Map a field's <input>/<select> element to a canonical profile key using its
  // visible <label> text (modern GH ids are auto-generated and useless). Returns
  // null when the field is a custom question / unmappable.
  //
  // GUARDS (found by live recon 2026-06-19 against StackAdapt's GH form): a core
  // identity label is SHORT ("First Name", "Email", "Country"). Custom-question
  // labels are long sentences that merely CONTAIN a keyword — e.g. "…require
  // sponsorship to work in this country?" must NOT map to `country`, and
  // "Preferred First Name" must NOT map to `firstName`. So: reject long labels,
  // and exclude the preferred/middle variants from the name keys.
  fieldKeyFor(el) {
    const txt = labelTextFor(el);
    if (!txt) return null;
    // Core identity labels are short; a long label is a custom question.
    if (txt.replace(/\*\s*$/, '').trim().length > 22) return null;
    if (/\bpreferred\b|\bmiddle\b|\bmaiden\b/i.test(txt)) return null;
    for (const [key, re] of LABEL_MAP) {
      if (re.test(txt)) return key;
    }
    return null;
  },

  // EEO / demographic questions ([id*=demographic]) are optional — the engine
  // may skip them (leave blank / Decline to self-identify).
  isOptionalField(el) {
    if (!el) return false;
    const id = el.id || '';
    if (/demographic/i.test(id)) return true;
    const wrap = el.closest?.('[id*="demographic"], [class*="demographic"]');
    return !!wrap;
  },

  // Greenhouse has no honeypot fields in the recon, but keep the hook so the
  // executor can call it uniformly across adapters.
  isHoneypot() {
    return false;
  },

  // Resume <input id=resume> + cover letter <input id=cover_letter>; both hidden.
  // The visible affordance is button.btn--pill "Attach" — set `.files` directly.
  fileInputSelector: '#resume, #cover_letter, input[type="file"]',
  fileAffordanceSelector: 'button.btn--pill',

  isSubmitHint(txt, el) {
    return el?.id === 'submit_app' ||
      (el?.matches?.('button[type="submit"].btn--pill') ?? false) ||
      /submit application/i.test(txt || '');
  },

  // Single-page form — no multi-step Next/Continue.
  advanceSelector: null,

  confirmSignals: [
    /application\s+(submitted|received)/i,
    /thank you for applying/i,
  ],
};

// --- helpers (pure-ish; all DOM access guarded) -----------------------------

// Resolve the visible label text for a field element. Modern GH wraps each
// field as <label><span>First Name *</span><input ...></label> OR uses
// <label for="<id>">; legacy uses <label for>. Fall back to aria-label.
function labelTextFor(el) {
  if (!el) return '';
  try {
    // 1) <label for="id">
    if (el.id) {
      const lbl = el.ownerDocument?.querySelector?.(`label[for="${cssEscape(el.id)}"]`);
      const t = labelOwnText(lbl);
      if (t) return t;
    }
    // 2) wrapping <label> ancestor
    const wrap = el.closest?.('label');
    const wt = labelOwnText(wrap);
    if (wt) return wt;
    // 3) a <label> sibling within the same field group
    const group = el.closest?.('.field, [class*="field"], [class*="form-field"]');
    const groupLbl = group?.querySelector?.('label');
    const gt = labelOwnText(groupLbl);
    if (gt) return gt;
    // 4) aria-label / aria-labelledby / placeholder
    const aria = el.getAttribute?.('aria-label');
    if (aria) return compactText(aria);
    const labelledby = el.getAttribute?.('aria-labelledby');
    if (labelledby) {
      const ref = el.ownerDocument?.getElementById?.(labelledby.split(/\s+/)[0]);
      const rt = compactText(ref?.textContent);
      if (rt) return rt;
    }
  } catch {}
  return '';
}

// A <label> may contain the field itself (wrapping pattern); strip nested
// input/select/textarea text and the trailing required asterisk.
function labelOwnText(lbl) {
  if (!lbl) return '';
  try {
    const clone = lbl.cloneNode(true);
    clone.querySelectorAll?.('input, select, textarea').forEach((n) => n.remove());
    return compactText(clone.textContent).replace(/\*\s*$/, '').trim();
  } catch {
    return compactText(lbl.textContent).replace(/\*\s*$/, '').trim();
  }
}

// Minimal CSS.escape fallback for attribute-selector ids (auto-generated GH ids
// are safe, but guard against colons/brackets just in case).
function cssEscape(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/["\\\]#.:>+~*^$|=()[\s]/g, '\\$&');
}
