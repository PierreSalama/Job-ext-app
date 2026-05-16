// JAT v10 — form heuristics signal.
// Detects "this page has an apply form" without site-specific selectors, by
// looking for: a file input, name/email/phone fields, and a submit button
// whose text/label sounds like "submit application / send application".
//
// Also exposes utilities for snapshotting form answers and scanning file
// inputs for attached resumes/cover letters — used during stage 2 of the
// pipeline (in-progress capture).

const FILE_LABEL_RX = /(resume|cv|curriculum|résumé)/i;
const COVER_LABEL_RX = /(cover|letter)/i;
const APPLY_FORM_FIELD_HINTS = [
  /first\s*name/i, /last\s*name/i, /full\s*name/i,
  /email/i, /phone|mobile/i, /linkedin/i,
  /address|city|location/i,
  /work auth|authorization|sponsorship|visa/i,
  /experience|years/i,
  /resume|cv|cover/i,
];

const SUBMIT_TEXT_RX = /submit\s+application|send\s+application|apply\s+now/i;

// Survey every form on the page. Returns the form most likely to be an apply
// form, along with a confidence score 0..1.
export function detectApplyForm() {
  const forms = Array.from(document.querySelectorAll('form'));
  // Some sites (LinkedIn Easy Apply) inject the apply modal without a <form>
  // wrapper. Treat the apply dialog itself as a pseudo-form.
  const modal = document.querySelector('div[role="dialog"], div[class*="modal"]:not([hidden])');
  if (modal && containsApplySignals(modal)) {
    return { form: modal, confidence: scoreContainer(modal) };
  }
  let best = null;
  for (const f of forms) {
    const s = scoreContainer(f);
    if (!best || s > best.confidence) best = { form: f, confidence: s };
  }
  return best && best.confidence >= 0.5 ? best : null;
}

function containsApplySignals(root) {
  if (root.querySelector('input[type="file"]')) return true;
  const text = (root.textContent || '').toLowerCase();
  return /apply|application|resume|cover\s*letter|submit/.test(text);
}

