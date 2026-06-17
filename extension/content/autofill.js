// JAT v11 — autofill + answer-learning engine.
// Port of v9's best asset (content/autofill.js) with three upgrades:
//  • shadow-DOM-piercing field scans (Workday) via lib/dom.js
//  • native-setter value injection everywhere (defeats controlled React inputs;
//    v9 only used it in the fallback path)
//  • profile/qa I/O is injected, so the executor wires it to the desktop app's
//    SQLite qa store instead of IndexedDB.

import { qsa, isProbablyVisible } from './lib/dom.js';

export const PROFILE_PATTERNS = [
  [/(first.*name|given.*name|prénom|prenom|nombre|vorname)/i, 'firstName'],
  [/(last.*name|family.*name|surname|nom de famille|apellido|nachname)/i, 'lastName'],
  [/(full.*name|legal.*name|^name$|nom complet|nombre completo)/i, 'fullName'],
  [/(preferred.*name|nickname|prefer.*to.*be.*called)/i, 'preferredName'],
  [/(pronoun|pronouns)/i, 'pronouns'],
  [/(email|courriel|correo|e-mail|mail)/i, 'email'],
  [/(phone|mobile|cell|téléphone|telefono|telefon)/i, 'phone'],
  [/(address.*2|apartment|unit|suite|appartement)/i, 'address2'],
  [/(address|street|adresse|dirección)/i, 'address1'],
  [/(city|ville|ciudad|stadt)/i, 'city'],
  [/(province|state|région|estado|bundesland)/i, 'state'],
  [/(postal|zip|code postal|código postal|plz)/i, 'postalCode'],
  [/(country|pays|país|land)/i, 'country'],
  [/(linkedin)/i, 'linkedinUrl'],
  [/(github)/i, 'githubUrl'],
  [/(portfolio|website|site web|sitio web)/i, 'portfolioUrl'],
  [/(authoriz|eligible.*work|right.*to.*work|autoris)/i, 'workAuthorization'],
  [/(sponsor|visa|sponsorship)/i, 'sponsorshipRequired'],
  [/(salary.*expect|compensation.*expect|expected.*salary|salaire|salario)/i, 'salaryExpectation'],
  [/(year.*experience|years.*of.*exp|expérience|experiencia|years.*exp)/i, 'yearsExperience'],
  [/(notice|start.*date|disponibilité|disponibilidad|earliest)/i, 'noticePeriod'],
  [/(highest.*degree|education.*level|degree)/i, 'highestDegree'],
  [/(university|college|école|universidad|universität)/i, 'university'],
  [/(graduation.*year|year.*graduated|année.*diplôme)/i, 'graduationYear'],
  [/(major|field of study|spécialité)/i, 'major'],
  [/(headline|^title$)/i, 'headline'],
  [/(summary|about you|brief)/i, 'summary'],
  [/(citizen|citizenship|citoyen|ciudadanía)/i, 'citizenship'],
  [/(security.*clearance|habilitation)/i, 'securityClearance'],
];

function stripAccents(s) {
  try { return s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch { return s; }
}

export function fieldLabel(input) {
  const root = input.getRootNode?.() || document;
  const sources = [
    input.closest('label')?.textContent,
    input.id ? root.querySelector?.(`label[for="${cssEscape(input.id)}"]`)?.textContent : '',
    input.getAttribute('aria-label'),
    input.getAttribute('aria-labelledby') ? idRefText(root, input.getAttribute('aria-labelledby')) : '',
    input.closest('[role="group"]')?.querySelector('label, [class*="label"], [class*="Label"]')?.textContent,
    input.previousElementSibling?.textContent,
    input.parentElement?.querySelector('label, [class*="label"], [class*="Label"]')?.textContent,
    input.placeholder,
    input.name,
  ];
  const raw = sources.filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);
  // Return the clean label only. (Previously returned `raw + ' ' + stripAccents(raw)`,
  // which doubled every label — "search" became "search search" — making parked
  // questions read as gibberish to the user AND lowering the AI's answer confidence
  // on real questions. Accent-insensitive matching now happens at the match site,
  // profileFieldFor(), instead of being baked into the label string.)
  return raw;
}

