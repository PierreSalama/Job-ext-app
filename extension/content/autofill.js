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
  return raw + ' ' + stripAccents(raw);
}

function idRefText(root, ids) {
  return String(ids || '').split(/\s+/)
    .map((id) => root.getElementById?.(id)?.textContent || '')
    .join(' ').trim();
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1');
}

function profileFieldFor(label, profile) {
  for (const [rx, field] of PROFILE_PATTERNS) {
    if (rx.test(label) && profile[field] != null && profile[field] !== '') {
      return { field, value: profile[field] };
    }
  }
  return null;
}

export function isFillable(input) {
  if (!input) return false;
  if (input.disabled || input.readOnly) return false;
  if (input.type && ['hidden', 'file', 'submit', 'button', 'image', 'reset'].includes(input.type)) return false;
  if (!isProbablyVisible(input)) return false;
  const id = (input.id || '') + ' ' + (input.name || '') + ' ' + (input.placeholder || '');
  if (/captcha|recaptcha|cardnumber|cvv|cvc|password/i.test(id)) return false;
  if (input.type === 'password') return false;
  return true;
}

// Pick the best <option> for a value, preferring exactness over substring so
// '5' selects '5+ years' / '5-10 years' (longest containing match), never the
// first DOM-order option that merely contains the digit ('3-5 years').
export function matchOption(select, v) {
  const opts = Array.from(select.options);
  const vl = String(v).toLowerCase();
  return opts.find((o) => o.value === v || o.text === v)
    || opts.find((o) => o.value.toLowerCase() === vl || o.text.toLowerCase().trim() === vl)
    || opts
      .filter((o) => o.text.toLowerCase().includes(vl) || o.value.toLowerCase().includes(vl))
      .sort((a, b) => b.text.length - a.text.length)[0]
    || null;
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
    return qsa('input, textarea, select', rootEl || document);
  }

  // Empty fillable fields + a suggestion for each (profile first, then qa).
  async scanFillable(rootEl) {
    const profile = await this.getProfile();
    const out = [];
    for (const input of this.fields(rootEl)) {
      if (!isFillable(input)) continue;
      if (input.tagName !== 'SELECT' && input.value && String(input.value).trim()) continue;
      if (input.tagName === 'SELECT' && input.selectedIndex > 0) continue;
      if ((input.type === 'checkbox' || input.type === 'radio') && input.checked) continue;
      const label = fieldLabel(input);
      if (!label) continue;
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
      const label = fieldLabel(input);
      if (!label || label.length < 4) continue;
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

  fill(suggestions) {
    let n = 0;
    for (const s of suggestions) {
      try {
        const v = String(s.value);
        if (s.input.tagName === 'SELECT') {
          const opt = matchOption(s.input, v);
          if (!opt) continue;
          setNativeValue(s.input, opt.value);
        } else if (s.input.type === 'checkbox' || s.input.type === 'radio') {
          const yes = /^(yes|true|y|oui|sí|si|ja)$/i.test(v);
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
      const label = fieldLabel(input);
      if (!label || label.length < 3) continue;
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
