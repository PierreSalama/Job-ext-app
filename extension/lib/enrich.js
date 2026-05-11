// Aggressive multi-source enrichment. For each LinkedIn job ID we fetch
// /jobs/view/{id}/ as HTML and try THREE extraction paths:
//   1. JSON-LD JobPosting (most stable, present on most pages)
//   2. LinkedIn's hydration JSON in <code id="bpr-guid-..."> blocks
//      (this is the raw Voyager API response — has more fields than JSON-LD)
//   3. Regex on the rendered HTML / inline text patterns
// Results from all three are merged, with later sources only filling fields
// that earlier sources didn't set.

import { db, patchJob, broadcast } from './db.js';
import { log } from './logger.js';

const VIEW_URL = (id) => `https://www.linkedin.com/jobs/view/${id}/`;

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

function htmlText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeJsonString(s) {
  // Handles \uXXXX, \n, \t, \", \\ that appear in raw JSON strings inside HTML
  try { return JSON.parse(`"${s}"`); }
  catch { return s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
}

// ---------- 1. JSON-LD ----------
function extractAllJsonLd(html) {
  const out = [];
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const parsed = safeJson(m[1].trim());
    if (parsed) {
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) if (item && typeof item === 'object') out.push(item);
    }
  }
  return out;
}

function findJobPosting(jsonLdItems) {
  for (const i of jsonLdItems) {
    const t = i['@type'];
    if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) return i;
  }
  return null;
}

