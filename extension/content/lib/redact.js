// JAT v11 — forensic-trace redaction (PURE, DOM-free, node-testable).
//
// The auto-apply executor writes an INSANELY detailed step-trace to the task
// transcript for forensic debugging. That trace must NEVER leak sensitive values:
// passwords / SIN / full SSN / card numbers are dropped entirely ("[redacted]"),
// emails are masked to the last 4 chars of the local part, phones to the last 4
// digits, and every preview is truncated short so the transcript stays compact.
//
// These helpers are pure string functions (no DOM, no globals) so they live here,
// shared by executor.js AND unit-tested directly. Each is fully guarded — a hostile
// value must never throw inside the tracer (a logging bug must not break an apply).

// Labels (or values) whose mere presence means the value is too sensitive to log
// at all. Matched case-insensitively against the field label.
export const SENSITIVE_LABEL_RX = /(password|\bssn\b|social security|social insurance|\bsin\b|passport|credit ?card|card ?number|\bcvv\b|\bcvc\b|date of birth|\bdob\b|bank|routing|account ?number)/i;

// Mask any email to "***<last4-of-local>@domain" so the domain stays useful for
// debugging while the identity is obscured.
export function maskEmail(s) {
  return String(s).replace(/([\w.+-]+)@([\w.-]+)/g, (_m, user, dom) => {
    const u = String(user);
    const tail = u.length > 4 ? u.slice(-4) : u;
    return `***${tail}@${dom}`;
  });
}

// Mask any run of 7+ digits (with optional separators) to "***<last4>".
export function maskPhone(s) {
  return String(s).replace(/(\+?[\d][\d().\s-]{5,}\d)/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 7) return m;
    return `***${digits.slice(-4)}`;
  });
}

// redactValue(value, label?) — a safe-for-transcript preview of a field's value.
// "[redacted]" for sensitive labels, "[masked-by-site]" for ••••/****, emails +
// phones masked, everything truncated to ~40 chars. Empty → "<empty>".
export function redactValue(value, label = '') {
  try {
    if (SENSITIVE_LABEL_RX.test(String(label || ''))) return '[redacted]';
    let v = String(value == null ? '' : value).trim();
    if (!v) return '<empty>';
    if (/^(\*{2,}|•{2,})$/.test(v)) return '[masked-by-site]';
    v = maskEmail(v);
    v = maskPhone(v);
    if (v.length > 40) v = v.slice(0, 40) + '…';
    return v;
  } catch { return '[unprintable]'; }
}

// redactLabel(label) — labels can echo a sensitive value (a baked-in default), so
// mask emails/phones in them too and truncate to a short, transcript-friendly form.
export function redactLabel(label) {
  try {
    let l = String(label == null ? '' : label).replace(/\s+/g, ' ').trim();
    l = maskEmail(l);
    l = maskPhone(l);
    return l.slice(0, 80);
  } catch { return '[label?]'; }
}
