// Application schema + per-field validators + sanitizer.
// Every captured/enriched field MUST pass through sanitize() before being saved
// to IDB. This stops garbage like "Take the next step in your job search" from
// landing in the salary field.

// ============ Status state machine ============
export const STATUS_FLOW = {
  // category drives color/grouping in UI
  // canFollow: which previous statuses can transition into this one ('any' = manual override allowed always)
  discovered:          { label: 'Discovered',          category: 'pre',       order: 0,  canFollow: 'any' },
  started:             { label: 'Started',             category: 'pre',       order: 10, canFollow: ['discovered'] },
  submitted:           { label: 'Submitted',           category: 'submitted', order: 20, canFollow: ['discovered', 'started'] },
  received:            { label: 'Received',            category: 'progress',  order: 30, canFollow: ['submitted'] },
  reviewing:           { label: 'In review',           category: 'progress',  order: 40, canFollow: ['submitted', 'received'] },
  recruiter_replied:   { label: 'Recruiter replied',   category: 'progress',  order: 50, canFollow: ['submitted', 'received', 'reviewing'] },
  interview:           { label: 'Interview',           category: 'active',    order: 60, canFollow: ['submitted', 'received', 'reviewing', 'recruiter_replied'] },
  assessment:          { label: 'Assessment',          category: 'active',    order: 70, canFollow: ['submitted', 'received', 'reviewing', 'recruiter_replied', 'interview'] },
  offer:               { label: 'Offer',               category: 'win',       order: 90, canFollow: 'any' },
  rejected:            { label: 'Rejected',            category: 'loss',      order: 95, canFollow: 'any' },
  withdrawn:           { label: 'Withdrawn',           category: 'closed',    order: 96, canFollow: 'any' },
  archived:            { label: 'Archived',            category: 'closed',    order: 99, canFollow: 'any' }
};

export const STATUSES = Object.keys(STATUS_FLOW);
export const STATUS_LABELS = Object.fromEntries(STATUSES.map((s) => [s, STATUS_FLOW[s].label]));

export const STATUS_COLORS = {
  discovered: '#a1a1aa',
  started: '#71717a',
  submitted: '#3b82f6',
  received: '#3b82f6',
  reviewing: '#8b5cf6',
  recruiter_replied: '#f59e0b',
  interview: '#f97316',
  assessment: '#a855f7',
  offer: '#10b981',
  rejected: '#ef4444',
  withdrawn: '#a1a1aa',
  archived: '#a1a1aa'
};

export const ACTIVE_STATUSES = new Set(['started', 'submitted', 'received', 'reviewing', 'recruiter_replied', 'interview', 'assessment']);
export const TERMINAL_STATUSES = new Set(['offer', 'rejected', 'withdrawn', 'archived']);

export function statusOrder(s) { return STATUS_FLOW[s]?.order ?? 0; }
export function isHigherStatus(target, current) { return statusOrder(target) > statusOrder(current); }
export function canTransition(from, to) {
  const flow = STATUS_FLOW[to];
  if (!flow) return false;
  if (flow.canFollow === 'any') return true;
  return flow.canFollow.includes(from);
}

// ============ UI prompt blacklist ============
// Strings that frequently leak into scraped fields. Reject any value matching.
const UI_PROMPT_RX = /\b(take the next step|easy apply|apply now|view|click|tap|see all|learn more|expand|read more|continue|sign in|join now|join linkedin|create alert|set alert|save job|share|follow|message|connect|view all|back to top|skip to content|see more|show more|hide|less|show less)\b/i;

function looksLikeUIPrompt(v) {
  return typeof v === 'string' && UI_PROMPT_RX.test(v);
}