function scoreContainer(root) {
  let score = 0;
  // File input → very strong signal
  if (root.querySelector('input[type="file"]')) score += 0.45;
  // Field hints
  const labels = Array.from(root.querySelectorAll('label, [aria-label], input[placeholder]'))
    .map((el) => (el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim())
    .filter(Boolean);
  const labelHits = APPLY_FORM_FIELD_HINTS.filter((rx) => labels.some((l) => rx.test(l))).length;
  score += Math.min(labelHits, 4) * 0.10;
  // Submit button text
  const buttons = root.querySelectorAll('button, input[type="submit"], [role="button"]');
  for (const b of buttons) {
    const t = (b.textContent || b.value || b.getAttribute('aria-label') || '').trim();
    if (SUBMIT_TEXT_RX.test(t)) { score += 0.25; break; }
  }
  return Math.min(score, 1);
}

// Pull attached files from an apply form / dialog.
//   Returns: [{ name, sizeBytes, type, role }] — never the binary itself.
//   role is 'resume' | 'coverLetter' | 'attachment'
export function detectAttachments(root = document) {
  const out = [];
  for (const input of root.querySelectorAll('input[type="file"]')) {
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

// Pull text answers from the apply form. Returns an object keyed by
// normalized question text → entered value. Strips empties, hidden fields,
// passwords, and CAPTCHAs.
export function snapshotAnswers(root = document) {
  const out = {};
  const inputs = root.querySelectorAll('input, textarea, select');
  for (const el of inputs) {
    if (!el.name && !el.id) continue;
    const type = (el.type || '').toLowerCase();
    if (['hidden', 'password', 'submit', 'button', 'file'].includes(type)) continue;
    if (/captcha|recaptcha|hcaptcha/i.test((el.name || '') + (el.id || ''))) continue;
    const v = el.value;
    if (v === '' || v == null) continue;
    const key = normalizeLabel(labelFor(el)) || el.name || el.id;
    if (!key) continue;
    out[key] = String(v).slice(0, 500);
  }
  return out;
}

function labelFor(el) {
  if (el.labels && el.labels[0]) return (el.labels[0].textContent || '').trim();
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const ph = el.getAttribute('placeholder');
  if (ph) return ph.trim();
  const id = el.id;
  if (id) {
    const lbl = document.querySelector(`label[for="${cssEscape(id)}"]`);
    if (lbl) return (lbl.textContent || '').trim();
  }
  return '';
}

function normalizeLabel(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+|^_|_$/g, '_').replace(/^_+|_+$/g, '');
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/([!"#$%&'()*+,\-./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

// ----- Generic company-link recovery -----
// Walks <a> tags for href patterns the major job boards + ATSes share for
// linking to a company profile / careers page. Returns the trimmed link text
// of the first match, or empty string.
const COMPANY_HREF_RX = /\/(company|companies|employer|organisation|organization|orgs?|emp)\/[\w\-_]+/i;
export function findCompanyLink(root = document) {
  const links = root.querySelectorAll('a[href]');
  for (const a of links) {
    const href = a.getAttribute('href') || '';
    if (!COMPANY_HREF_RX.test(href)) continue;
    const text = (a.textContent || '').trim();
    if (!text) continue;
    // Skip obviously-non-company text like "View company" or "About this company"
    if (/^(view|about|see|more|explore)\b/i.test(text)) continue;
    if (text.length > 120) continue;
    return text;
  }
  return '';
}

// ----- Generic resume filename recovery -----
// When no <input type="file"> has .files (the LinkedIn case — resumes are
// selected from a list of previously uploaded ones), look for a visible
// filename token within the page. We require the file extension to be a
// resume-y format. We don't try to verify "this is THE resume" — it's
// metadata only, and the user can edit it in the dashboard.
const FILENAME_RX = /\b([\w()&,'\-.+ ]{3,120}?\.(pdf|docx?|rtf|odt|txt|pages))\b/i;
export function findResumeFilename(root) {
  // Build candidate scopes in order of specificity. We try each until we hit
  // a hit. Going from narrow (current form) → wider (parent dialog, body)
  // catches LinkedIn's case where the resume card is a sibling of the form.
  const scopes = [];
  if (root && root !== document) {
    scopes.push(root);
    // Walk up looking for a containing dialog/modal/section
    let p = root.parentElement;
    let hops = 0;
    while (p && hops < 8) {
      if (p.matches?.('[role="dialog"], [aria-modal="true"], section, main, [class*="modal"], [class*="apply"]')) {
        scopes.push(p);
      }
      p = p.parentElement; hops++;
    }
  }
  // Also consider any visible dialog on the page (LinkedIn's Easy Apply modal)
  for (const d of document.querySelectorAll('[role="dialog"], [aria-modal="true"]')) {
    if (!scopes.includes(d)) scopes.push(d);
  }
  // Last resort: body
  scopes.push(document.body || document.documentElement);

  for (const s of scopes) {
    if (!s) continue;
    const text = (s.textContent || '').slice(0, 20000);
    const m = text.match(FILENAME_RX);
    if (m) return m[1].trim();
  }
  return '';
}

// ----- Generic title/company extraction from apply-form headers -----
// On standalone apply pages (smartapply.indeed.com, greenhouse.io/apply,
// etc.) the job listing is gone but the form header usually says something
// like "Apply for X at Y" or shows the role + company in an h1/h2.
const APPLY_HEADER_RX = /apply(?:ing)?\s+(?:for|to)\s+(.+?)(?:\s+at\s+(.+?))?(?:\s+on\s+\w+)?$/i;
export function inferFromApplyHeader() {
  // Walk h1/h2 first; they're usually right.
  const headings = document.querySelectorAll('h1, h2, [role="heading"]');
  for (const h of headings) {
    const t = (h.textContent || '').trim();
    if (!t || t.length > 200) continue;
    const m = t.match(APPLY_HEADER_RX);
    if (m) return { title: m[1]?.trim() || '', company: m[2]?.trim() || '' };
    // Sometimes headings are just "Software Engineer · Acme Inc"
    const parts = t.split(/\s+[·•|—-]\s+/);
    if (parts.length >= 2 && parts[0].length < 80 && parts[1].length < 80) {
      return { title: parts[0].trim(), company: parts[1].trim() };
    }
  }
  return null;
}
