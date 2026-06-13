// JAT v11 — adapter-lite registry.
// These are NOT full per-site adapters (the v8/v9 mistake). The generic
// detector always runs; a site pack only contributes selector hints that
// sharpen context extraction and submit detection on the boards that matter.

import linkedin from './linkedin.js';
import indeed from './indeed.js';
import workday from './workday.js';
import greenhouse from './greenhouse.js';
import lever from './lever.js';

const PACKS = [linkedin, indeed, workday, greenhouse, lever];

export function sitePack(hostname = location.hostname) {
  const h = hostname.replace(/^www\./, '');
  return PACKS.find((p) => p.match(h)) || null;
}

export function detectSource(hostname = location.hostname) {
  const h = hostname.replace(/^www\./, '');
  if (/linkedin\.com$/.test(h)) return 'linkedin';
  if (/indeed\.([a-z.]+)$/.test(h)) return 'indeed';
  if (/glassdoor\.([a-z.]+)$/.test(h)) return 'glassdoor';
  if (/greenhouse\.io$/.test(h)) return 'greenhouse';
  if (/lever\.co$/.test(h)) return 'lever';
  if (/myworkdayjobs\.com$|workday/.test(h)) return 'workday';
  if (/ashbyhq\.com$/.test(h)) return 'ashby';
  if (/workable\.com$/.test(h)) return 'workable';
  if (/bamboohr\.com$/.test(h)) return 'bamboohr';
  if (/smartrecruiters\.com$/.test(h)) return 'smartrecruiters';
  if (/ziprecruiter\.com$/.test(h)) return 'ziprecruiter';
  return h;
}
