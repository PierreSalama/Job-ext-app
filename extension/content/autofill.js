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

// Placeholder strings that describe the WIDGET, not the question — "Search to select an option",
// "Select…", "Start typing". They must never become a field's label: the answer layer then sees a
// prompt containing no question and refuses (correctly), which parks the whole application.
const GENERIC_PLACEHOLDER_RX = /^\s*(?:search(?:\s+to\s+select(?:\s+an?\s+option)?)?|select(?:\s+an?)?(?:\s+(?:option|answer|one))?|choose(?:\s+an?)?(?:\s+(?:option|one))?|start\s+typing|type\s+to\s+search|please\s+select|-{1,2}\s*select\s*-{0,2}|n\/?a)\s*[.…]{0,3}\s*$/i;
export function isGenericPlaceholder(s) {
  const t = String(s || '').trim();
  if (!t) return true;
  return GENERIC_PLACEHOLDER_RX.test(t);
}

// Map a NUMERIC answer onto a RANGE option. Experience dropdowns are ranges — "Less than 1 year",
// "1-3 years", "5-10 years", "More than 10 years" — while the profile holds a plain number ("6").
// Text matching can never connect the two: "6" is not a substring of "5-10 years", so the field was
// left unselected and the form refused to advance. Returns the index of the option whose range
// contains the number, or -1 when the value is not numeric or no range fits.
// PURE + exported so the arithmetic is node-testable without a DOM.
export function matchNumericRangeOption(value, optionTexts) {
  const raw = String(value == null ? '' : value).trim();
  if (!/^\d{1,2}(?:\.\d+)?$/.test(raw)) return -1;         // only a bare number answers a range
  const n = Number(raw);
  if (!Number.isFinite(n)) return -1;
  const opts = (Array.isArray(optionTexts) ? optionTexts : []).map((t) => String(t || '').toLowerCase());
  let fallbackMax = -1, fallbackMaxVal = -Infinity;
  for (let i = 0; i < opts.length; i++) {
    const t = opts[i];
    if (!t) continue;
    // "less than 1 year" / "under 1 year" / "<1"
    let m = t.match(/(?:less than|under|fewer than|<)\s*(\d{1,2})/);
    if (m && n < Number(m[1])) return i;
    // "more than 10 years" / "over 10" / "10+" / "at least 10"
    m = t.match(/(?:more than|over|at least|>=?|(\d{1,2})\s*\+)\s*(\d{1,2})?/);
    if (m) {
      const bound = Number(m[1] ?? m[2]);
      if (Number.isFinite(bound) && /(?:more than|over|at least|\+|>)/.test(t)) {
        if (n >= bound) { if (bound > fallbackMaxVal) { fallbackMaxVal = bound; fallbackMax = i; } }
        continue;
      }
    }
    // "1-3 years" / "1 to 3 years" / "3 – 5"
    m = t.match(/(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})/);
    if (m) {
      const lo = Number(m[1]), hi = Number(m[2]);
      if (n >= lo && n <= hi) return i;
    }
  }
  return fallbackMax;    // e.g. 12 with options topping out at "more than 10 years"
}

// A text input that is really a SEARCHABLE SELECT: you must type and then PICK an option, and
// typing alone leaves the widget unselected (the form then refuses to advance while the field
// looks filled). Detected from a placeholder that implies CHOOSING — "Search to select an option",
// "Select an option", "Choose one". Deliberately requires select/choose: a bare "Search…" box stays
// plain text, so a real free-text field is never rerouted.
const SEARCHABLE_SELECT_PLACEHOLDER_RX = /\b(?:select|choose|s[ée]lectionn|choisir)\b/i;
export function looksLikeSearchableSelect(input) {
  try {
    if (!input || input.tagName !== 'INPUT') return false;
    const type = String(input.type || 'text').toLowerCase();
    if (type !== 'text' && type !== 'search') return false;
    return SEARCHABLE_SELECT_PLACEHOLDER_RX.test(String(input.placeholder || ''));
  } catch { return false; }
}

// Last-resort label: the real question often sits in an ancestor block ABOVE the widget (the same
// shape as Indeed's stacked labels). Walk up a few levels, strip out nested form controls so we
// read the PROMPT rather than the options, and take the nearest sensible text. Prefers an actual
// question sentence when the block contains one.
// maxUp was 5, which is not deep enough for react-select. Greenhouse nests the role=combobox input
// SEVEN levels below the block holding the question:
//   input → .select__input-container → .select__value-container → .select__control
//         → .select-shell → .select__container → .select → .field-wrapper(question)
// so the walk gave up, fieldLabel returned '', and scanUnknown dropped the field on its
// `label.length < 4` guard — the required screening question was never even surfaced
// (live: `trace:scan fillable=0 … unknown=0` on a form with 5 required questions).
// Depth alone is not safe though: keep climbing and you eventually swallow the whole form and
// blend several questions together. So the walk now stops the moment it leaves THIS field's own
// wrapper — an ancestor containing more than one real control covers several questions. The
// aria-hidden validation sentinel react-select puts beside the combobox is not a real control and
// must not count, or the walk would stop one level short of the question every time.
export function nearestQuestionText(input, maxUp = 8) {
  try {
    let el = input.parentElement;
    for (let i = 0; i < maxUp && el; i++) {
      try {
        const controls = el.querySelectorAll?.('input:not([type="hidden"]):not([aria-hidden="true"]), select, textarea');
        if (controls && controls.length > 1) break;
      } catch { /* keep climbing */ }
      let txt = '';
      try {
        const clone = el.cloneNode(true);
        // Widget chrome is not part of the question. react-select renders its "Select…" prompt as
        // a *div* (.select__placeholder), so element-type stripping alone leaves it glued to the
        // front of the recovered label — "select... do you now, or will you in the future, …".
        // `style`/`script` are stripped for the same reason, and they are not hypothetical: modern
        // Greenhouse (Remix) emits an inline <style> beside its hidden required-input sentinel, so
        // the recovered "label" became a CSS RULE. Captured live 2026-08-13 on the Affirm posting,
        // where the run parked asking the user to answer:
        //   ".remix-css-1a0ro4n-requiredinput{opacity:0;pointer-events:none;position:absolute;…}"
        // textContent includes stylesheet text, so this junk both inflates "needs N answer(s)" and
        // puts unanswerable rubbish in the needs-you queue.
        clone.querySelectorAll?.('input, select, textarea, button, option, style, script, [role="combobox"], [role="listbox"], [role="option"], [class*="placeholder" i]')
          .forEach((n) => n.remove());
        txt = String(clone.textContent || '').replace(/\s+/g, ' ').trim();
      } catch { txt = ''; }
      if (txt && txt.length >= 8 && txt.length <= 220 && !isGenericPlaceholder(txt)) {
        // If the block holds a question, prefer that sentence over surrounding boilerplate.
        const q = txt.match(/[^.?!]*\?/g);
        return (q && q.length ? q[q.length - 1] : txt).trim();
      }
      el = el.parentElement;
    }
  } catch { /* fall through */ }
  return '';
}

// The parent's FIRST label only belongs to this input if the parent wraps THIS FIELD ALONE.
// Lever lays its form out flat — label, input, label, input, … all in one container — so
// `parentElement.querySelector('label')` returned "Full name*" for EVERY field. The profile
// matcher then saw "full name" in each label and filled the applicant's NAME into the email,
// phone and location fields, and the application was submitted that way: the lever fixture passed
// green while sending "Pierre Salama" as the email address. It only surfaced when the native
// validation gate reported the browser's own complaint —
//   "Please include an '@' in the email address. 'Pierre Salama' is missing an '@'."
// Lever has 0 completed applies in production, consistent with sending malformed applications.
// When the container holds several controls, its first label is whichever control comes first,
// not ours — so skip this source and let label[for] / aria-label / previousElementSibling decide.
function perFieldWrapperLabel(input) {
  try {
    const p = input.parentElement;
    if (!p || typeof p.querySelectorAll !== 'function') return null;
    if (p.querySelectorAll('input:not([type="hidden"]), select, textarea').length > 1) return null;
    return p.querySelector('label, [class*="label"], [class*="Label"]');
  } catch { return null; }
}

export function fieldLabel(input) {
  const root = input.getRootNode?.() || document;
  const sources = [
    elLabelText(input.closest('label')),
    input.id ? elLabelText(root.querySelector?.(`label[for="${cssEscape(input.id)}"]`)) : '',
    input.getAttribute('aria-label'),
    input.getAttribute('aria-labelledby') ? idRefText(root, input.getAttribute('aria-labelledby')) : '',
    elLabelText(input.closest('[role="group"]')?.querySelector('label, [class*="label"], [class*="Label"]')),
    elLabelText(input.previousElementSibling),
    elLabelText(perFieldWrapperLabel(input)),
    // A GENERIC widget placeholder is UI chrome, not the question. Indeed's searchable dropdown
    // renders "Search to select an option", and when no other source resolved, that string became
    // the whole label — so the AI was handed a prompt with no question in it and correctly refused
    // ("The actual application question is missing"), parking the application. Live 2026-07-25 this
    // blocked 6 applications across 6 different employers. Drop the generic ones so the ancestor
    // scan below gets a chance; a SPECIFIC placeholder ("e.g. 5 years") is still useful and kept.
    isGenericPlaceholder(input.placeholder) ? '' : input.placeholder,
    input.name,
  ];
  // Nothing usable yet? The real question often sits in an ancestor block above the widget (the
  // same shape as Indeed's stacked labels). Look upward for the nearest question-like text.
  if (!sources.some((s) => String(s || '').trim() && !isGenericPlaceholder(s))) {
    const near = nearestQuestionText(input);
    if (near) sources.push(near);
  }
  let raw = sources.filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);
  // Collapse an EXACT "A A" doubling (two label sources — e.g. previousElementSibling AND the
  // parent's [class*=label] — returned the same heading), which otherwise reads as gibberish and
  // lowers AI answer confidence. Only the exact two-identical-halves case, so a label that
  // genuinely repeats a word is never altered.
  { const h = raw.length >> 1; if (raw.length % 2 === 1 && raw[h] === ' ' && raw.slice(0, h) === raw.slice(h + 1)) raw = raw.slice(0, h); }
  // Strip TRAILING field-id noise that smartapply (Indeed) and other React ATS leave on the
  // label when the real prompt isn't aria-wired: "languages * <uuid>_1_language",
  // "… fluency_english", "referred by (name) q_<hex>". Left in, it drowns the real text and
  // tanks AI answer confidence (the Indeed 0-submission root cause). END-ANCHORED, looped to
  // peel a stacked tail ("<uuid>_1_language"), and only while ≥4 meaningful chars remain so a
  // legitimate label is never truncated mid-string.
  let prev;
  do { prev = raw; raw = raw.replace(/[\s*]*(?:q_[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f-]{12,}|_\d+_[a-z]+|fluency_[a-z]+)$/i, '').trim(); } while (raw !== prev && raw.length >= 4);
  // Return the clean label only. (Previously returned `raw + ' ' + stripAccents(raw)`,
  // which doubled every label — "search" became "search search" — making parked
  // questions read as gibberish to the user AND lowering the AI's answer confidence
  // on real questions. Accent-insensitive matching now happens at the match site,
  // profileFieldFor(), instead of being baked into the label string.)
  return raw;
}

function idRefText(root, ids) {
  return String(ids || '').split(/\s+/)
    .map((id) => elLabelText(root.getElementById?.(id)))
    .join(' ').trim();
}

// A label element's text, reduced to the segment that actually NAMES the field.
//
// ATS labels are often a BLOCK: a section heading, a helper sentence, then the real field name
// last. Captured live from Indeed smartapply 2026-07-20 (the dominant "stuck on a step" failure,
// 17 failed vs 17 done over 7 days), the <label> wired to the required country dropdown was:
//
//   "MOBILE NUMBER
//    Provide valid phone numbers to allow Recruiters to contact you.
//    Country *"
//
// Two things went wrong with that. textContent drops block boundaries, so the words arrived
// JAMMED together ("mobile numberprovide valid phone numbers…country *"). And even spaced, the
// blob matches /phone|mobile/ at index 0 and /country/ only at index 78 -- so the COUNTRY dropdown
// was matched to the phone profile field and "filled" with a phone number, which matches no
// country option. The control stayed empty, Indeed refused to advance, and the re-scan reported
// no unanswered required field because, as far as it could tell, the field had been handled.
//
// Use innerText (block-aware) and, when the label is clearly a stacked block, prefer its LAST
// segment -- the part sitting directly against the control. Conservative on purpose: only when
// there are multiple segments, the last one is short enough to be a field name, and the whole
// blob is long enough to be a heading+helper stack. Anything else returns the text unchanged.
function elLabelText(el) {
  if (!el) return '';
  let t = '';
  try { t = el.innerText || el.textContent || ''; } catch { t = el.textContent || ''; }
  const segs = String(t).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (segs.length >= 2) {
    const last = segs[segs.length - 1];
    if (last.length <= 40 && segs.join(' ').length >= 60) return last;
  }
  return t;
}

// Field-id / option-value shapes that must NEVER be emitted as a question label. Deliberately
// NARROW — id shapes + EXACT option-text equality only, never a length or generic-word
// heuristic — so it can't reject a real (even short) question. `optionTexts` is the lowered
// set of the group's own option strings.
export function isLikelyOptionOrId(text, optionTexts) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!t || t.length < 2) return true;
  if (/^(yes|no|oui|non|s[ií]|si|ja|nein|true|false|y|n|n\/?a)$/i.test(t)) return true;          // a bare option word
  if (/\bq_[0-9a-f]{12,}\b/.test(t)) return true;                                                  // smartapply field id (q_<hex>)
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/.test(t)) return true;     // uuid
  if (/_\d+_[a-z]+$/.test(t) || /\bfluency_[a-z]+$/.test(t)) return true;                          // _1_language / fluency_english
  if (optionTexts && optionTexts.has(t)) return true;                                              // exact option text
  return false;
}