function idRefText(root, ids) {
  return String(ids || '').split(/\s+/)
    .map((id) => root.getElementById?.(id)?.textContent || '')
    .join(' ').trim();
}

// The QUESTION for a radio group — NOT the per-option "Yes"/"No" label. LinkedIn/
// Greenhouse render Yes/No screening questions as a <fieldset><legend>question</legend>
// (or a [role="radiogroup"]/[role="group"] with aria-label/labelledby), and each radio's
// own <label> is just "Yes"/"No". Using fieldLabel(input) there returns "yes" (3 chars),
// which scanUnknown drops (length<4) → the question is never asked → stuck on Review.
// Walk up to the group to recover the real question text.
export function radioGroupLabel(input) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const fs = input.closest?.('fieldset');
  if (fs) {
    const lg = norm(fs.querySelector?.('legend')?.textContent);
    if (lg.length >= 4) return lg;
  }
  const grp = input.closest?.('[role="radiogroup"], [role="group"], [data-test-form-builder-radio-button-form-component], fieldset');
  if (grp) {
    const al = norm(grp.getAttribute?.('aria-label'));
    if (al.length >= 4) return al;
    const lb = grp.getAttribute?.('aria-labelledby');
    if (lb) { const t = norm(idRefText(grp.getRootNode?.() || document, lb)); if (t.length >= 4) return t; }
    const lab = norm(grp.querySelector?.('legend, [class*="fb-dash-form-element__label"], label, [class*="label"], [class*="Label"]')?.textContent);
    if (lab.length >= 4) return lab;
  }
  return '';
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1');
}

// Site chrome that must NEVER be filled: the global search bar / typeahead and anything
// living in the page header/nav. Root cause of the "executor types into LinkedIn's global
// search bar (value '0')" bug — a broad fill root (dialog || detectApplyForm container)
// can include the site header before the apply modal opens. Shared by scanFillable,
// scanUnknown, fill(), and fillCombobox so the guard is enforced consistently everywhere.
// Defensive: any error → false (don't let a guard exception block real fills).
const SITE_CHROME_SEL = 'header, nav, [role="banner"], [role="navigation"], [class*="global-nav"], [id*="global-nav"], [class*="search-global"], [class*="typeahead"][class*="search"], [data-test-global-nav], #global-nav, .search-global-typeahead';
export function isSiteChromeInput(input) {
  try {
    if (!input) return false;
    // 1) It's a search box.
    if (input.type === 'search') return true;
    const role = input.getAttribute?.('role');
    const label = fieldLabel(input);
    if (role === 'combobox' && /^\s*search\b/i.test(label)) return true;
    if (/^\s*search(\s+search)*\s*$/i.test(label)) return true;
    // 2) It lives inside site chrome (header/nav/global-nav/global-search typeahead).
    if (input.closest?.(SITE_CHROME_SEL)) return true;
    return false;
  } catch { return false; }
}

function profileFieldFor(label, profile) {
  // Match against both the raw and accent-folded label so French fields (e.g.
  // "prénom") still hit patterns even where only the unaccented form is listed.
  const folded = stripAccents(label);
  // A "how many years / how long / experience with X" question wants a NUMBER — it must
  // NOT be filled with a profile URL/handle that merely mentions X (e.g. "years of
  // experience with GitHub" was grabbing the GitHub URL → "Invalid input"). Skip URL
  // fields for these; the AI estimates the years from the resume instead.
  const wantsQuantity = /\b(how many|how long|years?|number of|combien|nombre d)\b/i.test(label) || /\byears?\b/i.test(folded);
  for (const [rx, field] of PROFILE_PATTERNS) {
    if (wantsQuantity && /Url$/.test(field)) continue;
    // Only scalar profile values are fillable — never stringify an array/object
    // (e.g. workHistory) into a form field.
    if ((rx.test(label) || rx.test(folded)) && profile[field] != null && profile[field] !== '' && typeof profile[field] !== 'object') {
      return { field, value: profile[field] };
    }
  }
  return null;
}