function parseJsonLd(jp) {
  const loc = jp.jobLocation;
  const locList = Array.isArray(loc) ? loc : (loc ? [loc] : []);
  const location = locList.map((l) => {
    const a = l.address || {};
    return [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(', ');
  }).filter(Boolean).join(' / ');

  let salary = '';
  const bs = jp.baseSalary;
  if (bs?.value) {
    const v = bs.value;
    const cur = bs.currency || '';
    if (v.minValue && v.maxValue) salary = `${cur} ${Math.round(v.minValue)}-${Math.round(v.maxValue)}`.trim();
    else if (v.value) salary = `${cur} ${Math.round(v.value)}`.trim();
    if (v.unitText) salary += ` /${String(v.unitText).toLowerCase()}`;
  }

  const description = typeof jp.description === 'string' ? htmlText(jp.description).slice(0, 12000) : '';

  return {
    title: jp.title || '',
    company: jp.hiringOrganization?.name || '',
    companySiteUrl: jp.hiringOrganization?.sameAs || '',
    location,
    compensation: salary,
    description,
    employmentType: Array.isArray(jp.employmentType) ? jp.employmentType.join(', ') : (jp.employmentType || ''),
    workMode: jp.jobLocationType ? String(jp.jobLocationType).replace(/^https:\/\/schema\.org\//i, '') : '',
    seniority: jp.experienceRequirements?.qualifications || '',
    datePosted: jp.datePosted || '',
    industry: jp.industry || '',
    validThrough: jp.validThrough || ''
  };
}

// ---------- 2. Hydration JSON in <code> blocks ----------
// LinkedIn injects raw Voyager API responses as JSON inside hidden <code> tags.
// We extract every <code id="bpr-guid-..."> block and look at the parsed JSON
// for objects that look like job postings. Field names follow Voyager schema.
function extractCodeBlocks(html) {
  const out = [];
  // Match <code ...id="bpr-guid-..."...>{...}</code> with optional HTML comment wrapper
  const regex = /<code[^>]+id=["']bpr-guid-[^"']+["'][^>]*>(?:<!--)?([\s\S]+?)(?:-->)?<\/code>/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const parsed = safeJson(m[1].trim());
    if (parsed) out.push(parsed);
  }
  return out;
}

// Walk a deep object and collect every node that has the shape of a JobPosting
function findJobPostingsInObject(obj, results = [], depth = 0) {
  if (depth > 30 || !obj || typeof obj !== 'object') return results;
  // Check if this looks like a job posting
  if (obj.title && (obj.description || obj.formattedJobFunctions || obj.applyMethod || obj.workplaceTypes)) {
    results.push(obj);
  }
  if (Array.isArray(obj)) {
    for (const item of obj) findJobPostingsInObject(item, results, depth + 1);
  } else {
    for (const k of Object.keys(obj)) findJobPostingsInObject(obj[k], results, depth + 1);
  }
  return results;
}

function parseVoyagerJob(vj) {
  const out = {};
  if (typeof vj.title === 'string') out.title = vj.title;
  // Description — could be plain string or structured
  if (vj.description) {
    if (typeof vj.description === 'string') out.description = htmlText(vj.description).slice(0, 12000);
    else if (typeof vj.description.text === 'string') out.description = vj.description.text.slice(0, 12000);
  }
  // Location
  if (typeof vj.formattedLocation === 'string') out.location = vj.formattedLocation;
  // Salary
  if (vj.formattedSalaryDescription) out.compensation = vj.formattedSalaryDescription;
  else if (vj.salaryInsights?.formattedSalaryRange) out.compensation = vj.salaryInsights.formattedSalaryRange;
  else if (vj.compensation?.formattedTotalCompensation) out.compensation = vj.compensation.formattedTotalCompensation;
  // Employment type
  if (vj.formattedEmploymentStatus) out.employmentType = vj.formattedEmploymentStatus;
  // Workplace types
  if (Array.isArray(vj.workplaceTypes) && vj.workplaceTypes.length) {
    out.workMode = vj.workplaceTypes.map((t) => {
      const s = String(t || '').split(':').pop() || '';
      return s.charAt(0) + s.slice(1).toLowerCase();
    }).filter(Boolean).join(', ');
  } else if (Array.isArray(vj.workplaceTypesResolutionResults)) {
    out.workMode = vj.workplaceTypesResolutionResults.map((r) => r.localizedName).filter(Boolean).join(', ');
  }
  // Seniority
  if (vj.formattedExperienceLevel) out.seniority = vj.formattedExperienceLevel;
  // Apply method
  if (vj.applyMethod) {
    const k = Object.keys(vj.applyMethod)[0] || '';
    if (k.toLowerCase().includes('offsite')) out.applyMethod = 'external';
    else out.applyMethod = 'easy_apply';
    // External apply URL
    if (vj.applyMethod.companyApplyUrl) out.companyApplyUrl = vj.applyMethod.companyApplyUrl;
  }
  // Applicants count
  if (typeof vj.applies === 'number') out.applicantsCount = vj.applies;
  if (typeof vj.views === 'number') out.viewsCount = vj.views;
  // Posted date
  if (vj.listedAt) out.datePosted = new Date(vj.listedAt).toISOString();
  return out;
}

function extractCompanyName(allJsonObjects) {
  // In Voyager hydration data, companies appear as separate objects with $type
  for (const root of allJsonObjects) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (node.$type && String(node.$type).includes('voyager.organization.Company')) {
        if (typeof node.name === 'string' && node.name) return node.name;
        if (typeof node.universalName === 'string') return node.universalName;
      }
      if (node.companyDetails?.companyResolutionResult?.name) return node.companyDetails.companyResolutionResult.name;
      if (Array.isArray(node)) for (const x of node) stack.push(x);
      else for (const k of Object.keys(node)) stack.push(node[k]);
    }
  }
  return '';
}

