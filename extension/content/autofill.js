// Universal autofill + answer-learning engine.
// Used by universal.js — runs on every supported job site.
//
// Two-way:
//  1) When the user is filling an application form, we suggest known answers
//     (from profile + qa store) and offer to fill them.
//  2) When the user submits / leaves the form, we record every (label, value)
//     pair into the qa store so it autofills next time. Works in any language —
//     the qa key is normalized lowercase / accent-stripped.

const PROFILE_PATTERNS = [
  // [regex matched against label text, profile field, language hints]
  [/(first.*name|given.*name|prénom|prenom|nombre|vorname|名)/i, 'firstName'],
  [/(last.*name|family.*name|surname|nom de famille|apellido|nachname|姓)/i, 'lastName'],
  [/(full.*name|legal.*name|^name$|nom complet|nombre completo|姓名)/i, 'fullName'],
  [/(preferred.*name|nickname|pronom|prefer.*to.*be.*called)/i, 'preferredName'],
  [/(pronoun|pronouns)/i, 'pronouns'],
  [/(email|courriel|correo|e-mail|mail)/i, 'email'],
  [/(phone|mobile|cell|téléphone|telefono|telefon|電話)/i, 'phone'],
  [/(address.*2|apartment|unit|suite|appartement)/i, 'address2'],
  [/(address|street|adresse|dirección|adresse)/i, 'address1'],
  [/(city|ville|ciudad|stadt|市)/i, 'city'],
  [/(province|state|région|estado|bundesland|州)/i, 'state'],
  [/(postal|zip|code postal|código postal|plz)/i, 'postalCode'],
  [/(country|pays|país|land|国)/i, 'country'],
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
  [/(headline|title)/i, 'headline'],
  [/(summary|profile|resume|brief|cover|about you)/i, 'summary'],
  [/(citizen|citizenship|citoyen|ciudadanía)/i, 'citizenship'],
  [/(security.*clearance|habilitation)/i, 'securityClearance'],
];