// EEO / demographic / criminal-history fields are NEVER auto-filled, escalated to AI,
// or harvested — regardless of settings (legal/ethical). Mirrors executor.js.
export const NEVER_AUTOFILL_RX = /(ethnic|race|gender|disabilit|veteran|criminal|background.?check|felony|conviction|pronoun|sexual.?orientation|\blgbtq?)/i;

export function isFillable(input) {
  if (!input) return false;
  if (input.disabled || input.readOnly) return false;
  if (input.type && ['hidden', 'file', 'submit', 'button', 'image', 'reset'].includes(input.type)) return false;
  if (!isProbablyVisible(input)) return false;
  const id = (input.id || '') + ' ' + (input.name || '') + ' ' + (input.placeholder || '');
  if (/captcha|recaptcha|cardnumber|cvv|cvc|password/i.test(id)) return false;
  if (NEVER_AUTOFILL_RX.test(id)) return false;
  if (input.type === 'password') return false;
  return true;
}

// ---- résumé upload detection (B4: Glassdoor / external company-site uploads) ----
// Affordance text/attrs that mean "this is the résumé/CV upload control". Broad on
// purpose: Glassdoor & many ATS hide the real <input type=file> behind a styled
// "Upload resume" / "Attach resume" button, so the resume-ish text is on a sibling and
// the input itself may have no label. PURE (string + attrs only) so it's node-testable.
export const RESUME_HINT_RX = /(resume|résumé|\bcv\b|curriculum|upload.*\b(resume|cv|file|document)\b|attach.*\b(resume|cv|file)\b|joindre|téléverser|drag.*drop|choose file|select file|\.pdf|\.docx?)/i;
export const DOC_ACCEPT_RX = /(pdf|msword|officedocument|\.docx?|\.pdf|\.rtf|\.txt)/i;

// isResumeFileInput(input, ctxText) — does this file input look like the résumé upload?
// `ctxText` is the surrounding affordance text (label + nearby button/dropzone), lowered
// by the caller. Matches on that text OR a document-typed `accept` attribute. Hidden
// inputs still qualify (custom widgets hide the real input) — visibility is the caller's
// call. Guarded: any error → false.
export function isResumeFileInput(input, ctxText = '') {
  try {
    if (!input) return false;
    const accept = (input.getAttribute?.('accept') || '');
    return RESUME_HINT_RX.test(ctxText || '') || DOC_ACCEPT_RX.test(accept);
  } catch { return false; }
}

// Pick the best <option> for a value, preferring exactness over substring so
// '5' selects '5+ years' / '5-10 years' (longest containing match), never the
// first DOM-order option that merely contains the digit ('3-5 years').
export function matchOption(select, v) {
  const opts = Array.from(select.options);
  const vl = String(v).toLowerCase();
  const exact = opts.find((o) => o.value === v || o.text === v)
    || opts.find((o) => o.value.toLowerCase() === vl || o.text.toLowerCase().trim() === vl);
  if (exact) return exact;
  // Numeric answer (years-of-experience, salary band) → pick the option whose RANGE
  // contains it, so '6' selects '5-10 years' not '16+ years' by accidental substring.
  const ni = numericMatch(opts.map((o) => o.text), v);
  if (ni != null) return opts[ni];
  return opts
    .filter((o) => o.text.toLowerCase().includes(vl) || o.value.toLowerCase().includes(vl))
    .sort((a, b) => b.text.length - a.text.length)[0]
    || null;
}

