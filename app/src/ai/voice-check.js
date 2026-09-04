'use strict';
// ============================================================================
//  JAT v11 — voice check (AI Apply chunk 6)
//
//  Pierre's writing rules, enforced as a gate rather than a suggestion. From his standing brief:
//  never an em dash or en dash, never a semicolon, and never "I wanted to reach out", "passionate
//  about", "leverage", or "excited about the opportunity". The point is that a document must read
//  as him on a normal day, not as a machine.
//
//  WHY THIS IS NOT JUST A REGEX OVER THE RAW FILE
//  Overnight, résumés were checked with `grep -cE "—|–|;|…"` and every run reported violations,
//  because the HTML uses `&middot;` and `&amp;` — entities that END IN A SEMICOLON. The workaround
//  was to drop `;` from the check for HTML files, which quietly disabled the semicolon rule on the
//  exact documents most likely to contain one.
//
//  So HTML is DECODED FIRST: tags removed, entities resolved to their characters, and only then is
//  the prose checked. A real semicolon in a real sentence is caught; `&middot;` is not a finding.
//  A `&mdash;` entity now correctly resolves to an em dash and IS caught, which the old check could
//  never see at all.
// ============================================================================

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  middot: '·', bull: '•', hellip: '…',
  mdash: '—', ndash: '–', minus: '−',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç',
  uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  copy: '©', reg: '®', trade: '™', deg: '°',
  rarr: '→', larr: '←', uarr: '↑', darr: '↓', harr: '↔',
  times: '×', divide: '÷', plusmn: '±', frac12: '½', pound: '£', euro: '€',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    // An entity NAME we do not model still ends in a semicolon, and leaving it intact reports that
    // semicolon as a violation. Caught on a real document: "0&rarr;1" was rejected for a semicolon
    // that does not exist in the prose. Unknown named entities become a space — the character they
    // stand for is decorative here, and what matters is that the `;` does not survive into the
    // text being checked. Numeric entities are decoded exactly, above.
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => {
      const k = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : ' ';
    });
}

// HTML in, readable prose out. Script and style contents are dropped entirely — they are code, and
// a semicolon there is correct rather than a violation.
function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/[ \t]+/g, ' ');
}

const RULES = [
  { id: 'em-dash', label: 'em dash', rx: /—/g, fix: 'use a comma, a full stop, or rewrite the sentence' },
  { id: 'en-dash', label: 'en dash', rx: /–/g, fix: 'write "to" in a range, or use a comma' },
  { id: 'other-dash', label: 'figure or horizontal dash', rx: /[‒―]/g, fix: 'use a plain hyphen or rewrite' },
  { id: 'semicolon', label: 'semicolon', rx: /;/g, fix: 'split it into two sentences' },
  { id: 'reach-out', label: '"wanted to reach out"', rx: /\bwanted to reach out\b/gi, fix: 'say what you want directly' },
  { id: 'passionate', label: '"passionate about"', rx: /\bpassionate about\b/gi, fix: 'say what you actually do instead' },
  { id: 'leverage', label: '"leverage"', rx: /\bleverag(e|es|ed|ing)\b/gi, fix: 'use "use"' },
  { id: 'excited-opportunity', label: '"excited about the opportunity"', rx: /\bexcited about the opportunit(y|ies)\b/gi, fix: 'say why the role is interesting, concretely' },
];

// Line and column of an offset, so a finding points at somewhere real in the file.
function locate(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const col = index - (before.lastIndexOf('\n') + 1) + 1;
  return { line, col };
}

function contextAround(text, index, len) {
  const start = Math.max(0, index - 45);
  const end = Math.min(text.length, index + len + 45);
  return (start ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

// voiceCheck(content, { html }) -> { ok, violations, checkedChars }
function voiceCheck(content, opts = {}) {
  const raw = String(content == null ? '' : content);
  const isHtml = opts.html === true || (opts.html !== false && /<\/?[a-z][\s\S]*>/i.test(raw));
  const text = isHtml ? htmlToText(raw) : raw;

  const violations = [];
  for (const rule of RULES) {
    rule.rx.lastIndex = 0;
    let m;
    while ((m = rule.rx.exec(text)) !== null) {
      const { line, col } = locate(text, m.index);
      violations.push({
        rule: rule.id, label: rule.label, found: m[0], line, col,
        context: contextAround(text, m.index, m[0].length),
        fix: rule.fix,
      });
      if (m[0].length === 0) rule.rx.lastIndex++;
      if (violations.length >= 200) break;
    }
  }
  violations.sort((a, b) => a.line - b.line || a.col - b.col);
  return { ok: violations.length === 0, violations, checkedChars: text.length, decodedFromHtml: isHtml };
}

// One short, actionable report — this is what the agent is shown when its document is rejected.
function report(result) {
  if (result.ok) return `voice check passed (${result.checkedChars} characters checked)`;
  const lines = [`voice check FAILED — ${result.violations.length} violation(s):`];
  for (const v of result.violations.slice(0, 25)) {
    lines.push(`  line ${v.line}: ${v.label} — ${v.fix}`);
    lines.push(`    ${v.context}`);
  }
  if (result.violations.length > 25) lines.push(`  …and ${result.violations.length - 25} more`);
  return lines.join('\n');
}

module.exports = { voiceCheck, report, htmlToText, decodeEntities, RULES };