// Would this string pollute the learned-answer store if saved as a QUESTION?
// Measured on the live store: 143 of 2,576 saved answers (6%) are keyed by junk — React
// element ids ("rn", "r1s", "r20"), bare field names ("name", "email", "city"), and option
// text ("yes", "oui", "easy apply"). They get there when a control has no resolvable label
// and fieldLabel() falls back to input.name / the id. Junk keys are worse than useless: the
// server's qaLookup is FUZZY, so "city" or "name" can match a real question later and answer
// it with the wrong value on a real application.
// Deliberately conservative — a real screening question is multi-word and descriptive, so
// requiring that cannot reject one.
const UI_NOISE_RX = /^(easy apply|apply|apply now|submit|submit application|next|continue|save|back|review|done|yes|no|oui|non|true|false|select|choose|search|name|email|phone|city|country|resume|cv)$/i;
export function isJunkQuestionKey(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length < 8) return true;                       // too short to be a real question
  if (!/\s/.test(t)) return true;                      // single token → a field name or an id
  if (UI_NOISE_RX.test(t)) return true;                // button / option / field-name noise
  if (/^r[0-9a-z]{1,4}$/i.test(t)) return true;        // React-generated element id
  if (/^[«»]/.test(t)) return true;                    // React id rendered with guillemets («rj»)
  if (isLikelyOptionOrId(t, null)) return true;        // q_<hex>, uuid, _N_lang, bare option word
  return false;
}

// Is this string something we must NEVER surface to Pierre as a question?
//
// ~30 rows in the live needs-you queue are not questions. Every one strands an application
// permanently, because a string that is not a question can never be answered:
//
//   'required'                        ×9   ← a validation word
//   'a required field'                ×9   ← nativeValidationBlockers' own literal fallback
//   'select...'                            ← a dropdown placeholder used as the label
//   'Review'                               ← a button
//   '.remix-css-1a0ro4n-requiredinput{opacity:0;…}'   ← a raw CSS rule read out of a <style>
//   '5 results available. Use Up and Down to choose options…'  ← a screen-reader announcement
//   '0-4 / 5-10 / 10+ question_8901966005[]'          ← a checkbox group's options + field name
//   'terraform / pulumi / cloudformation / none / aws question_31344737003[]'
//
// This is DISTINCT from isJunkQuestionKey (which guards what we LEARN). This guards what we
// ASK. It is deliberately allowed to be stricter: the cost of wrongly rejecting a real
// question is one unasked field; the cost of accepting junk is a permanently stranded job.
const VALIDATION_WORD_RX = /^\s*(?:a|this|the)?\s*(?:required|mandatory|requis|obligatoire|champ\s+obligatoire|this\s+field\s+is\s+required|required\s+field|field\s+is\s+required)\s*[.*:!]?\s*$/i;
const UI_BUTTON_RX = /^\s*(?:review|next|continue|submit|submit\s+application|save|back|done|apply|apply\s+now|easy\s+apply|close|cancel|edit|previous|skip)\s*$/i;
// A CSS rule that leaked out of a <style> element and into a label.
const CSS_SOURCE_RX = /[.#][\w-]+\s*\{|\{[^}]{0,200}[\w-]+\s*:\s*[^;}]+[;}]|!important|@media\b|opacity\s*:\s*\d/i;
// A field NAME, not a question: Greenhouse's checkbox arrays (question_8901966005[]), any
// trailing name[] , smartapply's q_<hex>, uuids, React-generated ids.
const FIELD_NAME_RX = /(?:^|\s)(?:question_\d{4,}|[A-Za-z_][\w-]*)\[\]\s*$|^\s*question_\d{4,}\s*$|\bq_[0-9a-f]{12,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
export function isJunkQuestionText(text) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!t) return true;
  if (!/[a-z]/i.test(t)) return true;                 // no letters at all — punctuation/ids
  if (VALIDATION_WORD_RX.test(t)) return true;
  if (UI_BUTTON_RX.test(t)) return true;
  if (isPlaceholderOptionText(t)) return true;        // 'select...', 'Choose…', '--'
  if (CSS_SOURCE_RX.test(t)) return true;
  if (UI_INSTRUCTION_RX.test(t)) return true;         // screen-reader combobox help
  if (FIELD_NAME_RX.test(t)) return true;             // ends in a raw field name / name[]
  if (isJunkQuestionKey(t)) return true;              // ids, single tokens, bare option words
  return false;
}

// The QUESTION for a CHECKBOX group — the same problem radioGroupLabel solves for radios.
// Without it a blocking checkbox group is described by its field name or by its own options
// glued together ('0-4 / 5-10 / 10+ question_8901966005[]'), which is unanswerable. Returns
// { label, options } — ONE question carrying the choices, or null when no clean prompt exists.
// The sibling checkboxes that form ONE "select all that apply" question. Grouped by `name`
// first (Greenhouse: name="question_…[]"), then by the enclosing fieldset/role=group so a
// group whose boxes carry no shared name is still seen as a group. A LONE checkbox is never a
// group — bare consent boxes must keep their "never auto-decide" treatment.
export function checkboxGroupMembers(input, root) {
  try {
    if (!input || input.type !== 'checkbox') return [];
    const scope = root || input.getRootNode?.() || document;
    if (input.name) {
      const byName = qsa(`input[type="checkbox"][name="${cssEscape(input.name)}"]`, scope);
      if (byName.length > 1) return byName;
    }
    const grp = input.closest?.('fieldset, [role="group"], [class*="checkbox-group" i]');
    if (grp) {
      const byGroup = qsa('input[type="checkbox"]', grp);
      if (byGroup.length > 1) return byGroup;
    }
    return [];
  } catch { return []; }
}

// Some boards put `required` on EVERY option of a "select all that apply" group (measured on
// job-boards.greenhouse.io/faire 2026-08-24: 11 boxes, all required, all 11 reported :invalid
// until every one is ticked). The browser then only considers the group satisfied when the
// applicant claims EVERY channel, which is not something we will ever type on Pierre's behalf.
// Detecting the shape lets the park say what is actually wrong instead of "check this box".
export function checkboxGroupAllRequired(input, root) {
  const members = checkboxGroupMembers(input, root);
  return members.length > 1 && members.every((m) => m.required);
}

export function checkboxGroupLabel(input, root) {
  try {
    if (!input || input.type !== 'checkbox') return null;
    const scope = root || input.getRootNode?.() || document;
    const name = input.name || '';
    const members = name
      ? qsa(`input[type="checkbox"][name="${cssEscape(name)}"]`, scope)
      : [input];
    const options = members.map((m) => optionLabelText(m)).filter(Boolean).slice(0, 24);
    const optSet = new Set(options.map((o) => o.toLowerCase()));
    // Structured sources first (same order radioGroupLabel uses), then the generic walk-up.
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    let label = '';
    const fs = input.closest?.('fieldset');
    if (fs) { const lg = norm(fs.querySelector?.('legend')?.textContent); if (lg.length >= 4 && !isLikelyOptionOrId(lg, optSet)) label = lg; }
    if (!label) {
      const grp = input.closest?.('[role="group"], [class*="checkbox-group" i], [class*="question" i]');
      if (grp) {
        const al = norm(grp.getAttribute?.('aria-label'));
        if (al.length >= 4 && !isLikelyOptionOrId(al, optSet)) label = al;
        if (!label) {
          const lb = grp.getAttribute?.('aria-labelledby');
          if (lb) { const t = norm(idRefText(scope.getRootNode ? scope : document, lb)); if (t.length >= 4 && !isLikelyOptionOrId(t, optSet)) label = t; }
        }
        if (!label) {
          const lab = norm(grp.querySelector?.('legend, label, [class*="label" i]')?.textContent);
          if (lab.length >= 4 && !isLikelyOptionOrId(lab, optSet)) label = lab;
        }
      }
    }
    if (!label) label = promptWalkUp(input, optSet);
    label = norm(label);
    // A recovered "label" that is really the option list (or a field name) is not a question.
    if (!label || label.length < 4 || isJunkQuestionText(label)) return null;
    for (const o of options) if (o.length > 2 && label.toLowerCase() === o.toLowerCase()) return null;
    return { label: label.slice(0, 250), options };
  } catch { return null; }
}

// The visible option text of a single radio (its <label> text minus the input, id-stripped).
// Used both to build the AI's option list and as the prompt-walk-up blacklist.
// The visible choice text for ONE radio. Order matters: every DOM-authored source is tried
// before input.value, because a radio with no value attribute reports the browser DEFAULT
// "on" — which is not a choice at all. LinkedIn's rebuilt Easy Apply dialog uses NON-wrapping
// <label for="id"> siblings, so closest('label') misses and we used to fall straight through
// to value: every Yes/No group came back as options ["on","on"], unanswerable, so the task
// parked ("needs 1 answer(s)") and "on" even got saved as a learned answer.
function labelTextOf(el) {
  if (!el) return '';
  const c = el.cloneNode(true);
  c.querySelectorAll?.('input,select,textarea').forEach((n) => n.remove());
  return String(c.textContent || '');
}
function optionLabelText(r) {
  try {
    let t = labelTextOf(r.closest?.('label'));
    const root = r.getRootNode?.() || document;
    // non-wrapping <label for="…"> — the standard (and LinkedIn's current) pattern
    if (!t.trim() && r.id) {
      try { t = labelTextOf(root.querySelector?.(`label[for="${cssEscape(r.id)}"]`)); } catch {}
    }
    if (!t.trim()) {
      const ids = String(r.getAttribute?.('aria-labelledby') || '').trim();
      if (ids) t = ids.split(/\s+/).map((id) => { try { return labelTextOf(root.getElementById?.(id) || document.getElementById(id)); } catch { return ''; } }).join(' ');
    }
    if (!t.trim()) t = String(r.getAttribute?.('aria-label') || '');
    t = t.replace(/\s+/g, ' ').trim();
    t = t.replace(/[\s*]*(?:q_[0-9a-f]{8,}|_\d+_[a-z]+)$/i, '').trim();   // drop a trailing field-id if the label was empty
    // LAST resort only, and never the browser's default placeholder value.
    if (!t) { const v = String(r.value ?? '').replace(/\s+/g, ' ').trim(); if (v && !/^(on|off)$/i.test(v)) t = v; }
    if (/^(on|off)$/i.test(t)) t = '';
    return t.slice(0, 60);
  } catch { return ''; }
}

function optionTextsForGroup(input, root) {
  const set = new Set();
  try {
    if (input.type === 'radio' && input.name) {
      for (const r of qsa(`input[type="radio"][name="${cssEscape(input.name)}"]`, root)) {
        const t = optionLabelText(r).toLowerCase();
        if (t) set.add(t);
      }
    }
  } catch {}
  return set;
}

// Generic question-prompt finder for a group whose prompt is NOT aria-wired (Indeed smartapply
// & many React ATS: no <fieldset>, no [role=radiogroup], no aria-labelledby — the question is a
// plain heading/label sitting ABOVE the option row). Find the smallest ancestor that holds the
// whole group, then climb a few levels; at each level take the prompt-shaped element CLOSEST
// BEFORE the first control in document order whose text is clean (not an option/id). Pure DOM;
// returns '' when nothing clean is found (the caller then never falls back to the dirty
// fieldLabel for radios — better a clean skip than asking the AI a non-question).
const PROMPT_SEL = 'legend, [role="heading"], h1, h2, h3, h4, h5, h6, label, [class*="label" i], [class*="question" i], [class*="prompt" i], [class*="title" i], [class*="legend" i], p';
function promptWalkUp(input, optionTexts) {
  try {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const root = input.getRootNode?.() || document;
    const opts = optionTexts || optionTextsForGroup(input, root);
    const members = (input.type === 'radio' && input.name)
      ? qsa(`input[type="radio"][name="${cssEscape(input.name)}"]`, root)
      : [input];
    const first = members[0] || input;
    let container = input.parentElement, g = 0;
    while (container && g++ < 10 && !members.every((m) => container.contains?.(m))) container = container.parentElement;
    container = container || input.parentElement || input;
    let node = container, climbs = 0;
    while (node && climbs++ < 6) {
      let best = '';
      for (const el of qsa(PROMPT_SEL, node)) {
        if (el.querySelector?.('input, select, textarea')) continue;          // a wrapper / option label, not the prompt
        const pos = el.compareDocumentPosition?.(first) || 0;
        if (!(pos & 4 /* first FOLLOWS el → el is before the control */)) continue;
        const t = norm(el.textContent);
        if (t.length < 4 || isLikelyOptionOrId(t, opts)) continue;
        best = t;                                                              // doc order → keep the LAST (closest preceding)
      }
      if (best) return best.slice(0, 250);
      if (node.tagName === 'FORM' || node.tagName === 'BODY') break;
      node = node.parentElement;
    }
  } catch {}
  return '';
}

// The QUESTION for a radio group — NOT the per-option "Yes"/"No" label. LinkedIn/
// Greenhouse render Yes/No screening questions as a <fieldset><legend>question</legend>
// (or a [role="radiogroup"]/[role="group"] with aria-label/labelledby), and each radio's
// own <label> is just "Yes"/"No". Using fieldLabel(input) there returns "yes" (3 chars),
// which scanUnknown drops (length<4) → the question is never asked → stuck on Review.
// Walk up to the group to recover the real question text. The structured branches below run
// FIRST (LinkedIn/Greenhouse path, unchanged); only when they yield nothing do the generic
// smartapply/React paths run — so LinkedIn never reaches the new code.
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
  // ── smartapply / React (no fieldset/role/aria-wiring) ──
  const root = input.getRootNode?.() || document;
  const opts = optionTextsForGroup(input, root);
  const ilb = input.getAttribute?.('aria-labelledby');
  if (ilb) { const t = norm(idRefText(root, ilb)); if (t.length >= 4 && !isLikelyOptionOrId(t, opts)) return t.slice(0, 250); }
  return promptWalkUp(input, opts);
}