// If `value` is a bare number (optionally $/years/k), return the INDEX of the label
// whose numeric range contains it (tightest range wins; "N+" thresholds pick the
// largest floor ≤ value). Returns null for non-numeric answers so prose is untouched.
export function numericMatch(labels, value) {
  const s = String(value).trim();
  if (!/^\$?\s*\d[\d,.]*\s*\+?\s*(years?|yrs?|k)?\.?$/i.test(s)) return null;
  const n = Number(s.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return null;
  let inRange = -1, span = Infinity, plus = -1, plusLo = -Infinity;
  labels.forEach((raw, i) => {
    const t = String(raw).replace(/,/g, '');
    let m;
    if ((m = t.match(/(\d+(?:\.\d+)?)\s*(?:[-–—]|to)\s*(\d+(?:\.\d+)?)/i))) {
      const lo = +m[1], hi = +m[2];
      if (n >= lo && n <= hi && (hi - lo) < span) { inRange = i; span = hi - lo; }
    } else if ((m = t.match(/(\d+(?:\.\d+)?)\s*\+/))) {
      const lo = +m[1];
      if (n >= lo && lo > plusLo) { plusLo = lo; plus = i; }
    }
  });
  return inRange >= 0 ? inRange : (plus >= 0 ? plus : null);
}

// Pick the radio in `input`'s group whose LABEL best matches the answer value — the
// radio analogue of matchOption (years-of-experience, work-authorization, and salary
// bands are radio groups, so a confident AI answer like "5-7 years" must select the
// matching option, not be discarded by the old yes/no-only check).
export function pickRadioInGroup(input, v) {
  let group;
  try {
    group = input.name
      ? Array.from((input.getRootNode() || document).querySelectorAll(`input[type="radio"][name="${CSS.escape(input.name)}"]`))
      : [input];
  } catch { group = [input]; }
  if (!group.length) return null;
  const vl = String(v).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!vl) return null;
  const labelled = group
    .map((r) => ({ r, lbl: String(fieldLabel(r) || r.value || '').toLowerCase().replace(/\s+/g, ' ').trim() }))
    .filter((x) => x.lbl);
  const hit = labelled.find((x) => x.lbl === vl)
    || labelled.filter((x) => x.lbl.includes(vl) || vl.includes(x.lbl)).sort((a, b) => b.lbl.length - a.lbl.length)[0]
    || null;
  return hit ? hit.r : null;
}

