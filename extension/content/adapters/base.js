// Adapter base utilities — shared helpers used by every site adapter.
// Adapters are pure functions of the live DOM. They DO NOT touch chrome.* APIs;
// the universal capture orchestrator does that.

export const text = (n) => (n?.textContent || '').replace(/\s+/g, ' ').trim();

export function find(sels, root) {
  root = root || document;
  for (const s of sels) {
    try { const e = root.querySelector(s); if (e) return e; } catch {}
  }
  return null;
}

export function firstText(sels, root) {
  root = root || document;
  for (const s of sels) {
    try {
      const v = text(root.querySelector(s));
      if (v) return v;
    } catch {}
  }
  return '';
}

// Read JSON-LD JobPosting from the page (works on most modern job boards: Greenhouse, Lever, Workable, many ATS).
export function jsonLdJobPosting() {
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const d = JSON.parse(s.textContent || 'null');
      const items = Array.isArray(d) ? d : [d];
      const stack = [...items];
      while (stack.length) {
        const i = stack.shift();
        if (!i) continue;
        if (i['@graph']) stack.push(...(Array.isArray(i['@graph']) ? i['@graph'] : [i['@graph']]));
        const t = i['@type'];
        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) return i;
      }
    } catch {}
  }
  return null;
}

export function locFromJsonLd(jp) {
  const loc = jp.jobLocation;
  if (!loc) return '';
  const list = Array.isArray(loc) ? loc : [loc];
  return list.map((l) => {
    const a = l.address || {};
    return [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(', ');
  }).filter(Boolean).join(' / ');
}

export function salaryFromJsonLd(jp) {
  const v = jp.baseSalary?.value;
  if (!v) return '';
  const cur = jp.baseSalary.currency || '';
  const unit = v.unitText ? ` /${String(v.unitText).toLowerCase()}` : '';
  if (v.minValue && v.maxValue) return `${cur} ${v.minValue}-${v.maxValue}${unit}`.trim();
  if (v.value) return `${cur} ${v.value}${unit}`.trim();
  return '';
}

export function descFromJsonLd(jp) {
  if (!jp?.description) return '';
  return String(jp.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
}

export function genericContextFromJsonLd() {
  const jp = jsonLdJobPosting();
  if (!jp) return null;
  return {
    title: jp.title || '',
    company: jp.hiringOrganization?.name || '',
    location: locFromJsonLd(jp),
    compensation: salaryFromJsonLd(jp),
    employmentType: Array.isArray(jp.employmentType) ? jp.employmentType[0] : (jp.employmentType || ''),
    description: descFromJsonLd(jp),
    datePosted: jp.datePosted || '',
    jobUrl: jp.url || location.href,
  };
}

// Heuristic: scan small DOM snippets for salary/work-mode/employment cues.
export function harvestSnippets(root) {
  root = root || document;
  return Array.from(root.querySelectorAll('button, span, div, li, p'))
    .map(text)
    .filter((v) => v && v.length < 240);
}

export function pickSalary(snippets) {
  return snippets.find((v) => /(\$|US\$|CA\$|€|£|¥|₹)\s?\d|\d+(K|k)\s*\/\s*(yr|year|hr|hour)|\d{2,3}[Kk]\s*-\s*\d{2,3}[Kk]/.test(v)) || '';
}
export function pickWorkMode(snippets) {
  return snippets.find((v) => /\b(remote|hybrid|on-?site)\b/i.test(v)) || '';
}
export function pickEmployment(snippets) {
  return snippets.find((v) => /\b(full-?time|part-?time|contract|internship|temporary)\b/i.test(v)) || '';
}

// Generic multi-step "Next / Continue / Review" click detection across most ATS.
// Adapters can override but this catches LinkedIn/Indeed/Workday/Greenhouse defaults.
export function isStepAdvanceClick(el) {
  if (!el) return false;
  const t = (el.textContent || '').trim();
  const aria = el.getAttribute?.('aria-label') || '';
  const dataId = el.getAttribute?.('data-automation-id') || '';
  const cls = (el.className || '').toString();
  const all = `${t} ${aria} ${dataId} ${cls}`.toLowerCase();
  // EN + common multilingual labels
  return /\b(next|continue|review|save and continue|save \& continue|step\s+\d|suivant|continuer|siguiente|continuar|weiter|avanti)\b/.test(all)
      || /\bnext-button|continueButton|wizard-?next|go-?next|btn-?next\b/i.test(cls);
}