// ---------- 3. Regex on raw HTML / JSON-as-strings ----------
function extractByRegex(html) {
  const result = {};

  // Title in <title> tag (often "Title | Company | LinkedIn")
  const titleTag = html.match(/<title>([^<]+)<\/title>/);
  if (titleTag) {
    const parts = titleTag[1].split(/\s\|\s/).map((s) => s.trim()).filter(Boolean);
    if (parts[0] && !/LinkedIn/i.test(parts[0])) result.title = parts[0];
    if (parts[1] && !/LinkedIn/i.test(parts[1])) result.company = parts[1];
  }

  // Description in JSON: "description":{"text":"..."}
  const descMatch = html.match(/"description"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])+)"/);
  if (descMatch) {
    result.description = decodeJsonString(descMatch[1]).slice(0, 12000);
  }
  // Or "description":"..."
  if (!result.description) {
    const m2 = html.match(/"description"\s*:\s*"((?:\\.|[^"\\])+)"/);
    if (m2 && m2[1].length > 100) result.description = htmlText(decodeJsonString(m2[1])).slice(0, 12000);
  }

  // Salary: "formattedSalaryDescription":"..."
  const salaryMatch = html.match(/"formattedSalaryDescription"\s*:\s*"([^"]+)"/);
  if (salaryMatch) result.compensation = decodeJsonString(salaryMatch[1]);
  if (!result.compensation) {
    const sm2 = html.match(/"formattedTotalCompensation"\s*:\s*"([^"]+)"/);
    if (sm2) result.compensation = decodeJsonString(sm2[1]);
  }

  // Location
  const locMatch = html.match(/"formattedLocation"\s*:\s*"([^"]+)"/);
  if (locMatch) result.location = decodeJsonString(locMatch[1]);

  // Employment status
  const empMatch = html.match(/"formattedEmploymentStatus"\s*:\s*"([^"]+)"/);
  if (empMatch) result.employmentType = decodeJsonString(empMatch[1]);

  // Experience level
  const expMatch = html.match(/"formattedExperienceLevel"\s*:\s*"([^"]+)"/);
  if (expMatch) result.seniority = decodeJsonString(expMatch[1]);

  // Workplace type (REMOTE/HYBRID/ONSITE)
  const wpMatches = [...html.matchAll(/"workplaceTypes":\[([^\]]+)\]/g)];
  if (wpMatches.length) {
    const tokens = [...wpMatches[0][1].matchAll(/"([^"]+)"/g)].map((m) => m[1].split(':').pop());
    if (tokens.length) {
      result.workMode = tokens.map((t) => t.charAt(0) + t.slice(1).toLowerCase()).join(', ');
    }
  }

  // Applicants
  const appMatch = html.match(/"applies"\s*:\s*(\d+)/);
  if (appMatch) result.applicantsCount = Number(appMatch[1]);

  // Apply method (easy apply vs offsite)
  if (/"\$type"\s*:\s*"com\.linkedin\.voyager\.jobs\.OffsiteApply"/.test(html)) result.applyMethod = 'external';
  else if (/"\$type"\s*:\s*"com\.linkedin\.voyager\.jobs\.ComplexOnsiteApply"/.test(html)) result.applyMethod = 'easy_apply';
  else if (/"\$type"\s*:\s*"com\.linkedin\.voyager\.jobs\.SimpleOnsiteApply"/.test(html)) result.applyMethod = 'easy_apply';

  // Company apply URL (for external)
  const cuMatch = html.match(/"companyApplyUrl"\s*:\s*"([^"]+)"/);
  if (cuMatch) result.companyApplyUrl = decodeJsonString(cuMatch[1]);

  // Posted date
  const listedMatch = html.match(/"listedAt"\s*:\s*(\d+)/);
  if (listedMatch) result.datePosted = new Date(Number(listedMatch[1])).toISOString();

  return result;
}

// ---------- Combiner ----------
function mergeBest(target, source) {
  if (!source) return target;
  for (const k of Object.keys(source)) {
    const v = source[k];
    if (v == null || v === '') continue;
    // If existing field is empty / null / shorter, replace
    const cur = target[k];
    if (cur == null || cur === '') { target[k] = v; continue; }
    // For description, prefer the longer one
    if (k === 'description' && typeof v === 'string' && typeof cur === 'string' && v.length > cur.length) {
      target[k] = v;
    }
  }
  return target;
}