// React-proof value injection.
export function setNativeValue(el, value) {
  try {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  } catch { el.value = value; }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// Fill custom comboboxes / typeaheads / react-selects (Workday, Greenhouse, Lever, and
// LinkedIn's own dropdowns INCLUDING the "Location (city)" typeahead — the #1 ATS gap).
// You can't just TYPE these: LinkedIn requires you to PICK a suggestion, and that list
// renders ASYNC after typing — so we type, WAIT for the options, then click the match.
// FULLY wrapped: any failure is a no-op (field left for the AI/park path) — never regresses.
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
export async function fillCombobox(el, value) {
  try {
    if (isSiteChromeInput(el)) return false;   // never type into the global search typeahead
    const v = String(value == null ? '' : value).trim();
    if (!v) return false;
    const vl = v.toLowerCase();
    el.focus?.();
    try { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch {}
    try { el.click?.(); } catch {}
    // Typeable combobox/typeahead (location, etc.): type the value to trigger suggestions.
    if (el.tagName === 'INPUT' || el.isContentEditable) {
      try { setNativeValue(el, v); } catch {}
      try { el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: v.slice(-1) })); } catch {}
      try { el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: v.slice(-1) })); } catch {}
    }
    // WAIT (up to ~3.5s) for the option list to render — async typeaheads need this.
    const SEL = '[role="option"], [role="listbox"] li, [class*="typeahead"] [role="option"], [class*="typeahead-result"], .basic-typeahead__selectable, [class*="select__option"], [class*="-option"], li[role="option"]';
    let opts = [];
    for (let i = 0; i < 14; i++) {
      opts = qsa(SEL, document).filter((o) => o && o.offsetParent !== null && (o.textContent || '').trim());
      if (opts.length) break;
      await sleepMs(250);
    }
    const txt = (o) => (o.textContent || '').trim().toLowerCase();
    // exact → the typed text is a prefix of the option (LinkedIn location: "Toronto, ON"
    // → "Toronto, Ontario, Canada") → substring. NO blind first-option pick (would mis-fill
    // a real dropdown like years-of-experience).
    const pick = opts.find((o) => txt(o) === vl)
      || opts.find((o) => txt(o).startsWith(vl) && vl.length > 1)
      || opts.find((o) => vl.startsWith(txt(o)) && txt(o).length > 2)
      || opts.find((o) => txt(o).includes(vl) && vl.length > 2);
    if (!pick) {
      try { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch {}
      return false;
    }
    try { pick.scrollIntoView?.({ block: 'nearest' }); } catch {}
    try { pick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch {}
    try { pick.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch {}
    try { pick.click?.(); } catch {}
    await sleepMs(150);
    return true;
  } catch { return false; }
}

export class AutofillEngine {
  // { getProfile: async ()=>data{}, lookupAnswer: async (label)=>({answer}|null),
  //   recordAnswer: async ({question,answer,fieldType,source,jobId})=>void, log }
  constructor({ getProfile, lookupAnswer, recordAnswer, log }) {
    this.getProfile = getProfile;
    this.lookupAnswer = lookupAnswer;
    this.recordAnswer = recordAnswer;
    this.log = log || (() => {});
    this.recordedKeys = new Set();
  }

  fields(rootEl) {
    // Include custom comboboxes / react-selects ([role=combobox] divs + react-select
    // inputs), not just native controls — these are the required ATS/LinkedIn dropdowns
    // that, left unfilled, made "Review"/"Next" silently refuse to advance (the dominant
    // "stuck on a step" failure). fill() routes them to fillCombobox().
    return qsa('input, textarea, select, [role="combobox"]', rootEl || document);
  }

  // Empty fillable fields + a suggestion for each (profile first, then qa).
  async scanFillable(rootEl) {
    const profile = await this.getProfile();
    const out = [];
    for (const input of this.fields(rootEl)) {
      if (!isFillable(input)) continue;
      if (isSiteChromeInput(input)) continue;   // never touch the global search bar / header chrome
      if (input.tagName !== 'SELECT' && input.value && String(input.value).trim()) continue;
      if (input.tagName === 'SELECT' && input.selectedIndex > 0) continue;
      if ((input.type === 'checkbox' || input.type === 'radio') && input.checked) continue;
      const label = fieldLabel(input);
      if (!label) continue;
      if (NEVER_AUTOFILL_RX.test(label)) continue;
      const pm = profileFieldFor(label, profile || {});
      if (pm) { out.push({ input, label, source: 'profile', field: pm.field, value: pm.value }); continue; }
      const qa = await this.lookupAnswer(label);
      if (qa?.answer) out.push({ input, label, source: 'qa', value: qa.answer, qa });
    }
    return out;
  }

  // Empty fields we have NO answer for — the executor escalates these to AI.
  async scanUnknown(rootEl) {
    const profile = await this.getProfile();
    const out = [];
    const seenRadioGroups = new Set();
    for (const input of this.fields(rootEl)) {
      if (!isFillable(input)) continue;
      if (isSiteChromeInput(input)) continue;   // never surface the global search bar / header chrome
      if (input.type === 'radio') {
        const group = input.name || fieldLabel(input);
        if (seenRadioGroups.has(group)) continue;
        seenRadioGroups.add(group);
        const groupChecked = input.name
          ? qsa(`input[type="radio"][name="${cssEscape(input.name)}"]`, rootEl || document).some((r) => r.checked)
          : input.checked;
        if (groupChecked) continue;
      } else if (input.type === 'checkbox') {
        continue;   // never auto-decide bare checkboxes (consents etc.)
      } else if (input.tagName === 'SELECT') {
        if (input.selectedIndex > 0 && input.value) continue;
      } else if (input.value && String(input.value).trim()) {
        continue;
      }
      // For radios, the per-option <label> is just "Yes"/"No" — use the group's
      // legend/question instead so the screening question is actually surfaced.
      const label = (input.type === 'radio' ? radioGroupLabel(input) : '') || fieldLabel(input);
      if (!label || label.length < 4) continue;
      if (NEVER_AUTOFILL_RX.test(label)) continue;
      // (Generic site-search / global-search typeahead inputs are already skipped above
      // via isSiteChromeInput — they're never a real application question and would
      // falsely park the whole job at submit.)
      if (profileFieldFor(label, profile || {})) continue;
      if (await this.lookupAnswer(label)) continue;
      const required = input.required || input.getAttribute('aria-required') === 'true';
      let options = null;
      if (input.tagName === 'SELECT') {
        options = Array.from(input.options).map((o) => (o.textContent || '').trim()).filter((t) => t && !/^select|^choose|^--/i.test(t)).slice(0, 30);
      } else if (input.type === 'radio' && input.name) {
        options = qsa(`input[type="radio"][name="${cssEscape(input.name)}"]`, rootEl || document)
          .map((r) => fieldLabel(r).split(' ').slice(0, 8).join(' ')).filter(Boolean).slice(0, 12);
      }
      out.push({ input, label: label.slice(0, 250), required, fieldType: input.type || input.tagName.toLowerCase(), options });
    }
    return out;
  }

  async fill(suggestions) {
    let n = 0;
    for (const s of suggestions) {
      try {
        if (isSiteChromeInput(s.input)) continue;   // belt-and-suspenders: never fill site chrome
        const v = String(s.value);
        const isCombo = s.input.getAttribute && (s.input.getAttribute('role') === 'combobox'
          || (s.input.closest && s.input.closest('[class*="select__control"],[class*="react-select"],[class*="-control"],[class*="basic-typeahead"]')));
        if (s.input.tagName === 'SELECT') {
          const opt = matchOption(s.input, v);
          if (!opt) continue;
          setNativeValue(s.input, opt.value);
        } else if (isCombo) {
          // custom dropdown / typeahead (Workday/Greenhouse/Lever/LinkedIn location) — async
          if (!(await fillCombobox(s.input, v))) continue;
        } else if (s.input.type === 'radio') {
          // Radio GROUPS (years-of-experience, work-authorization, salary band) are
          // not yes/no — pick the option in the group whose label best matches the
          // answer. Falls back to the old yes-token behaviour for boolean radios.
          const picked = pickRadioInGroup(s.input, v);
          const target = picked || (/^(yes|true|y|oui|sí|si|ja|1)$/i.test(v) ? s.input : null);
          if (!target) continue;
          target.checked = true;
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (s.input.type === 'checkbox') {
          const yes = /^(yes|true|y|oui|sí|si|ja|1)$/i.test(v);
          if (!yes) continue;
          s.input.checked = true;
          s.input.dispatchEvent(new Event('input', { bubbles: true }));
          s.input.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          setNativeValue(s.input, v);
        }
        n++;
      } catch {}
    }
    return n;
  }

  // Record every (label, value) pair → qa store. Call on submit / step advance.
  async captureCurrentAnswers(rootEl, { source, jobId } = {}) {
    let n = 0;
    for (const input of this.fields(rootEl)) {
      if (!isFillable(input)) continue;
      if (input.type === 'radio' && !input.checked) continue;   // only the chosen option
      const label = (input.type === 'radio' ? radioGroupLabel(input) : '') || fieldLabel(input);
      if (!label || label.length < 3) continue;
      if (NEVER_AUTOFILL_RX.test(label)) continue;
      let value = '';
      if (input.tagName === 'SELECT') {
        const opt = input.options[input.selectedIndex];
        value = opt ? (opt.text || opt.value) : '';
      } else if (input.type === 'checkbox' || input.type === 'radio') {
        if (!input.checked) continue;
        value = input.value || 'Yes';
      } else {
        value = String(input.value || '').trim();
      }
      if (!value || /^(\*+|•+)$/.test(value) || value.length > 1500) continue;
      const key = `${source || 'any'}::${label}`;
      if (this.recordedKeys.has(key)) continue;
      this.recordedKeys.add(key);
      await this.recordAnswer({ question: label.slice(0, 400), answer: value, fieldType: input.type, source, jobId });
      n++;
    }
    return n;
  }

  // Learn from values the site pre-filled (LinkedIn/Indeed/Workday do this).
  async harvestPrefilledValues(rootEl, opts = {}) {
    return this.captureCurrentAnswers(rootEl, { ...opts, source: (opts.source || 'any') + ':prefill' });
  }
}