function stripAccents(s) {
  try { return s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch { return s; }
}

function fieldLabel(input) {
  // Many strategies — prefer the first non-empty
  const sources = [
    input.closest('label')?.textContent,
    input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent : '',
    input.getAttribute('aria-label'),
    input.getAttribute('aria-labelledby') ? document.getElementById(input.getAttribute('aria-labelledby'))?.textContent : '',
    input.closest('[role="group"]')?.querySelector('label, [class*="label"], [class*="Label"]')?.textContent,
    input.previousElementSibling?.textContent,
    input.parentElement?.querySelector('label, [class*="label"], [class*="Label"]')?.textContent,
    input.placeholder,
    input.name,
  ];
  const raw = sources.filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
  // Append accent-stripped variant so patterns match either form
  return raw + ' ' + stripAccents(raw);
}

function profileFieldFor(label, profile) {
  for (const [rx, field] of PROFILE_PATTERNS) {
    if (rx.test(label) && profile[field]) return { field, value: profile[field] };
  }
  return null;
}

function isFillable(input) {
  if (!input) return false;
  if (input.disabled || input.readOnly) return false;
  if (input.type && ['hidden', 'file', 'submit', 'button', 'image', 'reset'].includes(input.type)) return false;
  // Skip search/captcha/cardnumber inputs to be safe
  const id = (input.id || '') + ' ' + (input.name || '') + ' ' + (input.placeholder || '');
  if (/captcha|recaptcha|cardnumber|cvv|cvc|password/i.test(id)) return false;
  return true;
}

export class AutofillEngine {
  constructor({ getProfile, lookupAnswer, recordAnswer, log }) {
    this.getProfile = getProfile;
    this.lookupAnswer = lookupAnswer;
    this.recordAnswer = recordAnswer;
    this.log = log || (() => {});
    this.suggested = false;
    this.recordedKeys = new Set(); // dedupe within session
  }

  // Scan visible form fields and report fillable suggestions
  async scanFillable(rootEl) {
    const root = rootEl || document;
    const profile = await this.getProfile();
    const inputs = Array.from(root.querySelectorAll('input, textarea, select'));
    const out = [];
    for (const input of inputs) {
      if (!isFillable(input)) continue;
      if (input.value && String(input.value).trim()) continue;
      const label = fieldLabel(input);
      if (!label) continue;
      // Try profile mapping
      const pm = profileFieldFor(label, profile);
      if (pm) { out.push({ input, label, source: 'profile', field: pm.field, value: pm.value }); continue; }
      // Try learned Q&A
      const qa = await this.lookupAnswer(label);
      if (qa?.answer) out.push({ input, label, source: 'qa', value: qa.answer, qa });
    }
    return out;
  }

  fill(suggestions) {
    let n = 0;
    for (const s of suggestions) {
      try {
        const v = String(s.value);
        // For selects: try to match an option
        if (s.input.tagName === 'SELECT') {
          const opt = Array.from(s.input.options).find((o) => o.value === v || o.text === v || o.text.toLowerCase().includes(v.toLowerCase()));
          if (opt) { s.input.value = opt.value; }
          else continue;
        } else if (s.input.type === 'checkbox' || s.input.type === 'radio') {
          const yes = /^(yes|true|y|oui|sí|si|ja)$/i.test(v);
          if (yes) s.input.checked = true;
        } else {
          s.input.value = v;
        }
        s.input.dispatchEvent(new Event('input', { bubbles: true }));
        s.input.dispatchEvent(new Event('change', { bubbles: true }));
        n++;
      } catch {}
    }
    return n;
  }

  // Snapshot current form values -> record in qa store. Call on submit click.
  async captureCurrentAnswers(rootEl, { source, jobId } = {}) {
    const root = rootEl || document;
    const inputs = Array.from(root.querySelectorAll('input, textarea, select'));
    let n = 0;
    for (const input of inputs) {
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
      if (!value) continue;
      // Guard against private values
      if (/^(\*+|•+)$/.test(value)) continue;
      if (input.type === 'password') continue;
      // Skip if the value looks like a number we shouldn't memorize for unrelated fields
      if (value.length > 1500) continue;
      const key = `${source || 'any'}::${label}`;
      if (this.recordedKeys.has(key)) continue;
      this.recordedKeys.add(key);
      await this.recordAnswer({ question: label, answer: value, fieldType: input.type, source, jobId });
      n++;
    }
    return n;
  }

  // Snapshot ALL pre-filled / user-typed values without restricting to "empty fields".
  // Used when the apply dialog opens and the site has already populated the user's
  // info (LinkedIn / Indeed / Workday all do this for known users). We write
  // these into the qa store so we can autofill them on sites that DON'T pre-fill.
  async harvestPrefilledValues(rootEl, { source, jobId } = {}) {
    const root = rootEl || document;
    const inputs = Array.from(root.querySelectorAll('input, textarea, select'));
    let captured = 0;
    for (const input of inputs) {
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
      if (!value || value.length < 1) continue;
      if (/^(\*+|•+)$/.test(value)) continue;
      if (input.type === 'password') continue;
      if (value.length > 1500) continue;
      const key = `${source || 'any'}::${label}::prefill`;
      if (this.recordedKeys.has(key)) continue;
      this.recordedKeys.add(key);
      await this.recordAnswer({ question: label, answer: value, fieldType: input.type, source, jobId });
      captured++;
    }
    return captured;
  }

  // Detect resume / cover-letter file uploads
  detectAttachments(rootEl) {
    const root = rootEl || document;
    const out = [];
    for (const input of root.querySelectorAll('input[type="file"]')) {
      const file = input.files?.[0];
      if (!file) continue;
      const label = fieldLabel(input);
      const isResume = /(resume|cv|curriculum|résumé)/i.test(label) || /(resume|cv)/i.test(file.name);
      const isCover = /(cover.*letter|lettre.*motivation|carta.*presentación)/i.test(label) || /cover[\W_]?letter/i.test(file.name);
      out.push({ name: file.name, sizeBytes: file.size, type: file.type, role: isResume ? 'resume' : (isCover ? 'coverLetter' : 'attachment') });
    }
    return out;
  }
}
