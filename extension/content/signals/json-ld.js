// JAT v11 — JSON-LD JobPosting signal (carried over from v10; proven).
// When present it's the most reliable metadata source on every major board.

export function readJsonLdJobPosting() {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const s of scripts) {
    let data;
    try { data = JSON.parse(s.textContent); } catch { continue; }
    const found = findJobPosting(data);
    if (found) return { confidence: 0.9, context: toContext(found) };
  }
  return null;
}

function findJobPosting(node) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const f = findJobPosting(n); if (f) return f; }
    return null;
  }
  if (typeof node === 'object') {
    const t = node['@type'];
    if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) return node;
    if (node['@graph']) return findJobPosting(node['@graph']);
  }
  return null;
}

function toContext(jp) {
  const title = jp.title || '';
  const company = jp.hiringOrganization?.name || jp.hiringOrganization || '';
  const location = locationFromJsonLd(jp);
  const compensation = salaryFromJsonLd(jp);
  const description = stripHtml(jp.description || '').slice(0, 8000);
  const workMode = jp.jobLocationType === 'TELECOMMUTE' ? 'Remote' : '';
  const employmentType = Array.isArray(jp.employmentType) ? jp.employmentType[0] : (jp.employmentType || '');
  return {
    title: String(title).trim(),
    company: typeof company === 'string' ? company.trim() : '',
    location,
    compensation,
    description,
    workMode,
    employmentType: prettifyEmployment(employmentType),
  };
}

function locationFromJsonLd(jp) {
  const loc = jp.jobLocation || (Array.isArray(jp.jobLocation) ? jp.jobLocation[0] : null);
  const node = Array.isArray(loc) ? loc[0] : loc;
  const addr = node?.address;
  if (!addr) return '';
  return [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(', ');
}

function salaryFromJsonLd(jp) {
  const s = jp.baseSalary;
  if (!s) return '';
  const v = s.value || s;
  const min = v.minValue, max = v.maxValue, unit = v.unitText || s.unitText || '';
  const cur = s.currency || v.currency || '';
  if (min && max) return `${cur} ${min}–${max} ${unit}`.trim();
  if (v.value) return `${cur} ${v.value} ${unit}`.trim();
  return '';
}

function stripHtml(s) { return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function prettifyEmployment(e) {
  const map = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACTOR: 'Contract', TEMPORARY: 'Temporary', INTERN: 'Internship' };
  return map[String(e).toUpperCase()] || (e ? String(e) : '');
}
