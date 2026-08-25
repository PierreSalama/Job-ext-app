// JAT v11 — form heuristics signal.
// v10 base with two structural upgrades:
//  1. Shadow-DOM-piercing scans (Workday) via content/lib/dom.js.
//  2. Hard discrimination against account-creation / login / newsletter /
//    contact forms — the v10 scorer kept treating "create an account" pages on
//    unrelated sites as apply forms (Pierre's top complaint). Those now score 0
//    unless a real file input is present.

import { qsa, compactText, isProbablyVisible } from '../lib/dom.js';

const FILE_LABEL_RX = /(resume|cv|curriculum|résumé)/i;
const COVER_LABEL_RX = /(cover|letter|lettre)/i;
// GENERIC fields appear on EVERY form — checkout, signup, contact, newsletter.
// On their own they must NOT make a page an "apply form" (that was the source of
// the panel popping on credit-card / sign-up pages).
const GENERIC_FIELD_HINTS = [
  /first\s*name|pr[ée]nom/i, /last\s*name|nom\s*de\s*famille/i, /full\s*name/i,
  /email|courriel/i, /phone|mobile|t[ée]l[ée]phone/i, /linkedin|portfolio|website/i,
  /address|city|location|ville|adresse/i,
];
// JOB-SPECIFIC fields — a checkout/signup form essentially never has these.
const JOB_FIELD_HINTS = [
  /work auth|authorization|sponsorship|visa/i,
  /years?\s+of\s+experience|ann[ée]es\s+d'exp[ée]rience/i,
  // word-bounded: bare "cv" must NOT match "CVV" (card verification value on checkouts)
  /\bresume\b|\br[ée]sum[ée]\b|\bcv\b|\bcurriculum\b|cover\s*letter|lettre\s*de\s*motivation/i,
];
const APPLY_FORM_FIELD_HINTS = [...GENERIC_FIELD_HINTS, ...JOB_FIELD_HINTS];
// Unambiguous "this is a JOB application" phrasing. Note: NOT the bare word "apply"
// — that shows up as "apply promo code" / "apply filters" / "apply coupon" on shops.
const JOB_SURFACE_RX = /\b(resume|cv|curriculum\s*vitae|cover\s*letter|lettre\s*de\s*motivation|work\s*authorization|require\s*sponsorship|visa\s*sponsorship|years?\s+of\s+experience|submit\s+your\s+application|review\s+your\s+application|your\s+application|application\s+form|apply\s+for\s+this\s+(?:job|position|role)|job\s+application)\b/i;
const APPLY_SURFACE_RX = /apply|application|candidate|candidature|resume|cv|cover\s*letter|upload|attach|drag\s*(?:and|&)\s*drop|work\s*authorization|visa|sponsorship/i;
const ACTION_TEXT_RX = /submit(?:\s+your)?\s+application|send(?:\s+your)?\s+application|apply\s+now|postuler|next|continue|suivant|continuer|review|save\s*(?:&|and)\s*continue|finish\s+application|complete\s+application/i;
const DIALOG_SELECTOR = '[role="dialog"], [aria-modal="true"], [data-test-modal], [data-testid*="apply"], [class*="modal"], [class*="dialog"], [class*="apply"], [class*="application"]';
const ATTR_NAMES = ['title', 'aria-label', 'alt', 'data-filename', 'data-name', 'data-resume', 'data-file', 'data-value', 'data-label', 'data-original-title', 'aria-describedby'];