// The QUESTION for a <select> whose label isn't formally associated (smartapply's
// "languages * <uuid>_1_language" / "fluency_english" — the field-id leaks through as the
// label). A clean direct label wins (covers labelled selects everywhere incl. LinkedIn);
// only an id-shaped direct label triggers the generic prompt walk-up.
export function selectGroupLabel(input) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const direct = norm(fieldLabel(input));
  if (direct.length >= 4 && !isLikelyOptionOrId(direct, null) && !/_\d+_[a-z]+$|q_[0-9a-f]{12,}|[0-9a-f]{8}-[0-9a-f]{4}/.test(direct)) return direct.slice(0, 250);
  const walked = promptWalkUp(input, null);
  if (walked) return walked;
  // LAST RESORT (fixes the dominant "stuck on a step" park): when neither resolver recovers a
  // prompt, scanUnknown drops the field for having a <4-char label — so a REQUIRED, empty <select>
  // is never answered, "Review" does nothing, and the job dies as stuck. Live example: a French
  // proficiency select ("Quel est votre niveau en Français") whose prompt only exists on the
  // surrounding form container. This is the same recovery the stuck-dump already used successfully
  // on that exact markup, so the question reaches the AI instead of stalling the whole application.
  try {
    const holder = input.closest('label, fieldset, [class*="form"], [class*="question"], [data-testid]');
    if (holder) {
      const viaLabel = norm(holder.querySelector('label, legend')?.textContent || '');
      if (viaLabel.length >= 4) return viaLabel.slice(0, 250);
      const own = norm(holder.textContent || '');
      // strip the option text so we keep the question, not the choices
      const opts = new Set([...(input.options || [])].map((o) => norm(o.textContent)).filter(Boolean));
      let cleaned = own;
      for (const o of opts) if (o.length > 1) cleaned = cleaned.split(o).join(' ');
      cleaned = norm(cleaned);
      if (cleaned.length >= 4) return cleaned.slice(0, 250);
    }
  } catch {}
  return direct.slice(0, 250);
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

// Does this label want a BOOLEAN answer?
//
// PROFILE_PATTERNS below matches on any incidental word in a label, and a screening question
// is a whole sentence, so the incidental word wins constantly. Live consequences, all real
// stored answers:
//
//   "…require sponsorship … in the COUNTRY where you're applying"  → profile.country  "Canada"
//   "do you have the unrestricted right to work in the COUNTRY …"  → profile.country  "Canada"
//   "are you legally AUTHORIZED to work in the region…"            → the whole workAuthorization
//                                                sentence "Authorized to work in Canada (…)"
//
// Every one of those fields wanted Yes or No. A profile string typed into a boolean field is
// not a partial answer, it is a wrong one — so the profile ladder declines and the field
// falls through to the answer path (learned memory → deterministic floor → AI), which knows
// how to produce a boolean with the right polarity.
//
// DUPLICATION NOTE: app/src/answer-shape.js is the canonical implementation of this
// classification; it cannot be imported here (CommonJS, and this file is an ES module content
// script). tests/answer-shape-parity.test.mjs asserts the two agree on a shared corpus so
// they cannot drift apart silently.
const YESNO_AUX_RX = /^(?:do|does|did|are|is|was|were|have|has|had|will|would|can|could|should|shall|may|must|am|any)\b/i;
const YESNO_PHRASE_RX = /\b(?:do you|does your|did you|are you|is your|are there|is there|have you|has your|had you|will you|would you|can you|could you|should you|may we|are we|do we|would your)\b/i;
const WH_LEAD_RX = /^(?:what|which|where|when|who|whom|whose|how|why)\b/i;
export function expectsYesNo(label) {
  const s = String(label == null ? '' : label).replace(/\s+/g, ' ').trim();
  if (!s) return false;
  if (/\(\s*y(?:es)?\s*\/\s*n(?:o)?\s*\)/i.test(s)) return true;
  // The operative clause is the LAST sentence — ATS prompts lead with statements
  // ("This is a remote position. Where are you currently located?").
  const parts = s.split(/(?<=[.!?])\s+/).map((p) => p.trim()).filter(Boolean);
  let clause = parts[parts.length - 1] || s;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/\?$/.test(parts[i]) || WH_LEAD_RX.test(parts[i]) || YESNO_PHRASE_RX.test(parts[i]) || YESNO_AUX_RX.test(parts[i])) { clause = parts[i]; break; }
  }
  if (WH_LEAD_RX.test(clause)) return false;         // "where are you located?" is not boolean
  return YESNO_AUX_RX.test(clause) || YESNO_PHRASE_RX.test(clause);
}

// A yes/no-shaped VALUE (so a profile field that genuinely holds "Yes"/"No" still fills a
// boolean field — only non-boolean strings are withheld).
const YESNO_VALUE_RX = /^\s*(?:yes|y|true|oui|si|sí|ja|no|n|false|non|nein|n\/a)\b/i;

export function profileFieldFor(label, profile) {
  // Match against both the raw and accent-folded label so French fields (e.g.
  // "prénom") still hit patterns even where only the unaccented form is listed.
  const folded = stripAccents(label);
  // A "how many years / how long / experience with X" question wants a NUMBER — it must
  // NOT be filled with a profile URL/handle that merely mentions X (e.g. "years of
  // experience with GitHub" was grabbing the GitHub URL → "Invalid input"). Skip URL
  // fields for these; the AI estimates the years from the resume instead.
  const wantsQuantity = /\b(how many|how long|years?|number of|combien|nombre d)\b/i.test(label) || /\byears?\b/i.test(folded);
  // A boolean field only accepts a boolean value — see expectsYesNo above.
  const wantsBoolean = expectsYesNo(label);
  for (const [rx, field] of PROFILE_PATTERNS) {
    if (wantsQuantity && /Url$/.test(field)) continue;
    // Only scalar profile values are fillable — never stringify an array/object
    // (e.g. workHistory) into a form field.
    if ((rx.test(label) || rx.test(folded)) && profile[field] != null && profile[field] !== '' && typeof profile[field] !== 'object') {
      if (wantsBoolean && !YESNO_VALUE_RX.test(String(profile[field]))) continue;   // never paste a profile string into a Yes/No field
      return { field, value: profile[field] };
    }
  }
  return null;
}

// EEO / demographic / criminal-history fields are NEVER auto-filled, escalated to AI,
// or harvested — regardless of settings (legal/ethical). Mirrors executor.js.
// Protected characteristics we never answer on the applicant's behalf. `pronoun` was deliberately
// REMOVED at Pierre's explicit request: he supplied his pronouns (stored on the profile), and every
// posting that asks was parking forever behind this guard. Gender identity, transgender status,
// race, disability, veteran and criminal history all remain blocked — those stay the user's call.
// `convict` (not `conviction`) and `\bcrimes?\b` because the single most common phrasing —
// "Have you been CONVICTED of a CRIME for which you have not received a pardon?" — matched NEITHER
// `conviction` nor `criminal` and so was never blocked here. It only stayed unanswered because the
// AI happened to decline it; the deterministic guard must not depend on that.
export const NEVER_AUTOFILL_RX = /(ethnic|race|gender|disabilit|veteran|criminal|convict|\bcrimes?\b|background.?check|felony|sexual.?orientation|\blgbtq?)/i;