function clean(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

// ============ Field validators ============
// Each returns the cleaned value if valid, or '' if invalid.

export function validateTitle(v) {
  const c = clean(v);
  if (!c || c.length > 250) return '';
  if (looksLikeUIPrompt(c)) return '';
  return c;
}

export function validateCompany(v) {
  const c = clean(v);
  if (!c || c.length > 200) return '';
  if (looksLikeUIPrompt(c)) return '';
  // Reject if it's just numbers or generic terms
  if (/^(jobs?|company|companies|results?)$/i.test(c)) return '';
  return c;
}

export function validateLocation(v) {
  const c = clean(v);
  if (!c || c.length < 2 || c.length > 200) return '';
  if (looksLikeUIPrompt(c)) return '';
  if (/^\d+$/.test(c)) return '';
  // Reject bullet-list content / multi-sentence strings (likely description leak)
  if (c.length > 100 && /[.!?]/.test(c)) return '';
  // Reject emojis as primary content
  if (/^[\W_]+$/.test(c)) return '';
  return c;
}

// Match any reasonable salary token: currency + digits, K-shorthand, /yr|hr rates, ranges.
const SALARY_RX = /(?:US\$|CA\$|\$|€|£|¥|₹)\s?[\d,]+(?:\.\d+)?(?:\s*[KkMm])?(?:\s*\/\s*(?:yr|hr|year|hour|mo|month|wk|week))?|[\d,]+\s*[Kk]\s*[-–—]\s*[\d,]+\s*[Kk]|[\d,]+\s*(?:to|-|–)\s*[\d,]+\s*(?:USD|CAD|EUR|GBP|hour|year|hr|yr|month|mo)/i;

export function validateSalary(v) {
  const c = clean(v);
  if (!c || c.length < 4 || c.length > 150) return '';
  if (looksLikeUIPrompt(c)) return '';
  if (!SALARY_RX.test(c)) return '';
  // Reject if it contains apply/learn/take phrases even if currency present
  if (/take the next|easy apply|learn more|click here|view all|sign in/i.test(c)) return '';
  // Reject if it has a sentence-like structure (likely description leak)
  if (/[.!?]\s+[A-Z]/.test(c)) return '';
  return c;
}

export function validateWorkMode(v) {
  if (!v) return '';
  const lower = String(v).toLowerCase();
  if (/\bremote\b/.test(lower) && !/hybrid|on-?site|onsite/.test(lower)) return 'Remote';
  if (/\bhybrid\b/.test(lower)) return 'Hybrid';
  if (/\bon-?site\b/.test(lower) || /\bonsite\b/.test(lower)) return 'On-site';
  if (/\bremote\b/.test(lower)) return 'Remote';
  return '';
}

export function validateEmploymentType(v) {
  if (!v) return '';
  const lower = String(v).toLowerCase();
  if (/\bfull[\s-]?time\b/.test(lower)) return 'Full-time';
  if (/\bpart[\s-]?time\b/.test(lower)) return 'Part-time';
  if (/\bcontract\b/.test(lower) || /\bcontractor\b/.test(lower)) return 'Contract';
  if (/\binternship\b|\bintern\b/.test(lower)) return 'Internship';
  if (/\btemporary\b|\btemp\b/.test(lower)) return 'Temporary';
  if (/\bvolunteer\b/.test(lower)) return 'Volunteer';
  return '';
}

export function validateSeniority(v) {
  if (!v) return '';
  const lower = String(v).toLowerCase();
  if (/\bentry[\s-]?level\b/.test(lower)) return 'Entry level';
  if (/\bassociate\b/.test(lower)) return 'Associate';
  if (/\bmid[\s-]?senior\b/.test(lower) || /\bmid[\s-]?level\b/.test(lower)) return 'Mid-Senior';
  if (/\bdirector\b/.test(lower)) return 'Director';
  if (/\bexecutive\b/.test(lower)) return 'Executive';
  if (/\bsenior\b/.test(lower)) return 'Senior';
  if (/\bjunior\b/.test(lower)) return 'Junior';
  if (/\bintern(?:ship)?\b/.test(lower)) return 'Internship';
  return '';
}

export function validateRecruiterName(v) {
  const c = clean(v);
  if (!c || c.length < 3 || c.length > 100) return '';
  if (looksLikeUIPrompt(c)) return '';
  // First char should be a letter
  if (!/^[\p{L}]/u.test(c)) return '';
  // Reject obvious non-names
  if (/recruiting team|hiring team|talent acquisition|hr team|the team/i.test(c)) return '';
  return c;
}

export function validateRecruiterTitle(v) {
  const c = clean(v);
  if (!c || c.length < 2 || c.length > 120) return '';
  if (looksLikeUIPrompt(c)) return '';
  return c;
}

export function validateApplicantsSummary(v) {
  const c = clean(v);
  if (!c) return '';
  // Only keep "X applicants" type strings
  const m = c.match(/(\d+(?:,\d+)*\+?\s*applicants?\b|over\s+\d+\s*applicants?\b|be among the first \d+ applicants?)/i);
  return m ? m[0] : '';
}

export function validateDescription(v) {
  if (!v) return '';
  let c = String(v).replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  // Strip common navigation footer text that leaks in
  c = c.replace(/Skip to (?:main )?content/gi, '');
  c = c.replace(/Sign in to (?:save|view)[^\n]+/gi, '');
  c = c.replace(/About\s+Press\s+Blog[\s\S]+/g, ''); // LinkedIn footer
  c = c.replace(/Take the next step in your job search[\s\S]*?(?=\n|$)/gi, '');
  if (c.length < 30) return ''; // too short to be a real description
  return c.slice(0, 15000);
}

export function validateUrl(v) {
  if (!v) return '';
  try {
    const u = new URL(v);
    return u.toString();
  } catch {
    return '';
  }
}

// ============ Master sanitizer ============
// Applied to every captured/enriched record before write.
// Returns a NEW object with only valid fields. Logs rejected fields if onReject given.

export function sanitizeApplication(raw, onReject) {
  const reject = (field, reason, original) => {
    if (typeof onReject === 'function') onReject(field, reason, original);
  };

  const out = {};

  // Pass-through (no validation needed)
  for (const k of ['id', 'linkedinJobId', 'jobUrl', 'companySiteUrl', 'source', '_source',
                   'createdAt', 'updatedAt', 'submittedAt', 'lastActivityAt', 'followUpDueAt',
                   'datePosted', 'starred', 'applied', 'tags', 'notes', 'questions',
                   'answers', 'timeline', 'lastEmailMessageId', 'lastEmailSubject',
                   'lastEmailFrom', 'emailMatchCount', 'resumeName', 'coverLetterName', 'attachments', 'answersCaptured', 'externalId', 'industry']) {
    if (raw[k] !== undefined) out[k] = raw[k];
  }

  // jobUrl validation (optional)
  if (raw.jobUrl) {
    const u = validateUrl(raw.jobUrl);
    if (u) out.jobUrl = u; else { delete out.jobUrl; reject('jobUrl', 'invalid url', raw.jobUrl); }
  }
  if (raw.companySiteUrl) {
    const u = validateUrl(raw.companySiteUrl);
    if (u) out.companySiteUrl = u; else { delete out.companySiteUrl; reject('companySiteUrl', 'invalid url', raw.companySiteUrl); }
  }

  // Validated text fields
  const v = (field, validator, value) => {
    const cleaned = validator(value);
    if (cleaned) out[field] = cleaned;
    else if (value) reject(field, `failed validator`, value);
  };

  v('title',              validateTitle,              raw.title);
  v('company',            validateCompany,            raw.company);
  v('location',           validateLocation,           raw.location);
  v('compensation',       validateSalary,             raw.compensation);
  v('workMode',           validateWorkMode,           raw.workMode);
  v('employmentType',     validateEmploymentType,     raw.employmentType);
  v('seniority',          validateSeniority,          raw.seniority);
  v('recruiterName',      validateRecruiterName,      raw.recruiterName);
  v('recruiterTitle',     validateRecruiterTitle,     raw.recruiterTitle);
  v('applicantsSummary',  validateApplicantsSummary,  raw.applicantsSummary);
  v('description',        validateDescription,        raw.description);

  // status: must be a known status
  if (raw.status) {
    const s = String(raw.status).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    out.status = STATUSES.includes(s) ? s : 'started';
  }

  // confidence: enum
  if (raw.confidence) {
    out.confidence = ['low', 'medium', 'high'].includes(raw.confidence) ? raw.confidence : 'medium';
  }

  return out;
}

// ============ Field display metadata ============
// Used by the UI to render structured sections.
export const FIELD_GROUPS = {
  overview: ['title', 'company', 'location', 'jobUrl'],
  compensation: ['compensation', 'workMode', 'employmentType', 'seniority'],
  hiring: ['recruiterName', 'recruiterTitle', 'applicantsSummary'],
  application: ['resumeName', 'submittedAt', 'followUpDueAt'],
  source: ['source', 'datePosted', 'companySiteUrl', 'industry']
};

export const FIELD_LABELS = {
  title: 'Job title',
  company: 'Company',
  location: 'Location',
  jobUrl: 'Job URL',
  compensation: 'Salary / compensation',
  workMode: 'Work mode',
  employmentType: 'Employment type',
  seniority: 'Seniority',
  recruiterName: 'Recruiter / Hiring contact',
  recruiterTitle: 'Recruiter title',
  applicantsSummary: 'Applicants',
  resumeName: 'Resume used',
  submittedAt: 'Date submitted',
  followUpDueAt: 'Follow-up due',
  source: 'Source',
  datePosted: 'Date posted',
  companySiteUrl: 'Company page',
  industry: 'Industry'
};