// ---- account/login/newsletter discrimination (NEW in v11) ----
const ACCOUNT_TEXT_RX = /\b(create\s+(an\s+)?account|create\s+your\s+account|sign\s+up|register|join\s+(now|free)|log\s*in|sign\s*in|welcome\s+back|forgot\s+(your\s+)?password|s'inscrire|se\s+connecter|cr[ée]er\s+un\s+compte|mot\s+de\s+passe\s+oubli[ée])\b/i;
const NEWSLETTER_RX = /\b(subscribe|newsletter|stay\s+(up\s+to\s+date|informed)|get\s+updates|abonnez|infolettre)\b/i;
const CONTACT_RX = /\b(contact\s+us|get\s+in\s+touch|send\s+us\s+a\s+message|your\s+message|nous\s+contacter)\b/i;

// Unmistakable ATS apply-FLOW container markers (Workday applyFlowPage/legalNameSection/
// bottom-navigation, quick-apply review, smartapply, explicit application-form classes).
// A multi-step ATS page (e.g. Workday "My Information") can have only generic fields on a
// given step — the marker IS its job signal. Deliberately excludes loose hooks like
// id*="application" (React app roots) that a checkout/marketing SPA would also match.
const ATS_APPLY_MARKER_SEL = [
  '[data-automation-id="applyFlowPage"]', '[data-automation-id*="applyFlow"]',
  '[data-automation-id*="legalNameSection"]', '[data-automation-id*="bottom-navigation"]',
  '[data-automation-id="jobApplication"]', '[data-automation-id*="quickApply"]',
  '[data-testid*="smartapply"]', '[data-test="application-form"]',
  '[class*="application-form"]', '[class*="apply-form"]', '[class*="ats-application"]',
].join(', ');
function hasAtsApplyMarker(root) {
  return !!(root && (root.matches?.(ATS_APPLY_MARKER_SEL) || root.querySelector?.(ATS_APPLY_MARKER_SEL)));
}

function looksLikeAccountForm(root) {
  const pw = qsa('input[type="password"]', root);
  if (!pw.length) return false;
  if (qsa('input[type="file"]', root).length) return false;   // real apply forms can ask you to register — file input wins
  if (pw.length >= 2) return true;                             // password + confirm = signup
  const text = collectText(root, 1500) + ' ' + headingText(root);
  return ACCOUNT_TEXT_RX.test(text);
}

function headingText(root) {
  return collectText(root.querySelector?.('h1, h2, h3, legend, [role="heading"]'), 300);
}

// Containers that wrap an application without being a <form> — Workday,
// SuccessFactors, Oracle, iCIMS, etc. render fields in custom component divs.
const APP_CONTAINER_SELECTOR = [
  'form',
  '[data-automation-id="applyFlowPage"]', '[data-automation-id*="application"]',
  '[data-automation-id="jobApplication"]', '[data-automation-id="pageContent"]',
  '[data-test*="application"]', '[data-testid*="application"]', '[data-testid*="apply"]',
  '[id*="application"]', '[id*="apply"]', '[class*="application-form"]',
  '[class*="apply-form"]', '[aria-label*="application" i]',
].join(', ');

// Survey candidate containers; return the most apply-form-looking one or null.
export function detectApplyForm() {
  const candidates = new Set(qsa('form'));
  for (const root of qsa(DIALOG_SELECTOR)) {
    if (containsApplySignals(root)) candidates.add(root);
  }
  // ATS containers (Workday data-automation-id, iCIMS ids, …) — no <form> tag.
  for (const root of qsa(APP_CONTAINER_SELECTOR)) {
    if (containsApplySignals(root) && countInteractiveFields(root) >= 2) candidates.add(root);
  }
  if (!candidates.size) {
    let scanned = 0;
    for (const root of qsa('section, article, main')) {
      if (scanned++ > 60) break;
      if (containsApplySignals(root) && countInteractiveFields(root) >= 3) candidates.add(root);
    }
  }
  // Last resort: the page body itself (Workday-style SPAs put fields in bare
  // divs anywhere). The discriminating scorer below still rejects login/signup/
  // contact/newsletter, so this stays safe.
  if (!candidates.size && document.body
      && containsApplySignals(document.body) && countInteractiveFields(document.body) >= 3) {
    candidates.add(document.body);
  }

  let best = null;
  for (const root of candidates) {
    const score = scoreContainer(root);
    if (!best || score > best.confidence) best = { form: root, confidence: score };
  }
  return best && best.confidence >= 0.45 ? best : null;
}

function containsApplySignals(root) {
  if (!root || !isProbablyVisible(root)) return false;
  if (looksLikeAccountForm(root)) return false;
  // A bare <input type=file> is NOT, on its own, an apply signal — media/streaming SPAs (Plex
  // poster/subtitle/avatar uploaders) carry hidden file inputs and would otherwise make the page
  // body a false "apply form" candidate. Fall through to the real signals: a genuine resume-upload
  // surface, apply-surface text (resume/cv/cover letter/work-auth — always present on real ATS
  // forms next to the file input), or an apply/next/submit action button.
  if (hasUploadSurface(root)) return true;
  const text = collectText(root, 4000).toLowerCase();
  if (APPLY_SURFACE_RX.test(text)) return true;
  for (const b of qsa('button, input[type="submit"], [role="button"]', root)) {
    if (ACTION_TEXT_RX.test(buttonText(b))) return true;
  }
  return false;
}

function scoreContainer(root) {
  if (!root || !isProbablyVisible(root)) return 0;
  // Hard negatives first — this is the fix for "signup form on a random site".
  if (looksLikeAccountForm(root)) return 0;
  const fullText = collectText(root, 2500);
  const isNewsletter = NEWSLETTER_RX.test(fullText) && countInteractiveFields(root) <= 2;
  // Check the whole form body, not just a heading — many contact forms have no
  // heading ("Send us a message" sits inline above the textarea).
  const isContact = CONTACT_RX.test(headingText(root)) || CONTACT_RX.test(fullText);
  if (isNewsletter) return 0;

  let score = 0;
  const hasRealFileInput = qsa('input[type="file"]', root).length > 0;
  const hasUploadWidget = hasUploadSurface(root);
  const fieldLabels = collectFieldLabels(root);
  const jobLabelHits = fieldLabels.filter((label) => JOB_FIELD_HINTS.some((rx) => rx.test(label))).length;
  const labelHits = fieldLabels
    .filter((label) => APPLY_FORM_FIELD_HINTS.some((rx) => rx.test(label)))
    .length;

  // HARD GATE: a form is an "apply form" only if it carries a genuinely job-specific
  // signal — a resume/CV/cover-letter upload, a work-auth / experience field, or real
  // application phrasing. Generic name/email/phone/address + an "Apply"/"Continue" button
  // (every checkout & sign-up form) is NOT enough. This is the fix for the panel appearing
  // while filling out a credit card or signing up to a site.
  const hasJobSpecificSignal =
    hasUploadWidget
    || jobLabelHits >= 1
    || JOB_SURFACE_RX.test(fullText)
    || JOB_SURFACE_RX.test(headingText(root))
    || hasAtsApplyMarker(root)
    || (hasRealFileInput && (JOB_SURFACE_RX.test(fullText) || jobLabelHits >= 1));
  if (!hasJobSpecificSignal) return 0;
  const interactiveFields = countInteractiveFields(root);
  const actionButtons = countActionButtons(root);
  const heading = headingText(root);
  const hasRequiredFields = !!root.querySelector?.('[required], [aria-required="true"]');
  const hasPasswordField = qsa('input[type="password"]', root).length > 0;
  const hasSearchField = !!root.querySelector?.('input[type="search"], [role="search"]');

  // A "submit/finish application" or apply control inside the container.
  const hasSubmitButton = qsa('button, input[type="submit"], [role="button"]', root)
    .some((b) => {
      const vt = compactText(b.textContent || b.value || b.getAttribute?.('aria-label') || '');
      return /^(submit|submit application|send application|finish|finish application|apply|apply now|review)$/i.test(vt)
        || /submit/i.test((b.getAttribute?.('data-automation-id') || '') + (b.id || ''));
    });

  // The file-input bonus only counts with corroborating apply context (resume/cv/upload/work-auth
  // text, or a real apply-form field label). A lone file input with no apply text — e.g. a Plex
  // avatar/poster uploader — scores 0 here and cannot clear the 0.45 gate on its own.
  if (hasRealFileInput && (APPLY_SURFACE_RX.test(fullText) || labelHits >= 1)) score += 0.34;
  if (hasUploadWidget) score += 0.18;
  score += Math.min(labelHits, 5) * 0.08;
  score += Math.min(interactiveFields, 6) * 0.03;
  score += Math.min(actionButtons, 2) * 0.12;
  if (hasSubmitButton) score += 0.14;
  if (heading && APPLY_SURFACE_RX.test(heading)) score += 0.10;
  // Strong application phrasing anywhere in the body (review/submit pages).
  if (/\b(your application|submit your application|review your application|application form|complete your application)\b/i.test(fullText)) score += 0.10;
  if (hasRequiredFields) score += 0.05;

  if (hasPasswordField && !hasUploadWidget && labelHits < 2) score -= 0.35;
  if (hasSearchField && interactiveFields < 3 && labelHits < 2) score -= 0.15;
  if (interactiveFields < 2 && !hasRealFileInput && !hasUploadWidget) score -= 0.10;
  if (isContact && !hasRealFileInput && !hasUploadWidget) score -= 0.30;

  return Math.max(0, Math.min(score, 1));
}

// Attached files in the apply form/dialog → [{name,sizeBytes,type,role}]
export function detectAttachments(root = document) {
  const out = [];
  for (const input of qsa('input[type="file"]', root)) {
    if (!input.files || !input.files.length) continue;
    const label = labelFor(input);
    for (const file of input.files) {
      const isResume = FILE_LABEL_RX.test(label) || FILE_LABEL_RX.test(file.name);
      const isCover = COVER_LABEL_RX.test(label) || COVER_LABEL_RX.test(file.name);
      out.push({
        name: file.name,
        sizeBytes: file.size,
        type: file.type || '',
        role: isResume ? 'resume' : (isCover ? 'coverLetter' : 'attachment'),
      });
    }
  }
  return out;
}

// Text answers keyed by normalized question label. Skips secrets/captchas.
export function snapshotAnswers(root = document) {
  const out = {};
  for (const el of qsa('input, textarea, select, [contenteditable="true"]', root)) {
    const type = (el.type || '').toLowerCase();
    if (!el.matches?.('[contenteditable="true"]') && !el.name && !el.id && !labelFor(el)) continue;
    if (['hidden', 'password', 'submit', 'button', 'file'].includes(type)) continue;
    if (/captcha|recaptcha|hcaptcha|cvv|card.?number/i.test((el.name || '') + (el.id || '') + labelFor(el))) continue;
    // Never capture EEO / demographic / protected-class answers into memory (the
    // server has a backstop too, but don't even send them).
    if (/(ethnic|race\b|gender|\bsex\b|disabilit|veteran|criminal|background.?check|felony|conviction|pronoun|sexual.?orientation|\blgbtq?|\bssn\b|social.?security|date.?of.?birth|\bdob\b)/i.test((el.name || '') + ' ' + (el.id || '') + ' ' + labelFor(el))) continue;

    let value = '';
    if (el.matches?.('[contenteditable="true"]')) {
      value = (el.textContent || '').trim();
    } else if (type === 'checkbox') {
      if (!el.checked) continue;
      value = el.value && el.value !== 'on' ? el.value : 'true';
    } else if (type === 'radio') {
      if (!el.checked) continue;
      value = el.value || labelFor(el) || 'true';
    } else if (el.tagName === 'SELECT') {
      const selected = Array.from(el.selectedOptions || [])
        .map((opt) => (opt.textContent || '').trim())
        .filter(Boolean);
      value = selected.join(', ');
    } else {
      value = el.value;
    }

    if (value === '' || value == null) continue;
    const key = normalizeLabel(labelFor(el)) || normalizeLabel(el.name) || normalizeLabel(el.id);
    appendAnswer(out, key, String(value).slice(0, 500));
  }
  return out;
}

export function labelFor(el) {
  if (!el) return '';
  if (el.labels && el.labels[0]) return compactText(el.labels[0].textContent || '');

  const labelledBy = readIdRefsText(el.getAttribute?.('aria-labelledby'), el);
  if (labelledBy) return labelledBy;

  const aria = el.getAttribute?.('aria-label');
  if (aria) return compactText(aria);

  const ph = el.getAttribute?.('placeholder');
  if (ph) return compactText(ph);

  const id = el.id;
  if (id) {
    const root = el.getRootNode?.() || document;
    const lbl = root.querySelector?.(`label[for="${cssEscape(id)}"]`);
    if (lbl) return compactText(lbl.textContent || '');
  }

  const describedBy = readIdRefsText(el.getAttribute?.('aria-describedby'), el);
  if (describedBy && describedBy.length <= 120) return describedBy;

  return humanizeToken(el.name || el.id || '');
}

function normalizeLabel(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/([!"#$%&'()*+,\-./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

function collectText(root, maxLen = 800) {
  if (!root) return '';
  return compactText(root.textContent || '').slice(0, maxLen);
}

function buttonText(el) {
  return compactText([
    el?.textContent || '',
    el?.getAttribute?.('aria-label') || '',
    el?.getAttribute?.('title') || '',
    el?.value || '',
    el?.className || '',
  ].join(' '));
}

function countInteractiveFields(root) {
  let count = 0;
  for (const el of qsa('input, textarea, select, [role="combobox"], [contenteditable="true"]', root)) {
    const type = (el.type || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'password', 'file'].includes(type)) continue;
    if (!isProbablyVisible(el)) continue;
    count++;
  }
  return count;
}

function countActionButtons(root) {
  let count = 0;
  for (const el of qsa('button, input[type="submit"], [role="button"]', root)) {
    if (ACTION_TEXT_RX.test(buttonText(el))) count++;
  }
  return count;
}

function collectFieldLabels(root) {
  const labels = new Set();
  for (const el of qsa('label, legend, input, textarea, select, [role="combobox"], [aria-label], [placeholder]', root)) {
    const value = el.matches?.('input, textarea, select, [role="combobox"]')
      ? labelFor(el)
      : compactText(el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('placeholder') || '');
    if (value) labels.add(value);
  }
  return Array.from(labels);
}

function hasUploadSurface(root) {
  if (!root) return false;
  if (root.querySelector?.('[data-testid*="resume"], [data-test*="resume"], [class*="resume"], [id*="resume"], [aria-label*="resume" i], [data-automation-id*="file-upload"]')) return true;
  const text = collectText(root, 5000);
  // Require résumé-specific context — a bare "upload"/"attach" is a signup avatar or a
  // receipt uploader, not a job application. Drag-drop résumé zones say "resume/CV".
  return /\b(resume|r[ée]sum[ée]|cv|curriculum|cover\s*letter|lettre\s*de\s*motivation)\b/i.test(text)
    && /\b(upload|attach|drag\s*(?:and|&)\s*drop|t[ée]l[ée]verser|joindre|resume|cv|curriculum)\b/i.test(text);
}

function readIdRefsText(ids, el) {
  if (!ids) return '';
  const root = el?.getRootNode?.() || document;
  const text = String(ids)
    .split(/\s+/)
    .map((id) => compactText(root.getElementById?.(id)?.textContent || ''))
    .filter(Boolean)
    .join(' ');
  return compactText(text);
}

function humanizeToken(token) {
  return compactText(String(token || '').replace(/[_:.-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'));
}

function appendAnswer(out, key, value) {
  if (!key || !value) return;
  if (!Object.prototype.hasOwnProperty.call(out, key)) {
    out[key] = value;
    return;
  }
  const current = String(out[key]).split(/;\s*/).filter(Boolean);
  if (!current.includes(value)) out[key] = [...current, value].join('; ');
}

// ----- Generic company-link recovery -----
const COMPANY_HREF_RX = /\/(company|companies|cmp|employer|organisation|organization|orgs?|emp)\/[\w\-_]+/i;
export function findCompanyLink(root = document) {
  for (const a of qsa('a[href]', root)) {
    const href = a.getAttribute('href') || '';
    if (!COMPANY_HREF_RX.test(href)) continue;
    const text = compactText(a.textContent || '');
    if (!text) continue;
    if (/^(view|about|see|more|explore|follow)\b/i.test(text)) continue;
    if (text.length > 120) continue;
    if (isImplausibleCompany(text)) continue;   // a "company" link whose text is page chrome
    return text;
  }
  return '';
}

// ----- Generic resume filename recovery -----
// A real filename never contains long whitespace runs — keep the class tight so
// a match can't splice unrelated page text (the cause of the garbled "Stage
// Detected…Resume.pdf" value) into a bogus filename.
const FILENAME_RX = /\b([\w()&,'\-.+]{2,100}(?:\s[\w()&,'\-.+]{1,40}){0,3}\.(pdf|docx?|rtf|odt|txt|pages))\b/i;

// Skip JAT's own injected UI so scans never read the panel/overlay text.
function isJatUi(el) { return !!el?.closest?.('#jat11-panel, #jat11-aa'); }

// The uploaded-file display (Workday "Successfully Uploaded!", Greenhouse file
// chips, etc.) shows the filename in its own small element. Find a leaf-ish
// element whose text is a clean filename ending in a document extension —
// robust to long multi-word names that the in-text regex would miss.
const DOC_EXT_RX = /\.(pdf|docx?|rtf|odt|txt|pages|rtf)\b/i;
const FILENAME_LOOSE_RX = /([\w()&,'’\[\]@#+\-.\s]{2,160}?\.(pdf|docx?|rtf|odt|txt|pages))\b/i;
const NOT_A_FILENAME_RX = /\b(please|click|upload|drag|drop|review|attach|tips|once|use|ensure|include|consistent|keep|format|formatting|following|either|below|profile|instructions|maximum|accepted|allowed|supported|file types?|max|mb)\b/i;
function findUploadedFilename(root) {
  if (!root) return '';
  let scanned = 0;
  for (const el of qsa('*', root)) {
    if (scanned++ > 6000) break;
    if (isJatUi(el)) continue;
    if (el.children && el.children.length > 4) continue;   // leaf-ish elements only
    const t = compactText(el.textContent || '');
    if (!t || t.length > 200 || !DOC_EXT_RX.test(t)) continue;
    const m = t.match(FILENAME_LOOSE_RX);
    if (!m) continue;
    const name = m[1].trim();
    const stem = name.replace(DOC_EXT_RX, '');
    if (stem.length < 2 || NOT_A_FILENAME_RX.test(stem)) continue;   // reject instruction text
    return name;
  }
  return '';
}

export function findResumeFilename(root) {
  // The actually-uploaded file is the strongest signal — check it first across
  // the form (or the page) before falling back to cue-scanning.
  const uploadScope = (root && root !== document) ? root : (document.body || document.documentElement);
  const uploaded = findUploadedFilename(uploadScope);
  if (uploaded) return uploaded;

  const scopes = [];
  if (root && root !== document) {
    scopes.push(root);
    let p = root.parentElement;
    let hops = 0;
    while (p && hops < 8) {
      if (p.matches?.('[role="dialog"], [aria-modal="true"], section, main, [class*="modal"], [class*="apply"], [class*="application"]')) {
        scopes.push(p);
      }
      p = p.parentElement;
      hops++;
    }
  }
  for (const d of qsa('[role="dialog"], [aria-modal="true"]')) {
    if (!scopes.includes(d) && !isJatUi(d)) scopes.push(d);
  }

  for (const scope of scopes) {
    if (!scope || isJatUi(scope)) continue;
    const nearCue = findFilenameNearUploadCue(scope);
    if (nearCue) return nearCue;
    // Focused-scope text match only — NEVER the whole page body (that spliced in
    // JAT's own panel text and produced garbage). The element-walk above already
    // covers the upload-cue case in any scope.
    const text = collectText(scope, 8000);
    const textMatch = text.match(FILENAME_RX);
    if (textMatch) return textMatch[1].trim();
    const attrMatch = scanAttributesForFilename(scope);
    if (attrMatch) return attrMatch;
  }
  return '';
}

function findFilenameNearUploadCue(root) {
  let scanned = 0;
  for (const el of qsa('*', root)) {
    if (scanned++ > 2500) break;
    if (isJatUi(el)) continue;
    const signal = elementSignalText(el);
    if (!signal) continue;
    if (!/(resume|cv|cover\s*letter|upload|attach)/i.test(signal)) continue;
    const localMatch = signal.match(FILENAME_RX);
    if (localMatch) return localMatch[1].trim();
    const attrMatch = matchFilenameInAttrs(el);
    if (attrMatch) return attrMatch;
    const parentText = collectText(el.parentElement, 600);
    const parentMatch = parentText.match(FILENAME_RX);
    if (parentMatch) return parentMatch[1].trim();
  }
  return '';
}

function elementSignalText(el) {
  return compactText([
    el?.textContent || '',
    ...ATTR_NAMES.map((attr) => el?.getAttribute?.(attr) || ''),
    el?.className || '',
    el?.id || '',
  ].join(' ')).slice(0, 800);
}

function scanAttributesForFilename(root) {
  if (isJatUi(root)) return '';
  const selfMatch = matchFilenameInAttrs(root);
  if (selfMatch) return selfMatch;
  let scanned = 0;
  for (const el of qsa('*', root)) {
    if (scanned++ > 5000) break;
    if (isJatUi(el)) continue;
    const match = matchFilenameInAttrs(el);
    if (match) return match;
  }
  return '';
}

function matchFilenameInAttrs(el) {
  if (!el?.getAttribute) return '';
  for (const attr of ATTR_NAMES) {
    const value = el.getAttribute(attr);
    if (!value) continue;
    const match = value.match(FILENAME_RX);
    if (match) return match[1].trim();
  }
  return '';
}

// ----- Title/company from apply-form headers -----
// ── AN EMPLOYER IS A NAME, NOT PROSE ─────────────────────────────────────────────────────────
// The other half of the v11.125.0 cross-contamination fix (defect 3b). That release stopped a
// post-submit confirmation heading from being accepted as a TITLE, and stopped the ATS routing
// label from being accepted as an EMPLOYER — but only the exact routing labels. Nothing stopped
// an arbitrary heading lifted off the job description from landing in `company`, and inferring a
// company from a heading is exactly what detector.js does when the page carries no employer of
// its own (job-boards.greenhouse.io never does). Live 2026-08-24, on the first two Affirm runs
// after that release:
//     task_58b8b766   company: "affirm" → "What You'll Do"
//     task_3f9cf09d   company: "affirm" → "What you’ll do"
// and a third, task_b7c16686, took "Growth)" — the tail of its own title
// "Senior Software Engineer, Backend (PBA - Growth)" split on the " - " separator.
//
// Four classes are refused, each one measured on a real corrupted row:
//   1. ROUTING LABEL — "job-boards", "boards", "apply", "smartapply", "embed", an ATS brand.
//   2. UNBALANCED FRAGMENT — "Growth)". A name never carries one half of a bracket pair; that
//      is the signature of a string that was cut out of a longer one.
//   3. JD SECTION HEADING — "What You'll Do", "About Tailscale", "Back to jobs",
//      "Team Member Resource Groups". Enumerable, and no employer is called any of them.
//   4. SENTENCE — "We champion every identity." Marketing copy: a sentence opener plus three or
//      more words, or an internal ". " sentence break ("Learn. Develop. Succeed").
//
// The failure mode of a false positive is deliberately harmless: upsertJob falls back to
// `prev.company`, so a rejected value means the row KEEPS THE EMPLOYER IT ALREADY HAD, and a
// brand-new row is simply created without one. A blank company is honest; a wrong one is not.
// This is the EXTENSION copy: it stops the value at the source, before the capture is even sent.
// db.js carries the identical rules at the storage boundary — that copy is the authoritative one
// (it also covers extension builds already deployed). tests/company-guard.test.mjs asserts the two
// definitions stay byte-identical, so neither side can drift.
const COMPANY_ROUTING_RX = /^(?:job-?boards?|boards?|jobs?|apply|applications?|smart-?apply|embed|careers?|recruiting|recruitment|hiring|talent|greenhouse|lever|ashby|ashbyhq|workday|myworkdayjobs|workable|bamboohr|smartrecruiters|zip-?recruiter|icims|taleo|linkedin|indeed|glassdoor|www|app|apps|secure|my)$/i;
const JD_SECTION_HEADING_RX = /^(?:what\s+(?:you|we|to)\b|who\s+(?:you|we)\b|about\b|the\s+role\b|your\s+(?:role|impact|team|day)\b|responsibilities\b|requirements\b|qualifications\b|benefits\b|perks\b|why\s+(?:join|us|work)\b|how\s+(?:we|you)\b|our\s+(?:team|stack|values|mission|culture|process)\b|back\s+to\s+jobs?\b|job\s+description\b|role\s+overview\b|nice\s+to\s+have\b|must\s+have\b|equal\s+(?:opportunity|employment)\b|thank\s+you\b|apply\s+(?:now|for)\b)|\bresource\s+groups?$/i;
const SENTENCE_OPENER_RX = /^(?:we|our|us|i|you|your|it|its|they|their|this|that|these|those|here|there|come|join|build|help|let|meet|discover|learn|imagine|ready)\b/i;
const INTERNAL_SENTENCE_BREAK_RX = /\w\.\s+[A-Z]/;
export function isImplausibleCompany(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return false;                                    // empty is not "implausible", just absent
  if (COMPANY_ROUTING_RX.test(s)) return true;             // (1)
  const open = (s.match(/[([]/g) || []).length;
  const close = (s.match(/[)\]]/g) || []).length;
  if (open !== close) return true;                         // (2)
  if (JD_SECTION_HEADING_RX.test(s)) return true;          // (3)
  const words = s.split(/\s+/).filter(Boolean);
  if (SENTENCE_OPENER_RX.test(s) && words.length >= 3) return true;   // (4a)
  if (INTERNAL_SENTENCE_BREAK_RX.test(s)) return true;               // (4b)
  return false;
}

const APPLY_HEADER_RX = /apply(?:ing)?\s+(?:for|to)\s+(.+?)(?:\s+at\s+(.+?))?(?:\s+on\s+\w+)?$/i;
const GENERIC_HEADING_RX = /^(apply|application|job application|candidate details|resume|cv|review|submit|postuler|candidature)$/i;
// Every employer this function can produce is guessed from page text, so every one of them goes
// through the guard: a heading fragment ("Growth)"), a JD section title ("What You'll Do") and a
// marketing line ("We champion every identity.") were all written into `company` from here.
const keepCompany = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s && !isImplausibleCompany(s) ? s : '';
};
export function inferFromApplyHeader() {
  for (const h of qsa('h1, h2, [role="heading"]')) {
    const text = collectText(h, 200);
    if (!text || text.length > 200) continue;
    const match = text.match(APPLY_HEADER_RX);
    if (match) return { title: match[1]?.trim() || '', company: keepCompany(match[2]) };

    const parts = text.split(/\s+[·•|—-]\s+/);
    if (parts.length >= 2 && parts[0].length < 80 && parts[1].length < 80) {
      return { title: parts[0].trim(), company: keepCompany(parts[1]) };
    }

    if (!GENERIC_HEADING_RX.test(text) && text.length < 120) {
      const company = keepCompany(findNearbyCompanyText(h));
      if (company) return { title: text, company };
    }
  }
  return null;
}

function findNearbyCompanyText(anchor) {
  const localRoot = anchor.closest?.('header, section, article, form, [role="dialog"], main') || anchor.parentElement;
  if (!localRoot) return '';

  const linkCompany = findCompanyLink(localRoot);
  if (linkCompany) return linkCompany;

  const titleText = collectText(anchor, 120);
  const seen = new Set();
  for (const el of qsa('h2, h3, p, span, div, a, strong', localRoot)) {
    if (el === anchor) continue;
    const text = collectText(el, 120);
    if (!text || text === titleText || seen.has(text)) continue;
    seen.add(text);
    for (const piece of text.split(/\s+[·•|]\s+/)) {
      const candidate = compactText(piece);
      if (looksLikeCompanyText(candidate)) return candidate;
    }
  }
  return '';
}

function looksLikeCompanyText(text) {
  if (!text || text.length > 80) return false;
  if (FILENAME_RX.test(text)) return false;
  if (/apply|application|resume|cv|upload|drag|review|submit|location|remote|hybrid|on-site|full-time|part-time|contract|temporary|internship|postuler|candidature/i.test(text)) return false;
  if (/^\$/.test(text) || /\d{4,}/.test(text)) return false;
  return true;
}