// ── VOLUNTARY DEMOGRAPHIC QUESTIONS THAT ARE MARKED REQUIRED ─────────────────────────────────
// Greenhouse's demographic section is introduced as "completely voluntary" and then ships its
// questions with aria-required="true" + a hidden required sentinel, so the browser refuses the
// submit until they hold a value. NEVER_AUTOFILL_RX correctly refuses to SELF-IDENTIFY — but the
// result was a form nobody could submit, so every such posting parked.
//
// Declining is not self-identifying. Every one of these questions ships an explicit decline
// option, and picking it is the neutral answer a privacy-minded person picks by hand. So: a
// demographic field may be answered ONLY with a decline option, ONLY when it is blocking, and
// NEVER with a substantive value.
export const DECLINE_OPTION_RX = /((?:i )?(?:do ?n['’]?t|do not) wish to (?:answer|disclose|self[- ]?identify)|decline to (?:answer|disclose|self[- ]?identify|state)|prefer not to (?:answer|say|disclose|respond|self[- ]?identify)|choose not to (?:answer|disclose|self[- ]?identify)|(?:i )?(?:would )?rather not (?:say|answer)|no answer|opt out)/i;

// Is this field part of a demographic / EEO / self-identification block? Label-based first
// (NEVER_AUTOFILL_RX), then structural — "Which categories describe you?" names no protected
// class at all, which is exactly how it reached the AI and got answered "Fullstack, Backend,
// Frontend" against a list of ethnicities.
const DEMOGRAPHIC_CONTAINER_SEL = '[id*="demographic" i],[class*="demographic" i],[id*="eeo" i],[class*="eeo" i],[id*="self-identif" i],[class*="self-identif" i],[id*="diversity" i],[class*="diversity" i]';

// A CONSENT / ACKNOWLEDGEMENT statement is NOT a demographic question, even when the ATS renders
// it inside the demographic block.
//
// The structural test above asks "what container is this field in", which is the right question for
// "Which categories describe you?" (it names no protected class, so only its container gives it
// away) and the WRONG question for the privacy consent checkbox that many ATS ship in that same
// section. Live 2026-08-24, hootsuite parked on "I have read the privacy notice and consent to the
// processing of my personal data" with the reason "voluntary demographic question with no decline
// option" — a checkbox that has no decline option because it is not a question, and which blocked
// the whole application.
//
// The discriminator is linguistic and reliable: a consent statement asserts that the CANDIDATE has
// read / agrees to / acknowledges a NOTICE, POLICY or TERMS. A demographic question asks what the
// candidate IS. Checked AFTER NEVER_AUTOFILL_RX, so a label that names a protected class is still
// demographic no matter how it is phrased — the escape can only ever release a field the LABEL
// gives no protected-class reason to hold.
export const CONSENT_ACK_RX = new RegExp(
  '(privacy (?:notice|policy|statement|agreement)|candidate privacy|data protection|'
  + 'terms (?:of|and)\\b|processing of my (?:personal )?data|'
  + 'i (?:have )?(?:read|reviewed|understand|acknowledge|consent|agree|accept)\\b|'
  + 'by (?:selecting|checking|clicking|submitting)\\b|'
  + 'acknowledge(?:ment)?\\b|consent to\\b|agree to\\b|gdpr|ccpa)', 'i');

export function isDemographicField(input, label) {
  const text = String(label || '');
  if (NEVER_AUTOFILL_RX.test(text)) return true;      // names a protected class — always demographic
  if (CONSENT_ACK_RX.test(text)) return false;        // a privacy notice is not a demographic question
  try { return !!input?.closest?.(DEMOGRAPHIC_CONTAINER_SEL); } catch { return false; }
}

// The decline phrasings to try, most specific first. When the field publishes its options we
// return the site's OWN wording (so the match is exact); otherwise a short ordered list the
// option matcher can hit by substring.
const DECLINE_FALLBACKS = [
  "I don't wish to answer", 'Decline to self-identify', 'Prefer not to say',
  'Prefer not to answer', 'Decline to answer', 'I do not wish to answer',
];
export function declineAnswerCandidates(options) {
  const own = (Array.isArray(options) ? options : []).filter((o) => DECLINE_OPTION_RX.test(String(o || '')));
  return [...own, ...DECLINE_FALLBACKS];
}

// Screen-reader instructions for a combobox/listbox ("5 results available. Use Up and Down to
// choose options, press Enter to select…") get picked up as if they were the QUESTION. The job then
// parks forever waiting on an answer to a string that is not a question, and the junk text would be
// learned as a saved answer key. Treat this text as "no label" so the control is passed over
// cleanly instead of stalling the application.
// `results?` because the live string is SINGULAR when a combobox narrows to one option
// ("1 result available.Use Up and Down to choose options, …") — the plural-only form missed it.
export const UI_INSTRUCTION_RX = /results? available|use up and down|press enter to select|press escape|press tab to select|screen ?reader/i;

// A radio/checkbox is "visible enough" to be a real screening control when the native input
// OR an associated <label> / styled wrapper is visible. LinkedIn (and many ATS) render the
// native <input type=radio> as a 0x0 / clipped / opacity:0 box behind a styled label, so a
// strict isProbablyVisible(input) check made the entire "Authorized to work? Yes/No" screening
// question INVISIBLE to the scanner — the form then silently refused to advance ("stuck on a
// step", the single largest failure bucket). Confirmed by live transcripts where the Oui/Non
// group was in the page text but absent from the scanned field set.
function isControlOrLabelVisible(input) {
  if (isProbablyVisible(input)) return true;
  try {
    const doc = input.ownerDocument || document;
    const lab = input.closest('label')
      || (input.id && doc.querySelector(`label[for="${cssEscape(input.id)}"]`))
      || input.closest('[role="radio"],[role="checkbox"],[data-test-text-selectable-option],[class*="radio"],[class*="checkbox"],[class*="selectable-option"]');
    return !!(lab && isProbablyVisible(lab));
  } catch { return false; }
}

export function isFillable(input) {
  if (!input) return false;
  if (input.disabled || input.readOnly) return false;
  if (input.type && ['hidden', 'file', 'submit', 'button', 'image', 'reset'].includes(input.type)) return false;
  // Radios/checkboxes: judge visibility via the input OR its label/wrapper (the native input is
  // often visually hidden for styling). Everything else: the input itself must be visible.
  if (input.type === 'radio' || input.type === 'checkbox') {
    if (!isControlOrLabelVisible(input)) return false;
  } else if (!isProbablyVisible(input)) {
    return false;
  }
  const id = (input.id || '') + ' ' + (input.name || '') + ' ' + (input.placeholder || '');
  if (/captcha|recaptcha|cardnumber|cvv|cvc|password/i.test(id)) return false;
  if (NEVER_AUTOFILL_RX.test(id)) return false;
  if (input.type === 'password') return false;
  return true;
}

// LinkedIn prefills some REQUIRED numeric screening inputs ("How many years … with X?") with a
// junk placeholder "1" (the "1 of 20 characters" counter). The non-empty guards below would treat
// that as "already answered" and silently submit "1 year" without ever asking — a trust-eroding
// false answer. A lone digit in a REQUIRED field that WE have NOT filled is therefore treated as
// UNanswered so it surfaces to the answer layer (grounded estimate or honest park). Once we fill it
// (any value) it is "ours" (marked in setNativeValue) and never re-surfaced — so a legit single-digit
// answer ("0"/"6" years) can't loop: fill → re-detected as placeholder → re-fill → …
const _jatFilledFields = new WeakSet();
function looksPrefilledPlaceholder(input) {
  try {
    if (!input || input.tagName === 'SELECT') return false;
    if (_jatFilledFields.has(input)) return false;   // we already answered it — not a placeholder
    const required = input.required || input.getAttribute('aria-required') === 'true';
    return required && /^\d$/.test(String(input.value || '').trim());
  } catch { return false; }
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

// Normalized Levenshtein similarity in [0,1] (1 = identical) — tiny, self-contained,
// NO dependency. Used as the FINAL fuzzy tier in matchOption/pickRadioInGroup so a
// paraphrased AI/learned answer snaps to a real option ("Bachelors" → "Bachelor's
// Degree", "5-7 yrs" → "5 to 7 years", "Yes" → "Yes, I am authorized to work").
// Whitespace-/case-/punctuation-folded so trivial formatting differences don't cost
// distance. Conservative by design — the caller gates on FUZZY_SNAP_MIN so garbage
// still parks; this never mis-selects on its own.
export const FUZZY_SNAP_MIN = 0.72;
function normForFuzzy(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    // Canonicalize a few high-frequency answer abbreviations so a paraphrase scores against
    // the same surface form as the option ("5-7 yrs" ≈ "5 to 7 years"). Conservative + tiny;
    // it only normalizes spelling, it does not invent meaning.
    .replace(/\byrs?\b/g, 'years')
    .replace(/(\d)\s*[-–—]\s*(\d)/g, '$1 to $2')   // "5-7" → "5 to 7" (range dash → "to")
    .replace(/\bgrad\b/g, 'graduate')
    .replace(/[^a-z0-9]+/g, ' ')   // fold remaining punctuation/apostrophes to spaces
    .replace(/\s+/g, ' ')
    .trim();
}
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}
function levSim(x, y) {
  if (!x || !y) return 0;
  if (x === y) return 1;
  const maxLen = Math.max(x.length, y.length);
  return maxLen ? 1 - levenshtein(x, y) / maxLen : 0;
}
// Similarity in [0,1]. Combines whole-string normalized Levenshtein with a TOKEN-aware
// measure so a SHORT answer that is the meaningful subset of a longer option still scores
// high ("Bachelors" ⊂ "Bachelor's Degree", "Yes" ⊂ "Yes, I am authorized to work") — the
// whole-string metric alone over-penalizes that length gap. Token measure: for each token of
// the shorter side, take its BEST per-token Levenshtein similarity against the longer side's
// tokens, then average — so unrelated answers (no token aligns) still score low and PARK.
export function fuzzySimilarity(a, b) {
  const x = normForFuzzy(a);
  const y = normForFuzzy(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const whole = levSim(x, y);
  const xt = x.split(' ').filter(Boolean);
  const yt = y.split(' ').filter(Boolean);
  const [short, long] = xt.length <= yt.length ? [xt, yt] : [yt, xt];
  let tokenScore = 0;
  if (short.length) {
    let sum = 0;
    for (const t of short) {
      let best = 0;
      for (const u of long) { const s = levSim(t, u); if (s > best) best = s; }
      sum += best;
    }
    tokenScore = sum / short.length;
  }
  return Math.max(whole, tokenScore);
}
// Score `value` against every candidate label and return the index of the best ONLY
// when its similarity clears `min` (default FUZZY_SNAP_MIN); else null → caller parks.
export function bestFuzzyIndex(labels, value, min = FUZZY_SNAP_MIN) {
  let best = -1, bestScore = 0;
  labels.forEach((lbl, i) => {
    const score = fuzzySimilarity(value, lbl);
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return bestScore >= min ? best : null;
}

// Pick the best <option> for a value, preferring exactness over substring so
// '5' selects '5+ years' / '5-10 years' (longest containing match), never the
// first DOM-order option that merely contains the digit ('3-5 years').
// Is this <option> the dropdown's PLACEHOLDER rather than a real choice?
//
// A placeholder is the unset state. Selecting one sets nothing, but every layer downstream
// reads it as an answer: it was recorded as the submitted answer ("Select an option") on 5
// live jobs, and it was learned into memory until isPlaceholderAnswer started rejecting it.
// Three independent tells, any one of which is enough:
//   • the text says select/choose/please select
//   • the text is only punctuation ("--", "—", "…") or empty
//   • the value attribute is empty — the canonical HTML "nothing chosen" encoding
export function isPlaceholderOption(opt) {
  try {
    if (!opt) return true;
    const text = String(opt.text == null ? (opt.textContent || '') : opt.text).trim();
    const value = String(opt.value == null ? '' : opt.value).trim();
    if (!value && !/^(?:no|non|false|0)$/i.test(text)) return true;   // empty value = nothing chosen
    return isPlaceholderOptionText(text);
  } catch { return false; }
}
const PLACEHOLDER_OPTION_TEXT_RX = /^\s*(?:(?:please\s+)?(?:select|choose|pick|s[ée]lectionne[rz]|choisir|veuillez\s+(?:s[ée]lectionner|choisir))(?:\s+(?:an?|one|your|votre|une?)?\s*(?:option|answer|value|choice|one|r[ée]ponse|valeur)?)?|[-–—.·•\s]+|n\/?a|none\s+selected|click\s+to\s+select|start\s+typing|search)\s*[.…]{0,3}\s*$/i;
export function isPlaceholderOptionText(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return true;
  return PLACEHOLDER_OPTION_TEXT_RX.test(t);
}

// ── A YES/NO ANSWER AGAINST PROSE OPTIONS ────────────────────────────────────────────────────
// Greenhouse lets a company write a yes/no question whose OPTIONS are full sentences instead of
// "Yes"/"No". Affirm's "Have you previously been employed at Affirm for any length of time?*"
// offers:
//     I have not previously been employed at Affirm
//     I have been employed at Affirm as a full-time employee
//     I have been employed at Affirm as a part-time employee
//     I have been employed at Affirm as an intern
//     I have been employed at Affirm as a contractor
// The learned answer is "No". Every textual tier misses it: it is not exact, not a prefix, and the
// substring tier is switched off for a 2-character value (`vl.length > 2`), so the field filled
// `left-empty (no matching option)` and 9 Tier A Affirm tasks parked on it. GitLab's identically
// SHAPED question ("Have you previously worked at or consulted for GitLab?") filled fine only
// because its options are the literal words Yes and No — the difference was never the widget.
//
// Resolve by POLARITY instead, and only when it is unambiguous:
//   • the answer must be a bare yes/no token (a prose answer is not a polarity claim),
//   • no option may itself be a bare yes/no token (if one is, the exact tier already had it),
//   • exactly ONE option may carry the wanted polarity.
// Affirm + "No" → the single negated option. Affirm + "Yes" → four affirmatives, so this returns
// nothing and the field parks WITH its real options, which is the honest outcome: the four are
// materially different answers and guessing between them would put a false employment history on
// an application.
const YES_TOKEN_RX = /^(?:yes|y|true|1|oui|s[ií]|ja|sim)$/i;
const NO_TOKEN_RX = /^(?:no|n|false|0|non|nein|n[aã]o)$/i;

// Negation carried by an option's own words. `(^|\W)…(\W|$)` keeps this to whole words, so
// "non-employee" / "nothing" / "Norway" are not read as negative.
export function isNegativeOptionText(text) {
  const t = String(text == null ? '' : text).toLowerCase();
  if (/\w['’]t(\W|$)/.test(t)) return true;                     // haven't / don't / didn't / cannot→can't
  return /(^|\W)(no|not|never|none|neither|nor|negative)(\W|$)/.test(t);
}

// Index of the one option whose polarity matches a bare yes/no answer, or -1.
export function matchPolarityOption(labels, value) {
  // NO minimum option count. A typeahead FILTERS as we type, so by the time this runs the Affirm
  // menu is showing exactly one row — the negated one, because "I have not…" is the only option
  // containing the letters the answer typed. Requiring two options would leave the very case this
  // exists for unmatched.
  const opts = (Array.isArray(labels) ? labels : []).map((l) => String(l == null ? '' : l).trim());
  if (!opts.length) return -1;
  const v = String(value == null ? '' : value).trim();
  const wantNo = NO_TOKEN_RX.test(v);
  const wantYes = YES_TOKEN_RX.test(v);
  if (!wantNo && !wantYes) return -1;                           // not a polarity answer
  // If the widget offers a literal Yes/No the plain tiers own this field — never second-guess them.
  if (opts.some((o) => YES_TOKEN_RX.test(o) || NO_TOKEN_RX.test(o))) return -1;
  const wanted = [];
  opts.forEach((o, i) => { if (o && isNegativeOptionText(o) === wantNo) wanted.push(i); });
  return wanted.length === 1 ? wanted[0] : -1;                  // ambiguous → park, never guess
}

export function matchOption(select, v) {
  // A placeholder is never a legal match — not in the exact tier, not in the substring tier,
  // not in the fuzzy tier. (Only the fuzzy tier used to exclude it, so a poisoned learned
  // answer of literally "Select an option" matched the placeholder EXACTLY and "committed".)
  const opts = Array.from(select.options).filter((o) => !isPlaceholderOption(o));
  if (!opts.length) return null;
  const vl = String(v).toLowerCase();
  const exact = opts.find((o) => o.value === v || o.text === v)
    || opts.find((o) => o.value.toLowerCase() === vl || o.text.toLowerCase().trim() === vl);
  if (exact) return exact;
  // Numeric answer (years-of-experience, salary band) → pick the option whose RANGE
  // contains it, so '6' selects '5-10 years' not '16+ years' by accidental substring.
  const ni = numericMatch(opts.map((o) => o.text), v);
  if (ni != null) return opts[ni];
  // A yes/no answer against prose options — resolved by polarity, only when unambiguous. Placed
  // BEFORE the substring tier deliberately: "No" would otherwise be matched by any option merely
  // CONTAINING the letters "no" ("I have not…" happens to be right here, "I know the team" would
  // not be), which is an accident rather than a rule.
  const pi = matchPolarityOption(opts.map((o) => o.text), v);
  if (pi >= 0) return opts[pi];
  const sub = opts
    .filter((o) => o.text.toLowerCase().includes(vl) || o.value.toLowerCase().includes(vl))
    .sort((a, b) => b.text.length - a.text.length)[0];
  if (sub) return sub;
  // FINAL fuzzy tier: snap a paraphrased answer to the closest real option label, but
  // ONLY when similarity is high enough (conservative) — otherwise return null (park).
  // Never mis-selects garbage: a low-similarity answer falls through to null. Skip the
  // synthetic "Select…/Choose…/--" placeholder so we never snap onto the empty default.
  const labels = opts.map((o) => (o.text || '').trim());
  const fi = bestFuzzyIndex(labels, v);
  if (fi != null && !/^select|^choose|^--|^$/i.test(labels[fi])) return opts[fi];
  return null;
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
  if (hit) return hit.r;
  // FINAL fuzzy tier (matches matchOption): snap a paraphrased answer to the closest
  // radio label, but ONLY above the conservative FUZZY_SNAP_MIN — else null (park). So
  // "Yes" → "Yes, I am authorized to work", "Bachelors" → "Bachelor's Degree"; garbage
  // (no label clears the bar) still returns null and is parked, never mis-selected.
  const fi = bestFuzzyIndex(labelled.map((x) => x.lbl), v);
  return fi != null ? labelled[fi].r : null;
}

// React-proof value injection.
// Split into a raw writer + the marking wrapper so an ABANDONED combobox attempt can put the
// field back exactly as it was found without also claiming "we answered this" — see revertTyped()
// in fillCombobox. Event/marking order is unchanged from the single-function version.
function setValueRaw(el, value, mark) {
  try {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  } catch { el.value = value; }
  if (mark) { try { _jatFilledFields.add(el); } catch {} }   // answered-by-us (see looksPrefilledPlaceholder)
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function setNativeValue(el, value) { setValueRaw(el, value, true); }

// React-proof CHECKED injection — the radio/checkbox counterpart of setValueRaw.
//
// setValueRaw goes through the native `value` setter precisely so React's change tracker sees
// the write. The radio and checkbox branches of fill() did NOT: they assigned `el.checked = true`
// directly, which bypasses React's `checked` tracker, so React re-renders its own (unchanged)
// state and the selection silently reverts. The form then still reports the group unanswered —
// the live "blocked the application — could not fill the answer" park, on tasks whose answers
// memory already holds. Re-posting the same answers cannot fix that: the failure is mechanical.
//
// Additive and self-verifying: set through the native setter, CHECK whether it stuck, and only
// if it did not, fall back to a real click (on the styled <label> when the input itself is the
// 0×0 / opacity:0 box many ATSs render — the same shape isControlOrLabelVisible exists for).
export function setNativeChecked(el, checked = true) {
  try {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'checked')?.set
      || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
    if (setter) setter.call(el, checked); else el.checked = checked;
  } catch { try { el.checked = checked; } catch {} }
  try {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch {}
  if (el.checked === checked) return true;

  // Did not stick → drive it the way a person would.
  const targets = [];
  try {
    const doc = el.ownerDocument || document;
    if (el.id) { const l = doc.querySelector(`label[for="${cssEscape(el.id)}"]`); if (l) targets.push(l); }
    const wrap = el.closest?.('label, [role="radio"], [role="checkbox"], [data-test-text-selectable-option]');
    if (wrap) targets.push(wrap);
  } catch {}
  targets.push(el);
  for (const t of targets) {
    try { t.click(); } catch { continue; }
    if (el.checked === checked) return true;
  }
  return el.checked === checked;
}

// ── LOCATION + SALARY SAFETY ──────────────────────────────────────────────────────────────
// Added 2026-08-23 after autofill DAMAGED three real applications Pierre was making BY HAND:
//   1. react-selects were given the typed text but never a committed selection, so the field
//      LOOKED filled while its value was empty and submit bounced "Select a country" /
//      "This field is required";
//   2. a bare "Toronto" resolved to "Toronto, Ohio, United States" on a Faire Greenhouse form —
//      the pick was simply the FIRST option starting with the typed city (Ohio sorts before
//      Ontario) and the profile's own province/country were never consulted;
//   3. a stored salary expectation was written into an AutoTrader posting whose own stated band
//      was HIGHER, anchoring the negotiation below the range before a human read a word.
//
// THE GOVERNING RULE, in priority order: a value we cannot COMMIT, cannot resolve UNAMBIGUOUSLY,
// or that would UNDERCUT the posting is NOT WRITTEN AT ALL. A blank required field is honest and
// the form catches it; a filled-looking empty one gets submitted wrong.
//
// Everything in this block is PURE and exported so it is node-testable without a DOM.

// A LOCATION FIELD's label is a NAME ("Location (City) *", "City", "Ville"), not a sentence.
// Measured live on Greenhouse/faire 2026-08-24: the required screening dropdown
//   "This role will be in-office on a hybrid schedule, can you commit to being in-office three
//    days per week at the LOCATION where this position is posted?"
// matched on the bare word "location", so its Yes/No answer was routed through
// pickLocationIndex — which looks for a CITY among the options, found none, and abandoned the
// field. The trace then blamed the widget ("typeahead no match") while the real cause was the
// label classifier. Same shape as the Greenhouse pack's own fieldKeyFor guard: a short label is
// a field name, a long one is a question that merely MENTIONS a place.
const LOCATION_WORD_RX = /(\blocation\b|\bcity\b|\btown\b|\bville\b|\bciudad\b|\bstadt\b)/i;
// Explicit location QUESTIONS, allowed at any length because they ask for a place as the answer.
const LOCATION_PHRASE_RX = /(where are you (?:currently\s+)?(?:based|located|living)|(?:what(?:'s| is)) your (?:current\s+)?(?:location|city|city of residence)|city of residence|current city)/i;
const LOCATION_LABEL_MAX = 60;   // "location (city) * location (city)" (a stacked label) is 33
export function looksLikeLocationLabel(label) {
  const s = String(label || '').replace(/\s+/g, ' ').trim();
  if (!s) return false;
  if (LOCATION_PHRASE_RX.test(s)) return true;
  if (!LOCATION_WORD_RX.test(s)) return false;
  return s.length <= LOCATION_LABEL_MAX;
}

export function looksLikeSalaryLabel(label) {
  return /(salary|compensation|remuneration|salaire|salario|(?:desired|expected|target|base)\s*(?:pay|comp)|pay\s*(?:rate|range|expectation))/i
    .test(String(label || ''));
}

function normLoc(s) {
  return stripAccents(String(s == null ? '' : s))
    .toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

// Region names ⇄ abbreviations, both directions, so a profile holding "ON" and an option saying
// "Ontario" (or the reverse) still agree. Canada and the US are listed in full because the live
// failure was precisely a Canada/US collision on an identically-named city.
const REGION_ABBR = {
  alberta: 'ab', 'british columbia': 'bc', manitoba: 'mb', 'new brunswick': 'nb',
  'newfoundland and labrador': 'nl', 'northwest territories': 'nt', 'nova scotia': 'ns',
  nunavut: 'nu', ontario: 'on', 'prince edward island': 'pe', quebec: 'qc',
  saskatchewan: 'sk', yukon: 'yt',
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co',
  connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id',
  illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la',
  maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn',
  mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv',
  'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny',
  'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or',
  pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc', 'south dakota': 'sd',
  tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa',
  'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy',
};
const KNOWN_REGIONS = new Set([...Object.keys(REGION_ABBR), ...Object.values(REGION_ABBR)]);

// Every spelling of a region, so "ON" and "Ontario" compare equal.
function regionKeys(state) {
  const out = new Set();
  const s = normLoc(state);
  if (!s) return out;
  out.add(s);
  if (REGION_ABBR[s]) out.add(REGION_ABBR[s]);
  for (const [full, abbr] of Object.entries(REGION_ABBR)) if (abbr === s) out.add(full);
  return out;
}

// Country canonicalisation. Deliberately split in two: a COUNTRY FIELD may safely be a bare ISO2
// code, but a trailing option component may NOT — "CA" is California as often as Canada, "IN" is
// Indiana, "DE" is Delaware. Reading ISO2 out of an option tail is how a matcher talks itself into
// the wrong country, so the option side accepts only unambiguous spellings.
const COUNTRY_FULL = {
  canada: 'canada',
  'united states': 'united states', 'united states of america': 'united states',
  usa: 'united states', 'u s a': 'united states', 'u s': 'united states', america: 'united states',
  'united kingdom': 'united kingdom', uk: 'united kingdom', 'u k': 'united kingdom',
  'great britain': 'united kingdom', britain: 'united kingdom', england: 'united kingdom',
  scotland: 'united kingdom', wales: 'united kingdom',
  australia: 'australia', india: 'india', ireland: 'ireland', germany: 'germany',
  deutschland: 'germany', france: 'france', netherlands: 'netherlands', holland: 'netherlands',
  spain: 'spain', espana: 'spain', mexico: 'mexico', brazil: 'brazil', brasil: 'brazil',
  'new zealand': 'new zealand', singapore: 'singapore',
};
const COUNTRY_ISO2 = {
  ca: 'canada', us: 'united states', gb: 'united kingdom', au: 'australia', in: 'india',
  ie: 'ireland', de: 'germany', fr: 'france', nl: 'netherlands', es: 'spain', mx: 'mexico',
  br: 'brazil', nz: 'new zealand', sg: 'singapore',
};
function canonCountryFromProfile(s) {
  const n = normLoc(s);
  if (!n) return null;
  return COUNTRY_FULL[n] || COUNTRY_ISO2[n] || null;
}
function canonCountryFromOptionTail(s) {
  const n = normLoc(s);
  if (!n) return null;
  return COUNTRY_FULL[n] || null;      // never ISO2 here — see the note above
}

// Choose the option that is the profile's OWN city, or refuse.
//
// `optionTexts` are the visible option strings ("Toronto, Ontario, Canada"); `hint` is
// { city, state, country } straight off the profile. Returns an index, or -1 meaning
// "not sure — leave the field alone" (rule 1).
//
// A wrong country or a wrong province is a HARD VETO, never merely a lower score: no amount of
// prefix similarity makes Toronto/Ohio the right answer for someone in Toronto/Ontario. Among the
// survivors the best evidence tier wins, and a TIE AT THE BEST TIER IS AMBIGUOUS — it returns -1
// rather than guessing, which is what the old first-match-wins pick did.
export function pickLocationIndex(optionTexts, hint) {
  const list = Array.isArray(optionTexts) ? optionTexts : [];
  // The hint's "city" is whatever the user typed into a City box, and on the live profile that
  // is literally "Toronto, ON" — a city PLUS its region. normLoc keeps the comma, so the head
  // test below ("toronto" !== "toronto, on") vetoed EVERY option and the field was left blank on
  // every Greenhouse/Lever/Ashby posting (trace: `left-empty (typeahead no match)`). Split the
  // hint the same way the options are split: the leading component is the city, the rest is
  // extra region/country evidence — used only to FILL IN what the profile didn't state, never
  // to override it (an explicit state stays authoritative, so "Toronto, CA" can't invent
  // California for someone whose profile says Ontario).
  const hintParts = normLoc(hint?.city).split(',').map((p) => p.trim()).filter(Boolean);
  const city = hintParts[0] || '';
  if (!city || !list.length) return -1;
  const wantRegion = regionKeys(hint?.state);
  if (!wantRegion.size) {
    for (const extra of hintParts.slice(1)) for (const k of regionKeys(extra)) wantRegion.add(k);
  }
  // Full spellings only from the suffix (canonCountryFromOptionTail, not …FromProfile): "CA" in
  // a city string is California as often as Canada, and guessing there is how the wrong country
  // gets picked. An explicit profile country always wins.
  const wantCountry = canonCountryFromProfile(hint?.country)
    || (hintParts.length > 1 ? canonCountryFromOptionTail(hintParts[hintParts.length - 1]) : null);

  let best = -1, bestTier = -1, bestCount = 0;
  for (let i = 0; i < list.length; i++) {
    const parts = normLoc(list[i]).split(',').map((p) => p.trim()).filter(Boolean);
    if (!parts.length) continue;
    const head = parts[0];
    // The city must BE the option's leading component, not merely appear somewhere in it.
    if (head !== city && !head.startsWith(city + ' ')) continue;

    const tail = parts.length > 1 ? parts[parts.length - 1] : '';
    const optCountry = canonCountryFromOptionTail(tail);
    if (wantCountry && optCountry && optCountry !== wantCountry) continue;     // VETO: wrong country

    // Region candidates: everything between the city and the country, plus the tail itself when
    // the option is the two-part "City, Region" shape.
    const mids = parts.slice(1, Math.max(1, parts.length - 1));
    const regionCands = parts.length === 2 ? [tail] : mids;
    let regionHit = false, regionConflict = false;
    for (const r of regionCands) {
      if (wantRegion.has(r)) { regionHit = true; break; }
      if (KNOWN_REGIONS.has(r)) regionConflict = true;
    }
    if (wantRegion.size && regionConflict && !regionHit) continue;             // VETO: wrong region

    const tier = (regionHit ? 2 : 0) + (wantCountry && optCountry === wantCountry ? 1 : 0);
    if (tier > bestTier) { bestTier = tier; best = i; bestCount = 1; }
    else if (tier === bestTier) bestCount++;
  }
  if (best < 0 || bestCount !== 1) return -1;     // nothing survived, or the best tier is a tie
  return best;
}

// Parse a money range out of free text: "CAD 110,000-140,000", "$85,000 – $110,000 a year",
// "110k-140k", "$60/hr". Returns { min, max, currency, interval, known } with everything
// ANNUALISED, because comparing a raw 60 against 110000 would be nonsense.
// `known:false` is the honest answer whenever we cannot be sure — and nothing ever blocks on an
// unknown (the same one-directional rule app/src/salary.js is built around).
export function parseMoneyRange(text) {
  const miss = { min: null, max: null, currency: null, interval: null, known: false };
  let s = String(text == null ? '' : text);
  if (!s.trim()) return miss;
  s = s.replace(/[‒-―−]/g, '-');        // en/em dashes → hyphen

  const code = (s.match(/\b(CAD|USD|EUR|GBP|AUD)\b/i) || [])[1];
  const sym = (s.match(/(C\$|US\$|£|€)/) || [])[1];
  const SYM = { 'C$': 'CAD', 'US$': 'USD', '£': 'GBP', '€': 'EUR' };
  const currency = code ? code.toUpperCase() : (sym ? SYM[sym] : null);

  const interval = /(per\s*hour|hourly|\/\s*hr\b|\ban?\s*hour\b|\bhr\b)/i.test(s) ? 'hour'
    : /(per\s*month|monthly|\/\s*mo\b|\ba\s*month\b)/i.test(s) ? 'month'
      : /(per\s*year|per\s*annum|annually|annual|\/\s*yr\b|\ba\s*year\b)/i.test(s) ? 'year' : null;

  const nums = [];
  const rx = /(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/gi;
  let m;
  while ((m = rx.exec(s))) {
    let n = Number(String(m[1]).replace(/,/g, ''));
    if (!Number.isFinite(n) || n <= 0) continue;
    if (m[2]) n *= 1000;
    nums.push(n);
  }
  if (!nums.length) return miss;

  // A bare small number carrying NO currency and NO interval is not evidence of a salary — "2026"
  // would otherwise infer as a monthly rate and annualise to six figures. Require one real signal.
  const top = Math.max(...nums);
  if (!currency && !interval && top < 10000) return miss;

  // Annualise. An explicit interval wins; otherwise infer from magnitude, with wide bands
  // chosen so a misread errs HIGH (i.e. toward not blocking).
  const eff = interval || (top < 500 ? 'hour' : top < 25000 ? 'month' : 'year');
  const mul = eff === 'hour' ? 2080 : eff === 'month' ? 12 : 1;
  const scaled = nums.map((n) => n * mul);
  const min = Math.min(...scaled), max = Math.max(...scaled);
  if (max < 10000) return miss;               // not a salary — a price, a year, a count
  return { min, max, currency, interval: eff, known: true };
}

// Would writing `profileValue` into this posting anchor BELOW what the posting itself offers?
// True only when both sides parse AND the top of the profile's own ask is no better than the
// bottom of the posted band — i.e. the entire ask sits at or under the posting's floor. That is
// the exact live shape: asking "CAD 85,000–110,000" on a posting that opens at CAD 110,000.
// Unknown, unparseable, or different-currency → FALSE (never block on a guess).
export function salaryWouldUndercut(profileValue, postedText) {
  const mine = parseMoneyRange(profileValue);
  const posted = postedText && typeof postedText === 'object' && postedText.known
    ? postedText : parseMoneyRange(postedText);
  if (!mine.known || !posted.known) return false;
  if (mine.currency && posted.currency && mine.currency !== posted.currency) return false;
  const myTop = mine.max != null ? mine.max : mine.min;
  if (myTop == null || posted.min == null) return false;
  return myTop <= posted.min;
}

// SHOULD WE REFUSE TO UPLOAD THIS FILE AS A RÉSUMÉ?
//
// The attach path had NO check: whatever bytes the default 'resume' document holds were sent to
// the employer under whatever name, type and size they carried. A photo stored as the résumé
// document would be uploaded to a real employer as the applicant's résumé, and an oversized file
// is rejected by the ATS with a message the run then has to interpret.
//
// Returns a human-readable reason to refuse, or null to proceed. Pure, so it is testable without
// a browser (executor.js cannot be imported under node).
//
// NOTE ON THE REPORTED SYMPTOM: the queue row reading
//     "Resume Uploading... fileuploaded.jpg Upload failed. Max size for files is 10 MB."
// is the upload widget's OWN on-screen chatter scraped as a question label — 'fileuploaded.jpg'
// is the site's placeholder text, not a file JAT chose. That is a label-scraping bug (see
// isJunkQuestionText / UPLOAD_CHATTER_RX), not proof that an image was ever attached. This guard
// exists because nothing prevented it, not because it was observed.
const RESUME_DOC_EXT = new Set(['pdf', 'doc', 'docx', 'rtf', 'txt', 'odt', 'pages']);
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'tif', 'tiff', 'svg'];
export const MAX_RESUME_UPLOAD_BYTES = 10 * 1024 * 1024;   // the limit the live failure reported
export function resumeUploadRefusal({ name, mime, bytes } = {}) {
  const fileName = String(name || '');
  const type = String(mime || '');
  const ext = (fileName.match(/\.([a-z0-9]+)\s*$/i) || [, ''])[1].toLowerCase();
  const isImage = /^image\//i.test(type) || IMAGE_EXT.includes(ext);
  if (isImage) return `the résumé on file is "${fileName || 'unnamed'}" (${type || 'image'}) — an image, not a résumé document`;
  if (ext && !RESUME_DOC_EXT.has(ext)) return `the résumé on file is "${fileName}" (.${ext}) — not a résumé document`;
  if (!ext && type && !/pdf|word|officedocument|rtf|text|opendocument/i.test(type)) {
    return `the résumé on file has an unusable type (${type})`;
  }
  const n = Number(bytes);
  if (Number.isFinite(n) && n > MAX_RESUME_UPLOAD_BYTES) {
    return `the résumé on file is ~${(n / 1048576).toFixed(1)} MB — over the 10 MB limit most ATSs enforce`;
  }
  return null;
}

// Does this control demand a plain NUMBER rather than free text?
//
// Live block reason: "Enter a decimal number larger than 0.0". A range string
// ("CAD 115,000–140,000") in a numeric field never validates, so the field stays blocking and
// the task re-parks on every retry — one of the jobs in the queue is stuck on exactly this.
export function isNumericField(input) {
  try {
    if (!input) return false;
    if (String(input.type || '').toLowerCase() === 'number') return true;
    const im = String(input.getAttribute?.('inputmode') || '').toLowerCase();
    if (im === 'numeric' || im === 'decimal') return true;
    const pat = String(input.getAttribute?.('pattern') || '');
    if (pat && /^\^?\[?\\?d|\\d[*+{]/.test(pat) && !/[a-z]/i.test(pat.replace(/\\d/g, ''))) return true;
    return false;
  } catch { return false; }
}

// DERIVE THE SALARY ASK FOR *THIS* POSTING.
//
// The profile holds one static band (CAD 115,000–140,000) and it was written verbatim into every
// salary field. Pierre asked for this to depend on the job: "you can set it to whatever amount you
// want… wherever it depends really on the job. So try to make it more dynamic than just hard."
//
// RULES, in order:
//   1. Posting states a range  → ask within its UPPER HALF, never below its floor. (There is
//      already logic refusing to write BELOW a posted range — salaryWouldUndercut; this replaces
//      "skip" with "ask properly".)
//   2. Posting states nothing  → fall back to the profile band.
//   3. Never below the profile band's own floor, whatever the posting says.
//   4. Respect the FIELD SHAPE — a numeric field gets ONE number, never a range string.
//
// Intervals are preserved: parseMoneyRange annualises internally, so an hourly posting is
// de-annualised before it is written back, or an hourly field would receive a yearly figure.
// Returns null when there is nothing honest to say (no profile band and no posted range).
const PER_YEAR = { hour: 2080, month: 12, year: 1 };
function roundMoney(n, interval) {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (interval === 'hour') return Math.round(n);              // $/hr — whole dollars
  if (interval === 'month') return Math.round(n / 100) * 100; // $/mo — nearest hundred
  return Math.round(n / 1000) * 1000;                         // $/yr — nearest thousand
}
export function deriveSalaryAsk(profileValue, posted, opts = {}) {
  const numeric = !!opts.numeric;
  const mine = parseMoneyRange(profileValue);
  const post = (posted && typeof posted === 'object' && posted.known)
    ? posted : parseMoneyRange(posted);

  // Everything below is in ANNUALISED money; `interval` decides how it is written back.
  const myFloor = mine.known ? (mine.min != null ? mine.min : mine.max) : null;
  const myTop = mine.known ? (mine.max != null ? mine.max : mine.min) : null;

  let low, high, interval, currency;
  if (post.known && post.min != null && post.max != null) {
    // RULE 1 — the upper half of the posting's own band.
    const mid = (post.min + post.max) / 2;
    low = Math.max(mid, post.min);
    high = Math.max(post.max, low);
    interval = post.interval || 'year';
    currency = post.currency || mine.currency || null;
    // RULE 3 — never below his own floor, even if the posting pays less.
    if (myFloor != null && low < myFloor) { low = myFloor; high = Math.max(high, myFloor); }
  } else if (mine.known) {
    // RULE 2 — no posted range: the profile band, unchanged.
    low = myFloor; high = myTop != null ? myTop : myFloor;
    interval = mine.interval || 'year';
    currency = mine.currency || null;
  } else {
    return null;   // nothing stated anywhere — say nothing
  }
  if (!Number.isFinite(low) || low <= 0) return null;

  const div = PER_YEAR[interval] || 1;
  const lo = roundMoney(low / div, interval);
  const hi = roundMoney(high / div, interval);
  if (lo == null) return null;

  // RULE 4 — one number for a numeric field. The LOW end of the derived ask: it is the minimum
  // being asked for, and by construction it is below neither the posted floor nor the profile floor.
  if (numeric) return String(lo);
  const fmt = (n) => n.toLocaleString('en-CA');
  const suffix = interval === 'hour' ? ' / hour' : interval === 'month' ? ' / month' : '';
  const cur = currency ? `${currency} ` : '';
  if (hi == null || hi <= lo) return `${cur}${fmt(lo)}${suffix}`;
  return `${cur}${fmt(lo)}–${fmt(hi)}${suffix}`;
}

// Read the posting's OWN stated pay band off the page. DOM-touching (so not pure), bounded, and
// failure-tolerant: null simply means "no stated range", which never blocks a write.
export function findPostedSalaryRange(root) {
  try {
    const doc = root && root.body ? root : (typeof document !== 'undefined' ? document : null);
    const body = doc?.body || doc;
    if (!body) return null;
    const text = String(body.innerText || body.textContent || '').slice(0, 40000);
    if (!text) return null;
    const RANGE = /(?:[$£€]|\b(?:CAD|USD|EUR|GBP|AUD)\b)[^\n]{0,40}?\d[\d,.]*\s*k?\s*(?:-|to)\s*[^\n]{0,20}?\d[\d,.]*\s*k?/i;
    const CONTEXT = /(salary|compensation|pay\s*range|pay\s*band|base\s*pay|hiring\s*range|remuneration|per\s*year|per\s*annum|annually|a\s*year)/i;
    for (const raw of text.replace(/[‒-―−]/g, '-').split(/\n+/)) {
      const line = raw.trim();
      if (!line || line.length > 300) continue;
      if (!RANGE.test(line)) continue;
      const parsed = parseMoneyRange(line);
      if (!parsed.known || parsed.min == null) continue;
      // Require either salary wording nearby or a magnitude only a salary reaches, so a price
      // list can never masquerade as the posted band.
      if (!CONTEXT.test(line) && parsed.min < 30000) continue;
      return parsed;
    }
    return null;
  } catch { return null; }
}

// Fill custom comboboxes / typeaheads / react-selects (Workday, Greenhouse, Lever, and
// LinkedIn's own dropdowns INCLUDING the "Location (city)" typeahead — the #1 ATS gap).
// You can't just TYPE these: LinkedIn requires you to PICK a suggestion, and that list
// renders ASYNC after typing — so we type, WAIT for the options, then click the match.
// FULLY wrapped: any failure is a no-op (field left for the AI/park path) — never regresses.
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// A react-select is the widget class that DISPLAYS typed text while holding no value — the exact
// shape behind the "Select a country" bounce. LinkedIn's .basic-typeahead is deliberately NOT in
// here: it stores its value on the input itself, so it keeps the original, proven behaviour.
const REACT_SELECT_SEL = '[class*="select__control"],[class*="react-select"],[class*="-control"]';
export function isReactSelect(el) {
  try { return !!el?.closest?.(REACT_SELECT_SEL); } catch { return false; }
}

// Did the widget actually COMMIT a selection? react-select renders the committed choice as
// .select__single-value / .select__multi-value (emotion builds spell it singleValue/multiValue).
// The typed text living in the input proves nothing — on commit the input goes back to empty.
export function comboboxCommitted(el) {
  try {
    const ctrl = el?.closest?.(REACT_SELECT_SEL);
    if (!ctrl) return false;
    const sv = ctrl.querySelector?.(
      '[class*="single-value"],[class*="singleValue"],[class*="multi-value"],[class*="multiValue"]');
    return !!(sv && String(sv.textContent || '').trim());
  } catch { return false; }
}

// ── OPTION-LIST HYGIENE (2026-08-24) ─────────────────────────────────────────────────────────
// The option selector below carries `[class*="-option"]`, which is a SUBSTRING match on the whole
// class attribute. react-select renders its empty state as
//     <div class="select__menu-notice select__menu-notice--no-options …">No options</div>
// and "--no-optionS" contains "-option", so the notice counted as an option. Measured live on
// Greenhouse/faire: the wait loop saw 1 "option" at iteration 0, stopped waiting immediately,
// matched nothing, and reported "typeahead no match". A notice is not an option.
const OPTION_SEL = '[role="option"], [role="listbox"] li, [class*="typeahead"] [role="option"], [class*="typeahead-result"], .basic-typeahead__selectable, [class*="select__option"], [class*="-option"], li[role="option"]';
const NOT_AN_OPTION_SEL = '[class*="menu-notice"],[class*="no-options"],[class*="noOptions"],[class*="loadingMessage"],[class*="loading-message"],[class*="placeholder"],[class*="indicator"]';
const EMPTY_NOTICE_RX = /^(no options?|no results?( found)?|loading[.…]*|aucun r[ée]sultat|type to search|start typing)/i;
function realOptions(nodes) {
  return nodes.filter((o) => {
    try {
      if (!o || o.offsetParent === null) return false;
      const t = String(o.textContent || '').trim();
      if (!t) return false;
      if (o.matches?.(NOT_AN_OPTION_SEL)) return false;
      if (EMPTY_NOTICE_RX.test(t)) return false;
      return true;
    } catch { return false; }
  });
}

// WHERE this control's own option list lives. Searching the whole document is why an async
// typeahead never waited: any other widget's open menu (or the page's own hidden 244-item phone
// country list) satisfied "options exist" on the first tick. Prefer the listbox the control
// itself points at (react-select sets aria-controls once open), then its shell; only fall back
// to the document, and only after a real wait, for widgets that portal their menu to <body>.
const OPTION_SCOPE_SEL = '[class*="select-shell"],[class*="select__container"],[class*="react-select__container"],[data-select]';
function optionScopeFor(el) {
  try {
    const ref = el.getAttribute?.('aria-controls') || el.getAttribute?.('aria-owns') || '';
    for (const id of ref.split(/\s+/).filter(Boolean)) {
      const lb = el.ownerDocument?.getElementById?.(id);
      if (lb && realOptions(qsa(OPTION_SEL, lb)).length) return lb;
    }
    return el.closest?.(OPTION_SCOPE_SEL) || null;
  } catch { return null; }
}

// A "Select all that apply" react-select. Its committed values render as .select__multi-value
// chips and its value container is tagged --is-multi; the listbox may also say so via ARIA.
export function isMultiCombobox(el) {
  try {
    const ctrl = el?.closest?.(REACT_SELECT_SEL) || el?.closest?.(OPTION_SCOPE_SEL);
    if (ctrl && ctrl.querySelector?.('[class*="value-container--is-multi"],[class*="valueContainer--is-multi"],[class*="multi-value"],[class*="multiValue"]')) return true;
    if (el?.getAttribute?.('aria-multiselectable') === 'true') return true;
    const ref = el?.getAttribute?.('aria-controls') || '';
    const lb = ref ? el.ownerDocument?.getElementById?.(ref.split(/\s+/)[0]) : null;
    return lb?.getAttribute?.('aria-multiselectable') === 'true';
  } catch { return false; }
}
function committedChips(el) {
  try {
    const ctrl = el?.closest?.(REACT_SELECT_SEL) || el?.closest?.(OPTION_SCOPE_SEL);
    if (!ctrl) return [];
    return Array.from(ctrl.querySelectorAll('[class*="multi-value"],[class*="multiValue"]'))
      .map((n) => String(n.textContent || '').trim()).filter(Boolean);
  } catch { return []; }
}

// A multi answer arrives as one string ("Fullstack, Backend, Frontend"). Split it into the values
// the widget is actually asked to hold. Deliberately conservative: an option text may itself
// contain a comma ("Toronto, Ontario, Canada"), so a single value that matches an option whole
// is never split — the caller tries the WHOLE string first.
export function splitMultiValue(v) {
  return String(v == null ? '' : v)
    .split(/\s*(?:[;|/]|,| and )\s*/i)
    .map((s) => s.trim()).filter((s) => s.length > 1);
}

// The pointer sequence that OPENS a react widget. A bare .click() leaves aria-expanded="false"
// on Indeed's smartapply country dropdown (measured 2026-07-20) — React binds pointer events.
function openWidget(el) {
  try {
    ['pointerover', 'mouseover', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']
      .forEach((ev) => el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window })));
  } catch {
    try { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch {}
    try { el.click?.(); } catch {}
  }
}
function typeInto(el, v) {
  try { setNativeValue(el, v); } catch {}
  try { el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: v.slice(-1) })); } catch {}
  try { el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: v.slice(-1) })); } catch {}
}

// WAIT for THIS control's option list to actually populate (async typeaheads fetch remotely).
// Scoped-first: only after 5 ticks (~1.25s) of our own menu staying empty do we consider a
// document-wide list, which is the portalled-menu case.
const OPTION_WAIT_TICKS = 14;         // ~3.5s total, unchanged
const SCOPE_FALLBACK_AFTER = 5;       // ~1.25s before a document-wide list may be trusted
async function waitForOptions(el, ticks = OPTION_WAIT_TICKS) {
  let opts = [];
  for (let i = 0; i < ticks; i++) {
    const scope = optionScopeFor(el);
    opts = realOptions(qsa(OPTION_SEL, scope || document));
    if (opts.length) return opts;
    if (scope && i >= SCOPE_FALLBACK_AFTER) {
      const portalled = realOptions(qsa(OPTION_SEL, document));
      if (portalled.length) return portalled;
    }
    await sleepMs(250);
  }
  return opts;
}

// Choose the option this value means, or null. Location resolves by region+country (rule 2) and
// AMBIGUITY ABANDONS; everything else is exact → prefix → contains → numeric-range.
function bestOptionFor(opts, v, hint) {
  const txt = (o) => (o.textContent || '').trim().toLowerCase();
  const vl = String(v).trim().toLowerCase();
  if (hint && hint.city) {
    const li = pickLocationIndex(opts.map(txt), hint);
    return li < 0 ? null : opts[li];
  }
  let pick = opts.find((o) => txt(o) === vl)
    || opts.find((o) => txt(o).startsWith(vl) && vl.length > 1)
    || opts.find((o) => vl.startsWith(txt(o)) && txt(o).length > 2)
    || opts.find((o) => txt(o).includes(vl) && vl.length > 2);
  // A yes/no answer against PROSE options (Affirm's "I have not previously been employed at
  // Affirm" / "I have been employed at Affirm as …"). None of the tiers above can reach it — the
  // substring tier is switched off for a 2-character value — so resolve it by polarity, and only
  // when exactly one option carries the wanted polarity. See matchPolarityOption.
  if (!pick) {
    const pi = matchPolarityOption(opts.map(txt), v);
    if (pi >= 0) pick = opts[pi];
  }
  // A numeric answer against RANGE options ("6" vs "5-10 years") matches nothing textually —
  // resolve it by arithmetic instead, else the widget stays unselected and the form won't advance.
  if (!pick) {
    const ri = matchNumericRangeOption(v, opts.map((o) => txt(o)));
    if (ri >= 0) pick = opts[ri];
  }
  return pick || null;
}
function clickOption(pick) {
  try { pick.scrollIntoView?.({ block: 'nearest' }); } catch {}
  try { pick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch {}
  try { pick.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch {}
  try { pick.click?.(); } catch {}
}
function pressEnter(el) {
  for (const type of ['keydown', 'keyup']) {
    try { el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })); } catch {}
  }
}

// fillCombobox(el, value, cfg?)
//   cfg.locationHint  { city, state, country } — when present the option pick is resolved by
//                     pickLocationIndex (region/country qualified) instead of first-prefix-wins,
//                     and AMBIGUITY ABANDONS rather than guesses.
//   cfg.trace         optional (reason) => void — observability only. The old code returned a
//                     bare false, so every abandonment was logged as "typeahead no match" even
//                     when the options were right there and the LABEL had been misclassified.
//
// RULE 1 (2026-08-23): every abandoned path now RESTORES the field to exactly what it was found
// as. Previously the value was typed in first and the failure path returned false without
// clearing it, so a react-select was left displaying "Toronto" / "Canada" with no committed
// value — the form looked filled and submitted wrong. A blank required field is honest.
export async function fillCombobox(el, value, cfg) {
  let typed = false, before = '';
  const trace = (cfg && typeof cfg.trace === 'function') ? cfg.trace : () => {};
  const revert = (why) => {
    try { trace(why || 'no-match'); } catch {}
    try { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch {}
    if (typed) {
      // A contentEditable combobox holds its text in the node, not in .value — restoring it
      // through the input setter would leave the typed text on screen.
      if (el.isContentEditable) {
        try { el.textContent = before; el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
      } else {
        try { setValueRaw(el, before, false); } catch {}
      }
      try { _jatFilledFields.delete(el); } catch {}   // we did NOT answer it — don't claim we did
    }
    try { el.blur?.(); } catch {}
    return false;
  };
  try {
    if (isSiteChromeInput(el)) return false;   // never type into the global search typeahead
    const v = String(value == null ? '' : value).trim();
    if (!v) return false;
    const hint = cfg && typeof cfg === 'object' ? cfg.locationHint : null;
    const typeable = el.tagName === 'INPUT' || el.isContentEditable;
    if (typeable) before = el.isContentEditable ? String(el.textContent || '') : String(el.value == null ? '' : el.value);

    // ── MULTI ("Select all that apply") ──────────────────────────────────────────────────────
    // One answer string holds several values. Typing the whole thing filters the menu to
    // nothing ("No options") — which is exactly what the live Greenhouse trace reported as an
    // "un-pickable widget". Commit each value in turn instead.
    if (isMultiCombobox(el)) {
      const startedWith = committedChips(el).length;
      // Try the WHOLE string first: an option may legitimately contain a comma.
      const wanted = [v, ...splitMultiValue(v).filter((s) => s.toLowerCase() !== v.toLowerCase())];
      const taken = new Set();
      let first = true;
      for (const want of wanted) {
        if (committedChips(el).length > startedWith && want === v) continue;   // whole-string already took
        el.focus?.();
        openWidget(el);
        typed = typeable;
        typeInto(el, want);
        // The FIRST attempt gets the full async budget; once the widget has proven it renders a
        // menu at all, later values need a short wait, not another 3.5s each (a 3-value answer
        // that matches nothing took 14s before this).
        const opts = await waitForOptions(el, first ? OPTION_WAIT_TICKS : 4);
        first = false;
        if (!opts.length) continue;
        const pick = bestOptionFor(opts.filter((o) => !taken.has((o.textContent || '').trim())), want, null);
        if (!pick) continue;
        taken.add((pick.textContent || '').trim());
        clickOption(pick);
        await sleepMs(150);
        if (committedChips(el).length <= startedWith + taken.size - 1) { pressEnter(el); await sleepMs(150); }
        if (want === v && committedChips(el).length > startedWith) break;      // whole string was one option
      }
      const gained = committedChips(el).length - startedWith;
      // PARTIAL SUCCESS IS SUCCESS HERE. A required "select all that apply" is satisfied by one
      // real selection; leaving it blank because two of three values had no matching option is a
      // guaranteed park. Nothing committed at all → rule 1: put the field back the way it was.
      if (gained <= 0) return revert('multi: no value matched an option');
      typed = false;                       // react-select clears its own input on each commit
      try { el.blur?.(); } catch {}
      trace(gained < wanted.length - 1 ? `multi: committed ${gained} of ${splitMultiValue(v).length}` : `multi: committed ${gained}`);
      return true;
    }

    // ── SINGLE ───────────────────────────────────────────────────────────────────────────────
    el.focus?.();
    openWidget(el);
    // Typeable combobox/typeahead (location, etc.): type the value to trigger suggestions.
    // Remember what was there first — every failure path below puts it back.
    if (typeable) { typed = true; typeInto(el, v); }
    const opts = await waitForOptions(el);
    if (!opts.length) return revert('no options rendered');
    // LOCATION: first-prefix-wins picked "Toronto, Ohio, United States" over
    // "Toronto, Ontario, Canada" purely because Ohio sorts first. Resolve by region+country,
    // and treat "cannot be sure" as a reason to leave the field ALONE (rule 1), not to guess.
    const pick = bestOptionFor(opts, v, hint);
    if (!pick) return revert(hint && hint.city ? 'location: no option is the profile city' : 'no matching option');
    clickOption(pick);
    await sleepMs(150);
    // VERIFY THE COMMIT — react-select only. The click may highlight without selecting; the input
    // still shows the typed text either way, so trusting it is what produced a form that looked
    // filled and submitted empty. Read the control's own committed value instead, and if the
    // click didn't take, press Enter on the focused option (the react-select keyboard commit)
    // before giving up. Non-react-select widgets keep the original, proven behaviour.
    if (isReactSelect(el)) {
      if (!comboboxCommitted(el)) { pressEnter(el); await sleepMs(150); }
      if (!comboboxCommitted(el)) return revert('option clicked but nothing committed');
    }
    return true;
  } catch { return revert('error'); }
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
  // `onSkip(reason, input, label)` is an OPTIONAL diagnostic side-channel (behavior-neutral).
  // It exists because "fillable=0 while a required control blocks the step" is the dominant
  // live park and could not be reproduced in the harness — so the engine has to say WHY it
  // passed over every field. Only the executor's trace consumes it, and only when nothing
  // was fillable.
  async scanFillable(rootEl, onSkip) {
    const profile = await this.getProfile();
    const out = [];
    const skip = (reason, input, label) => { try { onSkip?.(reason, input, label); } catch {} };
    for (const input of this.fields(rootEl)) {
      if (!isFillable(input)) { skip('not-fillable', input); continue; }
      if (isSiteChromeInput(input)) { skip('site-chrome', input); continue; }   // never touch the global search bar / header chrome
      // NOTE on radios reading as "already-has-value" here: that is BY DESIGN, not a bug.
      // A radio reports the browser default "on" even when unchecked, so it trips this test —
      // and that is fine, because radios are deliberately NOT handled by scanFillable at all.
      // They need an OPTION SELECTED, not a profile string typed in, so scanUnknown routes them
      // to the answer path (groundedEligibilityAnswer / AI → pickRadioInGroup) using the GROUP's
      // question via radioGroupLabel(). Pulling them in here makes fieldLabel() return the
      // per-option text ("Yes"), which is the "yes yes q_<id>" garbage that once parked every
      // Indeed job — the indeed-smartapply-radios fixtures fail immediately if that regresses.
      if (input.tagName !== 'SELECT' && input.value && String(input.value).trim() && !looksPrefilledPlaceholder(input)) { skip('already-has-value', input); continue; }
      if (input.tagName === 'SELECT' && input.selectedIndex > 0) { skip('select-already-chosen', input); continue; }
      if ((input.type === 'checkbox' || input.type === 'radio') && input.checked) { skip('already-checked', input); continue; }
      const label = fieldLabel(input);
      if (!label) { skip('no-label', input); continue; }
      if (UI_INSTRUCTION_RX.test(label)) { skip('ui-instruction-text', input, label); continue; }
      if (NEVER_AUTOFILL_RX.test(label)) { skip('never-autofill', input, label); continue; }
      const pm = profileFieldFor(label, profile || {});
      if (pm) { out.push({ input, label, source: 'profile', field: pm.field, value: pm.value }); continue; }
      const qa = await this.lookupAnswer(label);
      if (qa?.answer) { out.push({ input, label, source: 'qa', value: qa.answer, qa }); continue; }
      skip('no-profile-or-qa-answer', input, label);
    }
    return out;
  }

  // Empty fields we have NO answer for — the executor escalates these to AI.
  async scanUnknown(rootEl) {
    const profile = await this.getProfile();
    const out = [];
    const seenRadioGroups = new Set();
    const seenCheckboxGroups = new Set();
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
        // A LONE checkbox is a consent box — never auto-decided (unchanged). A checkbox GROUP
        // ("How did you hear about us? Select all that apply") is a real screening QUESTION, and
        // skipping it outright is why Greenhouse's required group was invisible to the scan and
        // only ever surfaced as an unanswerable park at native validation. Surface the group
        // ONCE, with its legend as the question and its boxes as the options.
        const members = checkboxGroupMembers(input, rootEl);
        if (members.length < 2) continue;
        const gid = input.name || members[0]?.id || '';
        if (seenCheckboxGroups.has(gid)) continue;
        seenCheckboxGroups.add(gid);
        if (members.some((m) => m.checked)) continue;
      } else if (input.tagName === 'SELECT') {
        if (input.selectedIndex > 0 && input.value) continue;
      } else if (input.value && String(input.value).trim() && !looksPrefilledPlaceholder(input)) {
        continue;
      }
      // For radios, the per-option <label> is just "Yes"/"No" — use the group's
      // legend/question instead so the screening question is actually surfaced. Radios NEVER
      // fall back to fieldLabel (that produced the "yes yes q_<id>" garbage on smartapply →
      // the AI got a non-question → parked every Indeed job). SELECTs use the prompt-recovering
      // resolver (id-shaped names → heading walk-up). A radio with no recoverable prompt is
      // skipped (length<4 below) rather than asked with garbage.
      let label;
      let groupOptions = null;
      if (input.type === 'radio') label = radioGroupLabel(input);
      else if (input.type === 'checkbox') {
        const g = checkboxGroupLabel(input, rootEl);
        label = g?.label || '';
        groupOptions = g?.options || null;
      } else if (input.tagName === 'SELECT') label = selectGroupLabel(input);
      else label = fieldLabel(input);
      if (!label || label.length < 4) continue;
      // Not a question → never ask it. Covers combobox screen-reader help, validation words,
      // button text, dropdown placeholders, leaked CSS and raw field names in one place.
      if (isJunkQuestionText(label)) continue;
      if (NEVER_AUTOFILL_RX.test(label)) continue;
      // (Generic site-search / global-search typeahead inputs are already skipped above
      // via isSiteChromeInput — they're never a real application question and would
      // falsely park the whole job at submit.)
      // Non-radio fields defer to the profile (a string we can type). RADIOS, however, need an
      // OPTION SELECTED, not a string typed — the profile stores text (e.g. the workAuthorization
      // sentence) that can't be typed into a Yes/No radio. So route radios to the answer path
      // (groundedEligibilityAnswer / AI → pickRadioInGroup) even when the profile "matches" the
      // group question, instead of skipping them here and silently leaving the group unanswered
      // (which blocked "Review"/"Next" → the "stuck on a step" failure).
      if (input.type !== 'radio' && profileFieldFor(label, profile || {})) continue;
      if (await this.lookupAnswer(label)) continue;
      // Required-detection: smartapply's loose Yes/No radios carry NO input.required/aria-required
      // (the marker lives on the prompt container), so they read as "optional" and the recover
      // path — which only grounds REQUIRED fields — skipped them → eligibility never answered.
      // ADDITIVE-OR with the prompt-container / prompt-text marker so they're treated as blocking.
      const required = input.required || input.getAttribute('aria-required') === 'true'
        || !!input.closest?.('[aria-required="true"], [class*="required" i], [data-required]')
        || /[*]|\brequired\b|\brequis\b|\bobligatoire\b/i.test(label);
      let options = null;
      if (input.tagName === 'SELECT') {
        options = Array.from(input.options).map((o) => (o.textContent || '').trim()).filter((t) => t && !/^select|^choose|^--/i.test(t)).slice(0, 30);
      } else if (input.type === 'radio' && input.name) {
        options = qsa(`input[type="radio"][name="${cssEscape(input.name)}"]`, rootEl || document)
          .map((r) => optionLabelText(r)).filter(Boolean).slice(0, 12);
      } else if (input.type === 'checkbox') {
        options = groupOptions;
      }
      out.push({ input, label: label.slice(0, 250), required, fieldType: input.type || input.tagName.toLowerCase(), options });
    }
    return out;
  }

  // fill(suggestions, onOutcome?) — fills each suggested field. `onOutcome` is an
  // OPTIONAL, behavior-neutral side-channel for forensic logging: it is invoked with
  // ({ suggestion, outcome, detail }) for every field (filled OR skipped) and its
  // return value is ignored. It NEVER changes what gets filled or the returned count —
  // it only observes (so the executor can write a per-field FILL-OUTCOME trace line).
  // outcome ∈ filled | fuzzy-snapped | skipped-no-option | skipped-not-yes |
  //          skipped-site-chrome | skipped-combobox-miss | skipped-salary-undercut | error.
  async fill(suggestions, onOutcome) {
    const emit = typeof onOutcome === 'function'
      ? (suggestion, outcome, detail) => { try { onOutcome({ suggestion, outcome, detail }); } catch {} }
      : () => {};
    // Read once per pass: the profile (to qualify a location by region+country) and the posting's
    // OWN stated pay band (so the profile's ask can never anchor below it). Both are best-effort —
    // a missing profile or an unstated range simply leaves the old behaviour in place.
    let profile = {};
    try { profile = (await this.getProfile?.()) || {}; } catch {}
    const locationHint = { city: profile.city, state: profile.state, country: profile.country };
    const posted = findPostedSalaryRange(null);
    let n = 0;
    for (const s of suggestions) {
      try {
        if (isSiteChromeInput(s.input)) { emit(s, 'skipped-site-chrome'); continue; }   // belt-and-suspenders: never fill site chrome
        let v = String(s.value);
        const isCombo = s.input.getAttribute && (s.input.getAttribute('role') === 'combobox'
          || (s.input.closest && s.input.closest('[class*="select__control"],[class*="react-select"],[class*="-control"],[class*="basic-typeahead"]')));
        // Indeed's searchable dropdown is a PLAIN <input type=text> — no role="combobox", no
        // react-select class — whose placeholder ("Search to select an option") is the only hint
        // that it expects a PICK, not typing. Typing into it leaves the widget unselected, so the
        // form refuses to advance while the field looks filled. Detected via the placeholder and
        // driven through the combobox path, with a fall-back to plain typing if no option list
        // ever appears, so a genuinely-free-text field can never regress.
        const isSearchableSelect = !isCombo && looksLikeSearchableSelect(s.input);
        // SALARY — derive the ask from THIS posting instead of writing the static profile band.
        // The old behaviour had two failure modes: it wrote the same band everywhere, and when
        // that band would undercut the posting it wrote NOTHING (leaving a required field empty).
        // deriveSalaryAsk keeps the anti-undercut guarantee — its floor is the posting's own —
        // while actually answering the field, and it emits a single number in a numeric field.
        if (s.field === 'salaryExpectation' || looksLikeSalaryLabel(s.label)) {
          const numeric = isNumericField(s.input);
          // Derive ONLY when there is something to derive FROM: a posted band, or a numeric
          // field that cannot take the band's range string. With neither, the profile value is
          // written verbatim exactly as before — no cosmetic reformatting of what Pierre typed.
          const ask = ((posted && posted.known) || numeric) ? deriveSalaryAsk(v, posted, { numeric }) : null;
          if (ask) { v = ask; emit(s, 'salary-derived', ask); }
          else if (salaryWouldUndercut(v, posted)) { emit(s, 'skipped-salary-undercut'); continue; }
          else if (numeric && !/^\d+(?:\.\d+)?$/.test(v.replace(/[,\s]/g, ''))) {
            // A numeric field with an unparseable band: writing a range string here can never
            // validate ("Enter a decimal number larger than 0.0") and re-parks the task forever.
            emit(s, 'skipped-salary-shape'); continue;
          }
        }
        if (s.input.tagName === 'SELECT') {
          const opt = matchOption(s.input, v);
          if (!opt) { emit(s, 'skipped-no-option'); continue; }
          // Committing a placeholder is a FAILURE, not a success: it sets nothing while the
          // field reports as answered. Same rule fillCombobox already applies to a react-select
          // it cannot commit — blank is honest, "Select an option" is a lie.
          if (isPlaceholderOption(opt)) { emit(s, 'skipped-placeholder-option'); continue; }
          setNativeValue(s.input, opt.value);
          // Detect a fuzzy snap: the chosen option text isn't an exact/substring of the value.
          const snapped = !(opt.value === v || opt.text === v
            || String(opt.value).toLowerCase() === v.toLowerCase()
            || String(opt.text).toLowerCase().trim() === v.toLowerCase().trim());
          emit(s, snapped ? 'fuzzy-snapped' : 'filled', snapped ? (opt.text || opt.value) : undefined);
        } else if (isCombo || isSearchableSelect) {
          // custom dropdown / typeahead (Workday/Greenhouse/Lever/LinkedIn location) — async.
          // RULE 2 — a location is resolved by region+country, never by "first option that starts
          // with the typed city" (that is how "Toronto" became Toronto, OHIO).
          let why = '';
          const cfg = { trace: (r) => { why = r; } };
          if (s.field === 'city' || looksLikeLocationLabel(s.label)) cfg.locationHint = locationHint;
          if (!(await fillCombobox(s.input, v, cfg))) {
            // RULE 1 — a react-select we could not COMMIT is left untouched. Typing into it makes
            // the field look answered while its value is empty, which submits wrong; blank is honest.
            if (!isSearchableSelect || isReactSelect(s.input)) { emit(s, 'skipped-combobox-miss', why); continue; }
            setNativeValue(s.input, v);          // no options appeared → it really was free text
            emit(s, 'filled');
          } else emit(s, 'filled', why || undefined);
        } else if (s.input.type === 'radio') {
          // Radio GROUPS (years-of-experience, work-authorization, salary band) are
          // not yes/no — pick the option in the group whose label best matches the
          // answer. Falls back to the old yes-token behaviour for boolean radios.
          const picked = pickRadioInGroup(s.input, v);
          const target = picked || (/^(yes|true|y|oui|sí|si|ja|1)$/i.test(v) ? s.input : null);
          if (!target) { emit(s, 'skipped-no-option'); continue; }
          // Through the native setter, verified, with a real click as fallback — a direct
          // `.checked = true` is invisible to React and silently reverts (see setNativeChecked).
          if (!setNativeChecked(target, true)) { emit(s, 'skipped-radio-uncommitted'); continue; }
          emit(s, 'filled');
        } else if (s.input.type === 'checkbox') {
          // A checkbox GROUP is a "select all that apply" question, not a yes/no consent: the
          // answer names one or more OPTIONS ("Job posting on LinkedIn, Indeed, or other job
          // board"). Tick every box whose label the answer names. Partial is still an answer —
          // the group is satisfied by one real tick, and a blank required group is a park.
          const members = checkboxGroupMembers(s.input, null);
          if (members.length > 1) {
            const labels = members.map((m) => normForFuzzy(optionLabelText(m)));
            // Tick AT MOST ONE box per named value. The whole answer is tried first, loosely
            // (an option is often worded differently); the comma-split parts are then tried
            // EXACT-only. Loose matching on the parts is how "Job posting on LinkedIn, Indeed,
            // or other job board" also ticked "Other" — two channels claimed from one answer.
            const tick = (want, loose) => {
              const w = normForFuzzy(want);
              if (!w || w.length < 2) return false;
              let idx = labels.findIndex((l, k) => l && l === w && !members[k].checked);
              if (idx < 0 && loose) idx = labels.findIndex((l, k) => l && (l.includes(w) || w.includes(l)) && !members[k].checked);
              if (idx < 0 && loose) idx = bestFuzzyIndex(labels.map((l, k) => (members[k].checked ? '' : l)), want);
              if (idx < 0 || !members[idx] || members[idx].checked) return false;
              return setNativeChecked(members[idx], true);
            };
            let ticked = 0;
            if (tick(v, true)) ticked++;
            for (const part of splitMultiValue(v)) if (tick(part, false)) ticked++;
            if (!ticked) { emit(s, 'skipped-no-option'); continue; }
            emit(s, 'filled', ticked > 1 ? `${ticked} boxes` : undefined);
            n++;
            continue;
          }
          const yes = /^(yes|true|y|oui|sí|si|ja|1)$/i.test(v);
          if (!yes) { emit(s, 'skipped-not-yes'); continue; }
          if (!setNativeChecked(s.input, true)) { emit(s, 'skipped-checkbox-uncommitted'); continue; }
          emit(s, 'filled');
        } else {
          setNativeValue(s.input, v);
          emit(s, 'filled');
        }
        n++;
      } catch (e) { emit(s, 'error', e?.message); }
    }
    return n;
  }

  // Record every (label, value) pair → qa store. Call on submit / step advance.
  async captureCurrentAnswers(rootEl, { source, jobId } = {}) {
    let n = 0;
    for (const input of this.fields(rootEl)) {
      if (!isFillable(input)) continue;
      if (input.type === 'radio' && !input.checked) continue;   // only the chosen option
      // Use the prompt-recovering resolver so the qa key is the real question (not "yes yes
      // q_<id>") — that's what makes a smartapply screening answer REUSABLE across jobs.
      let label;
      if (input.type === 'radio') label = radioGroupLabel(input);
      else if (input.tagName === 'SELECT') label = selectGroupLabel(input);
      else label = fieldLabel(input);
      if (!label || label.length < 3) continue;
      if (NEVER_AUTOFILL_RX.test(label)) continue;
      let value = '';
      if (input.tagName === 'SELECT') {
        const opt = input.options[input.selectedIndex];
        // An unset dropdown must not be captured as an answer. This is where "Select an option"
        // entered the record: the placeholder is options[0] and it is what a never-touched
        // select reports, so every untouched dropdown was captured as though it were answered.
        if (!opt || isPlaceholderOption(opt)) continue;
        value = opt.text || opt.value;
      } else if (input.type === 'checkbox' || input.type === 'radio') {
        if (!input.checked) continue;
        value = input.value || 'Yes';
      } else {
        value = String(input.value || '').trim();
      }
      if (!value || /^(\*+|•+)$/.test(value) || value.length > 1500) continue;
      if (isPlaceholderOptionText(value)) continue;   // belt-and-braces: never learn a placeholder as an answer
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