export async function enrichLinkedInJob(jobId) {
  if (!jobId) return null;
  const t0 = Date.now();
  try {
    log.debug('enrich.fetch', `Fetching HTML for job ${jobId}`);
    const r = await fetch(VIEW_URL(jobId), {
      credentials: 'include',
      headers: { 'Accept': 'text/html,application/xhtml+xml' }
    });
    if (!r.ok) {
      log.warn('enrich.fetch', `HTTP ${r.status} for job ${jobId}`);
      return null;
    }
    const html = await r.text();
    log.debug('enrich.fetch', `HTML received`, { jobId, bytes: html.length, elapsed: Date.now() - t0 });
    if (html.length < 500) {
      log.warn('enrich.fetch', `HTML too short (login wall?)`, { jobId, bytes: html.length });
      return null;
    }

    const result = {};

    // Path 1: JSON-LD
    const jsonLdItems = extractAllJsonLd(html);
    const jp = findJobPosting(jsonLdItems);
    if (jp) mergeBest(result, parseJsonLd(jp));

    // Path 2: hydration code blocks
    const codeBlocks = extractCodeBlocks(html);
    if (codeBlocks.length) {
      const postings = [];
      for (const block of codeBlocks) findJobPostingsInObject(block, postings);
      // Pick the posting with the longest description / most fields
      postings.sort((a, b) => {
        const aLen = (a.description?.text || a.description || '').length;
        const bLen = (b.description?.text || b.description || '').length;
        return bLen - aLen;
      });
      if (postings[0]) mergeBest(result, parseVoyagerJob(postings[0]));
      // Try to pull company name from any object in the hydration data
      if (!result.company) {
        const c = extractCompanyName(codeBlocks);
        if (c) result.company = c;
      }
    }

    // Path 3: regex fallback
    mergeBest(result, extractByRegex(html));

    log.info('enrich.fetch', `Parsed job ${jobId}`, {
      jobId, elapsed: Date.now() - t0,
      jsonLdFound: !!jp, codeBlocksFound: codeBlocks.length,
      descLen: (result.description || '').length, hasSalary: !!result.compensation,
      hasLocation: !!result.location, hasWorkMode: !!result.workMode,
      hasEmployment: !!result.employmentType
    });
    return result;
  } catch (e) {
    log.error('enrich.fetch', `Failed for job ${jobId}`, { error: String(e.message || e), elapsed: Date.now() - t0 });
    return null;
  }
}

// Run through all jobs that look sparse and fill them in.
export async function enrichAllSparseJobs(onProgress) {
  const all = await db.getAll('jobs');
  const sparse = all.filter((j) => {
    if (!j.linkedinJobId) return false;
    return !j.description || j.description.length < 80 || !j.compensation || !j.location;
  });
  let done = 0, updated = 0;
  for (const j of sparse) {
    onProgress?.({ done, total: sparse.length, current: j });
    try {
      const enriched = await enrichLinkedInJob(j.linkedinJobId);
      if (enriched && (enriched.description || enriched.compensation || enriched.location)) {
        const patch = {
          title: j.title || enriched.title,
          company: j.company || enriched.company,
          location: enriched.location || j.location,
          description: enriched.description || j.description,
          compensation: enriched.compensation || j.compensation,
          employmentType: enriched.employmentType || j.employmentType,
          workMode: enriched.workMode || j.workMode,
          seniority: enriched.seniority || j.seniority,
          companySiteUrl: enriched.companySiteUrl || j.companySiteUrl
        };
        await patchJob(j.id, patch);
        updated++;
      }
    } catch {}
    done++;
    await new Promise((r) => setTimeout(r, 350));
  }
  onProgress?.({ done, total: sparse.length, finished: true, updated });
  await broadcast('enrichment.complete', { scanned: sparse.length, updated });
  return { scanned: sparse.length, updated };
}
