// AI provider abstraction. Supports three providers:
//   1. Chrome built-in Prompt API (Gemini Nano, ~3B params, on-device, free)
//   2. Ollama local server (gemma4:e4b, gemma2:2b, llama3.2, mistral, etc.)
//   3. OpenAI-compatible HTTP endpoint (OpenAI, Together, Groq, etc.)
//
// All three return text (or stream chunks). The caller passes a prompt and gets
// back a string. Provider auto-detection picks the first available.

import { log } from './logger.js';

// ============ Provider availability detection ============
// Chrome's built-in Prompt API is exposed via window.ai.languageModel (newer)
// or self.ai.languageModel. Detection runs on demand.

// Bounded probe: never let a hung Promise block the whole stack.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout`)), ms))
  ]);
}

export async function detectChromeAI() {
  try {
    // Service workers don't expose window.ai. Skip cleanly so we don't hang.
    const root = (typeof self !== 'undefined' && typeof window === 'undefined') ? self
                 : (typeof window !== 'undefined' ? window : null);
    if (!root) return { available: false, reason: 'No global root' };
    const lm = root?.ai?.languageModel || root?.LanguageModel;
    if (!lm) return { available: false, reason: 'Chrome AI not exposed in this context (service worker has no window.ai)' };
    const caps = await withTimeout(
      lm.capabilities ? lm.capabilities() : Promise.resolve({ available: 'readily' }),
      2000, 'chrome-ai-caps'
    );
    const status = caps.available || caps.status;
    if (status === 'readily' || status === 'available') return { available: true, status: 'ready', model: 'Gemini Nano' };
    if (status === 'after-download' || status === 'downloadable') return { available: false, status: 'download-needed', reason: 'Chrome AI model not downloaded — visit chrome://components' };
    if (status === 'no' || status === 'unavailable') return { available: false, reason: 'Chrome AI not available on this device.' };
    return { available: false, reason: `Unknown status: ${status}` };
  } catch (e) {
    return { available: false, reason: String(e.message || e) };
  }
}

export async function detectOllama(baseUrl = 'http://localhost:11434') {
  try {
    const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (r.status === 403) return { available: false, reason: 'Ollama returned 403 (CORS). The extension auto-rewrites the Origin header — if you still see this, set environment variable OLLAMA_ORIGINS=chrome-extension://* and restart Ollama.' };
    if (!r.ok) return { available: false, reason: `Ollama HTTP ${r.status}` };
    const data = await r.json();
    const models = (data.models || []).map((m) => m.name);
    if (models.length === 0) return { available: false, reason: 'Ollama is running but no models are pulled. Run: ollama pull gemma4:e4b' };
    return { available: true, status: 'ready', models, baseUrl };
  } catch (e) {
    return { available: false, reason: `Ollama not reachable at ${baseUrl} — start the Ollama app. (${e.message || e})` };
  }
}

export async function detectOpenAI(baseUrl, apiKey) {
  if (!apiKey) return { available: false, reason: 'No API key set' };
  if (!baseUrl) baseUrl = 'https://api.openai.com/v1';
  try {
    const r = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return { available: false, reason: `HTTP ${r.status}` };
    return { available: true, status: 'ready', baseUrl };
  } catch (e) {
    return { available: false, reason: String(e.message || e) };
  }
}

// ============ Provider call interfaces ============
async function callChromeAI(prompt, opts = {}) {
  const root = (typeof window !== 'undefined' ? window : self);
  const lm = root?.ai?.languageModel || root?.LanguageModel;
  if (!lm) throw new Error('Chrome AI not available');
  const session = await lm.create({
    systemPrompt: opts.system || 'You are a helpful AI assistant.',
    temperature: opts.temperature ?? 0.7,
    topK: opts.topK ?? 40
  });
  try {
    const result = await session.prompt(prompt);
    return result;
  } finally {
    try { session.destroy?.(); } catch {}
  }
}

async function callOllama(prompt, opts = {}) {
  const baseUrl = opts.baseUrl || 'http://localhost:11434';
  let model = opts.model || 'gemma4:e4b';
  // If chosen model isn't pulled, pick first available (so user gets *something*)
  try {
    const tagsRes = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (tagsRes.ok) {
      const tagsData = await tagsRes.json();
      const names = (tagsData.models || []).map((m) => m.name);
      if (names.length > 0 && !names.some((n) => n === model || n.startsWith(model + ':') || n.startsWith(model.replace(/:.*$/, '')))) {
        // Prefer gemma over others
        model = names.find((n) => n.startsWith('gemma')) || names[0];
      }
    }
  } catch {}
  const body = {
    model,
    prompt,
    system: opts.system || undefined,
    stream: false,
    options: {
      temperature: opts.temperature ?? 0.7,
      num_predict: opts.maxTokens ?? 800
    }
  };
  let r;
  try {
    r = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120000)
    });
  } catch (e) {
    // Network error usually means Ollama isn't running or not reachable
    throw new Error(`Cannot reach Ollama at ${baseUrl} — is the Ollama app running? (${e.message || e})`);
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    if (r.status === 403) {
      throw new Error(`Ollama returned 403 (CORS). The extension auto-rewrites the Origin header — if you still see this, your Ollama version may need OLLAMA_ORIGINS=chrome-extension://* set as an environment variable. Restart Ollama after setting it. Body: ${body.slice(0, 150)}`);
    }
    if (r.status === 404 && /model/i.test(body)) {
      throw new Error(`Ollama model "${model}" not found. Run: ollama pull ${model}`);
    }
    throw new Error(`Ollama ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.response || '';
}

async function callOpenAI(prompt, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://api.openai.com/v1';
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error('No API key');
  const model = opts.model || 'gpt-4o-mini';
  const body = {
    model,
    messages: [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      { role: 'user', content: prompt }
    ],
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 800
  };
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60000)
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text().catch(() => '')}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content || '';
}

// ============ Public API ============
export async function aiStatus(settings) {
  const provider = settings?.aiProvider || 'auto';
  if (provider === 'none') return { provider: 'none', available: false, reason: 'AI disabled in settings' };

  const tryChrome = async () => {
    const r = await detectChromeAI();
    return { provider: 'chrome', ...r };
  };
  const tryOllama = async () => {
    const r = await detectOllama(settings?.ollamaUrl);
    return { provider: 'ollama', ...r, defaultModel: settings?.ollamaModel || 'gemma4:e4b' };
  };
  const tryOpenAI = async () => {
    const r = await detectOpenAI(settings?.openaiBaseUrl, settings?.openaiKey);
    return { provider: 'openai', ...r, defaultModel: settings?.openaiModel || 'gpt-4o-mini' };
  };

  if (provider === 'chrome') return tryChrome();
  if (provider === 'ollama') return tryOllama();
  if (provider === 'openai') return tryOpenAI();

  // Auto: try in order
  const chrome = await tryChrome();
  if (chrome.available) return chrome;
  const ollama = await tryOllama();
  if (ollama.available) return ollama;
  const openai = await tryOpenAI();
  if (openai.available) return openai;
  return { provider: 'none', available: false, reason: 'No AI provider available. Configure in Settings.' };
}

export async function aiPrompt(prompt, settings = {}, opts = {}) {
  // Hard cap so a stuck provider never freezes the UI.
  return withTimeout(_aiPromptInner(prompt, settings, opts), opts.timeoutMs ?? 130000, 'ai-prompt');
}
async function _aiPromptInner(prompt, settings = {}, opts = {}) {
  const status = await withTimeout(aiStatus(settings), 6000, 'ai-status');
  if (!status.available) {
    log.warn('ai', `AI not available — ${status.reason}`, { provider: status.provider });
    throw new Error(status.reason || 'No AI provider available');
  }
  const callOpts = { ...opts, system: opts.system };
  log.info('ai.call', `Calling ${status.provider}`, { promptLen: prompt.length, model: opts.model || status.defaultModel });
  const t0 = Date.now();
  let result;
  try {
    if (status.provider === 'chrome') {
      result = await callChromeAI(prompt, callOpts);
    } else if (status.provider === 'ollama') {
      result = await callOllama(prompt, { ...callOpts, baseUrl: settings.ollamaUrl, model: opts.model || settings.ollamaModel || 'gemma4:e4b' });
    } else if (status.provider === 'openai') {
      result = await callOpenAI(prompt, { ...callOpts, baseUrl: settings.openaiBaseUrl, apiKey: settings.openaiKey, model: opts.model || settings.openaiModel || 'gpt-4o-mini' });
    } else {
      throw new Error('Unknown provider');
    }
    log.info('ai.call', `Response received`, { provider: status.provider, elapsed: Date.now() - t0, responseLen: (result || '').length });
    return (result || '').trim();
  } catch (e) {
    log.error('ai.call', `Call failed: ${e.message || e}`, { provider: status.provider, elapsed: Date.now() - t0 });
    throw e;
  }
}

// ============ Structured response parsing ============
// Parse JSON from LLM output. Models are unreliable about pure JSON, so we
// tolerate code fences, prose intros, etc.
export function parseJsonResponse(text) {
  if (!text) return null;
  // Try to extract a JSON object/array
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }
  // Try to find first {...} or [...]
  const objMatch = text.match(/[\{\[][\s\S]*[\}\]]/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch {}
  }
  // Last resort: try the raw text
  try { return JSON.parse(text); } catch {}
  return null;
}

// Strip everything that isn't part of the requested output (like "Sure, here's…")
export function stripPreamble(text, maxIntroLines = 2) {
  if (!text) return '';
  const lines = text.split('\n');
  const introIndicators = [/^(sure|here|okay|of course|certainly|absolutely)\b/i, /:$/];
  let i = 0;
  while (i < Math.min(lines.length, maxIntroLines)) {
    const trimmed = lines[i].trim();
    if (!trimmed) { i++; continue; }
    if (introIndicators.some((rx) => rx.test(trimmed))) i++;
    else break;
  }
  return lines.slice(i).join('\n').trim();
}

// ============ High-level AI features ============
const SYSTEM_BASE = 'You are a helpful career assistant inside a job-application tracker. Be concise, factual, and warm. Never make up details — only use what is in the provided context.';

export async function aiSummarizeJob(job, settings) {
  const prompt = `Summarize this job posting in 3 short bullet points. Focus on: what the role does, who the company is, and the most distinctive thing about the role.

JOB TITLE: ${job.title || ''}
COMPANY: ${job.company || ''}
LOCATION: ${job.location || ''}
SALARY: ${job.compensation || 'not listed'}
TYPE: ${[job.workMode, job.employmentType, job.seniority].filter(Boolean).join(' · ')}

DESCRIPTION:
${(job.description || '').slice(0, 4000)}

Output ONLY the 3 bullet points, each starting with "- ". No preamble, no closing.`;
  return aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.4, maxTokens: 250 });
}

export async function aiScoreFit(job, profile, settings) {
  const prompt = `Score the fit between this candidate profile and this job. Output ONLY a JSON object with this shape:
{"score": 0-100, "strengths": ["...", "..."], "gaps": ["...", "..."], "summary": "one sentence"}

JOB:
Title: ${job.title || ''}
Company: ${job.company || ''}
Description: ${(job.description || '').slice(0, 3500)}

CANDIDATE PROFILE:
Name: ${profile.fullName || profile.firstName || ''}
Years experience: ${profile.yearsExperience || 'unknown'}
Location: ${[profile.city, profile.country].filter(Boolean).join(', ')}
Work authorization: ${profile.workAuthorization || 'unknown'}
Salary expectation: ${profile.salaryExpectation || 'unknown'}
Summary: ${profile.summary || ''}
LinkedIn: ${profile.linkedinUrl || ''}
GitHub: ${profile.githubUrl || ''}

Be honest. If profile is sparse, set score below 50 and note gaps. JSON only.`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.3, maxTokens: 500 });
  return parseJsonResponse(raw);
}

export async function aiCoverLetter(job, profile, settings) {
  const prompt = `Write a concise, personable cover letter (250-350 words) for this candidate applying to this role. Plain text. No fancy formatting.

CANDIDATE:
Name: ${profile.fullName || profile.firstName || 'the applicant'}
Years experience: ${profile.yearsExperience || ''}
Summary: ${profile.summary || 'experienced professional'}

JOB:
Title: ${job.title}
Company: ${job.company}
Description: ${(job.description || '').slice(0, 3000)}

Avoid clichés ("I am writing to apply..."), buzzwords ("synergy"), and generic praise. Pick one specific thing from the JD and connect it to a strength. Sign off with "${profile.firstName || 'Sincerely'}".`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.65, maxTokens: 600 });
  return stripPreamble(raw);
}

export async function aiExtractSkills(job, settings) {
  const prompt = `Extract the technical skills, tools, and frameworks required for this job. Output ONLY a JSON array of short strings (max 15). No preamble.

JOB DESCRIPTION:
${(job.description || '').slice(0, 4000)}

Example output: ["React", "TypeScript", "Node.js", "PostgreSQL", "AWS", "Git"]`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.2, maxTokens: 250 });
  const parsed = parseJsonResponse(raw);
  return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string').slice(0, 30) : [];
}

export async function aiInterviewQuestions(job, settings) {
  const prompt = `Generate 8 likely interview questions for this role. Mix behavioral (2), technical/role-specific (4), and culture-fit (2). Output ONLY a JSON array of strings.

JOB TITLE: ${job.title}
COMPANY: ${job.company}
DESCRIPTION:
${(job.description || '').slice(0, 3000)}

Example: ["Tell me about a time you...", "How would you design...", "Why this company?"]`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.5, maxTokens: 600 });
  const parsed = parseJsonResponse(raw);
  return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string').slice(0, 12) : [];
}

export async function aiFollowUp(job, profile, settings) {
  const days = job.submittedAt ? Math.floor((Date.now() - new Date(job.submittedAt).getTime()) / 86400000) : 0;
  const prompt = `Write a polite, brief follow-up email (90-150 words) for this applicant. Plain text.

CONTEXT:
- Applicant: ${profile.fullName || profile.firstName || 'the applicant'}
- Role: ${job.title} at ${job.company}
- Applied: ${days} days ago
- Recruiter known: ${job.recruiterName || 'unknown — use "Hi there"'}

Don't apologize for following up. Don't beg. State that you remain interested, briefly reaffirm one fit point, ask if they need anything more. Sign off with "${profile.firstName || 'Best'}".

Output the email body only. No subject line, no preamble.`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.55, maxTokens: 350 });
  return stripPreamble(raw);
}

export async function aiValidateCapture(captured, settings) {
  // Quick sanity check on captured fields. Returns structured warnings.
  const prompt = `Below are fields scraped from a LinkedIn job posting. For each, say whether it looks correct, suspicious, or junk. Output ONLY a JSON object with this shape:
{"warnings": [{"field": "name", "issue": "short reason"}]}

If everything looks fine, return {"warnings": []}.

FIELDS:
- title: ${JSON.stringify(captured.title || '')}
- company: ${JSON.stringify(captured.company || '')}
- location: ${JSON.stringify(captured.location || '')}
- compensation: ${JSON.stringify(captured.compensation || '')}
- workMode: ${JSON.stringify(captured.workMode || '')}
- employmentType: ${JSON.stringify(captured.employmentType || '')}
- recruiterName: ${JSON.stringify(captured.recruiterName || '')}

Common issues: a field containing UI text ("Apply", "Take the next step"), a salary that's actually a description fragment, a location that's "Remote" but should be a city, a company name that's actually a sentence.`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.2, maxTokens: 350 });
  const parsed = parseJsonResponse(raw);
  return parsed && Array.isArray(parsed.warnings) ? parsed.warnings : [];
}

export async function aiSearchQuery(query, jobs, settings) {
  // Convert natural language query into a JSON filter that we apply locally.
  const sample = jobs.slice(0, 5).map((j) => ({
    title: j.title, company: j.company, status: j.status,
    location: j.location, compensation: j.compensation, workMode: j.workMode
  }));
  const prompt = `Convert this natural-language query into a JSON filter object for a job-application tracker. Available filter fields:
- statusIn: array of statuses (started, submitted, received, reviewing, recruiter_replied, interview, assessment, offer, rejected, withdrawn, archived)
- companyContains: substring of company name
- titleContains: substring of title
- locationContains: substring of location
- workModeIn: array of "Remote", "Hybrid", "On-site"
- minSalary: number (rough USD/yr)
- maxSalary: number
- daysAppliedWithin: number of days
- starred: boolean

QUERY: ${JSON.stringify(query)}

Sample of user's jobs (for context): ${JSON.stringify(sample)}

Output ONLY a JSON object. No preamble. Empty {} if you can't parse the query.`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.1, maxTokens: 300 });
  const parsed = parseJsonResponse(raw);
  return (parsed && typeof parsed === 'object') ? parsed : {};
}

export async function aiResumeParse(resumeText, settings) {
  const prompt = `Extract structured fields from this resume. Output ONLY a JSON object with this shape — leave fields empty if not found:
{
  "firstName": "", "lastName": "", "email": "", "phone": "",
  "city": "", "state": "", "country": "",
  "linkedinUrl": "", "githubUrl": "", "portfolioUrl": "",
  "yearsExperience": "", "summary": "",
  "skills": ["..."]
}

RESUME TEXT:
${(resumeText || '').slice(0, 6000)}

Be conservative — only fill fields you're confident about.`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.1, maxTokens: 600 });
  return parseJsonResponse(raw) || {};
}

export async function aiClassifyEmail({ subject, from, body, snippet }, settings) {
  const prompt = `Classify this email about a job application. Output ONLY JSON:
{"classification": "application_confirmation|recruiter_reply|interview_request|assessment_request|offer|rejection|status_update|newsletter|unknown", "confidence": 0-1, "rationale": "one short phrase"}

EMAIL:
From: ${from}
Subject: ${subject}
Snippet: ${snippet}
Body excerpt:
${(body || '').slice(0, 2000)}`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.1, maxTokens: 200 });
  return parseJsonResponse(raw);
}

export async function aiInsightsSummary(jobs, settings) {
  // Compact stats for the model
  const recent = jobs.filter((j) => {
    const t = new Date(j.submittedAt || j.createdAt).getTime();
    return Date.now() - t < 30 * 86400000;
  });
  const counts = {};
  for (const j of recent) counts[j.status] = (counts[j.status] || 0) + 1;
  const prompt = `You are summarizing the user's last 30 days of job applications. Write 2-3 short paragraphs (no headings, no bullet lists), warm but honest. Highlight one positive trend and one thing they could try next.

DATA:
- Total applications last 30 days: ${recent.length}
- All-time total: ${jobs.length}
- Status breakdown: ${JSON.stringify(counts)}
- Companies applied to (sample): ${recent.slice(0, 10).map((j) => j.company).filter(Boolean).join(', ')}

Be direct. No hype. Don't invent statistics.`;
  return aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.5, maxTokens: 400 });
}

export async function aiStatusNudges(jobs, settings) {
  // Scan recent open applications and surface up to 5 actionable nudges.
  const open = jobs.filter((j) => !['rejected', 'withdrawn', 'archived', 'offer'].includes(j.status));
  const compact = open.slice(0, 25).map((j) => {
    const submitted = j.submittedAt ? Math.floor((Date.now() - new Date(j.submittedAt).getTime()) / 86400000) : null;
    const lastTouch = j.updatedAt ? Math.floor((Date.now() - new Date(j.updatedAt).getTime()) / 86400000) : null;
    return {
      id: j.id, title: j.title, company: j.company, status: j.status,
      daysSinceApplied: submitted, daysSinceUpdated: lastTouch,
      hasRecruiter: !!j.recruiterName, hasInterviewDate: !!j.nextInterviewAt,
    };
  });
  const prompt = `You are reviewing a candidate's open job applications. For each application that genuinely needs an action TODAY, output a short nudge. Skip apps that are fine.

Output ONLY JSON:
{"nudges": [{"jobId": "...", "action": "follow_up|prep_interview|send_thank_you|update_status|withdraw|none", "reason": "one short sentence", "priority": "high|medium|low"}]}

RULES:
- "follow_up" only after 7+ days since apply with no reply
- "prep_interview" only when hasInterviewDate
- "send_thank_you" only when status is "interview" and daysSinceUpdated >= 1
- Max 5 nudges, prioritize "high" first
- If nothing needs action, return {"nudges": []}

APPLICATIONS:
${JSON.stringify(compact)}`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.2, maxTokens: 600 });
  const parsed = parseJsonResponse(raw);
  return (parsed && Array.isArray(parsed.nudges)) ? parsed.nudges.slice(0, 5) : [];
}

export async function aiRecommendQueries(jobs, profile, settings) {
  // Build search-query suggestions for LinkedIn/Indeed/Glassdoor based on past applications
  const recent = jobs.slice(-15);
  const titles = [...new Set(recent.map((j) => j.title).filter(Boolean))].slice(0, 8);
  const companies = [...new Set(recent.map((j) => j.company).filter(Boolean))].slice(0, 8);
  const locs = [...new Set(recent.map((j) => j.location).filter(Boolean))].slice(0, 4);
  const prompt = `Based on this candidate's recent applications, suggest 5 specific job-search queries they should run on LinkedIn, Indeed, and Glassdoor to find similar but different roles. Output ONLY JSON:
{"queries": [{"keywords": "...", "location": "...", "rationale": "short reason"}]}

Recent titles: ${JSON.stringify(titles)}
Recent companies: ${JSON.stringify(companies)}
Locations: ${JSON.stringify(locs)}
Candidate summary: ${profile.summary || ''}
Candidate years experience: ${profile.yearsExperience || 'unknown'}

Mix safe choices (similar to what they applied to) with one stretch role.`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.5, maxTokens: 500 });
  const parsed = parseJsonResponse(raw);
  return (parsed && Array.isArray(parsed.queries)) ? parsed.queries.slice(0, 5) : [];
}

export async function aiNegotiateOffer(job, profile, settings) {
  const prompt = `You are advising a candidate who just received an offer. Generate a brief, practical negotiation strategy. Output ONLY JSON:
{
  "anchor": "suggested counter-offer phrasing (1-2 sentences, professional)",
  "talkingPoints": ["...", "..."],
  "watchOuts": ["...", "..."],
  "draftEmail": "ready-to-send email body, 120-180 words"
}

OFFER CONTEXT:
- Role: ${job.title} at ${job.company}
- Listed compensation: ${job.compensation || 'not stated'}
- Location: ${job.location || ''}
- Work mode: ${job.workMode || ''}

CANDIDATE:
- Years experience: ${profile.yearsExperience || 'unknown'}
- Salary expectation: ${profile.salaryExpectation || 'unknown'}
- Location: ${[profile.city, profile.country].filter(Boolean).join(', ')}

Be candid and respectful. If listed comp meets/exceeds expectation, suggest negotiating non-comp items (signing bonus, equity, start date, remote flexibility).`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.4, maxTokens: 700 });
  return parseJsonResponse(raw);
}

// ============ v8 AI features ============
// Tailor a base resume to a specific job description. Returns plain markdown.
export async function aiTailoredResume(job, baseText, profile, settings) {
  const prompt = `Rewrite the resume below to maximize fit for the job description provided. Output ONLY the rewritten resume in plain markdown (use # headings for sections, - for bullets). Do not invent experience or credentials. Reorder sections and rephrase bullets to surface the most relevant achievements first. Keep dates and employers exactly as in the source. Aim for 1–2 pages worth of content.

CANDIDATE PROFILE (for context):
Name: ${profile.fullName || profile.firstName || ''}
Headline: ${profile.headline || ''}
Years experience: ${profile.yearsExperience || 'unknown'}

JOB:
Title: ${job.title || ''}
Company: ${job.company || ''}
Description:
${(job.description || '').slice(0, 4000)}

BASE RESUME:
${(baseText || '').slice(0, 8000)}

Output the tailored resume in markdown. No preamble, no closing remarks.`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.4, maxTokens: 1600 });
  return stripPreamble(raw);
}

// Coach feedback on a practice interview answer.
export async function aiInterviewFeedback(question, answer, settings) {
  const prompt = `You are an interview coach. Give honest, specific feedback on this candidate's practice answer. Output ONLY JSON:
{"strengths": ["...", "..."], "gaps": ["...", "..."], "suggestion": "one concrete sentence on how to improve"}

QUESTION: ${question}

ANSWER:
${(answer || '').slice(0, 3000)}

Be candid but kind. If the answer is empty or off-topic, say so in "gaps".`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.4, maxTokens: 500 });
  return parseJsonResponse(raw) || { strengths: [], gaps: [], suggestion: '' };
}

export async function aiApplicationChecklist(job, profile, settings) {
  // Generate a per-job action checklist tailored to the role + status
  const prompt = `Generate a short, practical checklist (4-7 items) of things this candidate should do for THIS specific application based on its current status. Plain action items, no fluff.

Output ONLY JSON: {"items": [{"label": "...", "rationale": "short why"}]}

JOB: ${job.title} at ${job.company}
STATUS: ${job.status}
DESCRIPTION (excerpt): ${(job.description || '').slice(0, 1500)}

CANDIDATE:
- Years exp: ${profile.yearsExperience || 'unknown'}
- Has resume on file: ${!!profile.resumeFileName}
- Has cover letter on file: ${!!profile.coverLetterFileName}

Tailor to the status: 'started' = research+apply checklist; 'submitted' = waiting+followup checklist; 'interview' = prep checklist; 'offer' = negotiation/decision checklist.`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.4, maxTokens: 500 });
  const parsed = parseJsonResponse(raw);
  return (parsed && Array.isArray(parsed.items)) ? parsed.items.slice(0, 8) : [];
}

// ============ v8.5 QoL AI helpers ============

// Tag a job posting with an industry label. Returns one of a fixed set of
// industries. Falls back to keyword matching when AI is unavailable.
const INDUSTRIES = ['Tech', 'Finance', 'Healthcare', 'Retail', 'Education', 'Manufacturing', 'Consulting', 'Government', 'Nonprofit', 'Media', 'Other'];

export async function aiTagIndustry(description, settings = {}) {
  const text = String(description || '').slice(0, 2500);
  if (!text.trim()) return 'Other';
  // Quick keyword fallback (also used if AI is offline).
  const fallback = () => {
    const t = text.toLowerCase();
    if (/(software|saas|developer|engineer|cloud|aws|kubernetes|api|frontend|backend|devops|ml|ai\b)/i.test(t)) return 'Tech';
    if (/(bank|finance|trading|hedge|investment|fintech|payments|insurance)/i.test(t)) return 'Finance';
    if (/(hospital|nurse|clinic|medical|healthcare|pharma|biotech)/i.test(t)) return 'Healthcare';
    if (/(retail|store|merchandise|ecommerce|shopper)/i.test(t)) return 'Retail';
    if (/(school|university|teacher|education|student)/i.test(t)) return 'Education';
    if (/(factory|manufactur|warehouse|industrial|production)/i.test(t)) return 'Manufacturing';
    if (/(consult|advisor|strategy)/i.test(t)) return 'Consulting';
    if (/(government|federal|public sector|municipal)/i.test(t)) return 'Government';
    if (/(nonprofit|ngo|charity|foundation)/i.test(t)) return 'Nonprofit';
    if (/(media|broadcast|news|journalism|entertainment)/i.test(t)) return 'Media';
    return 'Other';
  };
  try {
    const status = await aiStatus(settings);
    if (!status.available) return fallback();
    const prompt = `Classify the industry of this job posting. Output ONLY ONE word from this list: ${INDUSTRIES.join(', ')}.\n\nDESCRIPTION:\n${text}\n\nOne word answer:`;
    const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.1, maxTokens: 12 });
    const word = String(raw || '').trim().split(/\s+/)[0].replace(/[^A-Za-z]/g, '');
    const match = INDUSTRIES.find((i) => i.toLowerCase() === word.toLowerCase());
    return match || fallback();
  } catch {
    return fallback();
  }
}

// Pick the best resume for a given job from a list of available resumes.
// Returns the chosen resume's name (string) or null if none.
// `resumes` is an array of { id, name, type, originalFilename, ... } shapes.
export async function aiPickResume(job, resumes, settings = {}) {
  const list = (resumes || []).filter((r) => r && (r.name || r.originalFilename));
  if (list.length === 0) return null;
  if (list.length === 1) return list[0].name || list[0].originalFilename;
  // Heuristic fallback: token overlap between job title and resume name.
  const fallback = () => {
    const tokens = String(job?.title || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    let best = list[0], bestScore = -1;
    for (const r of list) {
      const name = String(r.name || r.originalFilename || '').toLowerCase();
      let s = 0;
      for (const t of tokens) if (name.includes(t)) s += 2;
      if (s > bestScore) { bestScore = s; best = r; }
    }
    return best.name || best.originalFilename;
  };
  try {
    const status = await aiStatus(settings);
    if (!status.available) return fallback();
    const choices = list.map((r, i) => `${i + 1}. ${r.name || r.originalFilename}`).join('\n');
    const prompt = `Choose the best-matching resume for this job from the list. Output ONLY the number of the chosen resume (e.g. "2"). No explanation.\n\nJOB TITLE: ${job?.title || ''}\nCOMPANY: ${job?.company || ''}\nDESCRIPTION (excerpt): ${(job?.description || '').slice(0, 1000)}\n\nRESUMES:\n${choices}\n\nNumber only:`;
    const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.1, maxTokens: 8 });
    const m = String(raw || '').match(/\d+/);
    if (m) {
      const idx = parseInt(m[0], 10) - 1;
      if (idx >= 0 && idx < list.length) return list[idx].name || list[idx].originalFilename;
    }
    return fallback();
  } catch {
    return fallback();
  }
}

// Quick company research cache helper. Uses aiPrompt to produce a short
// summary blob {summary, industry, size, perks}. Best-effort.
export async function aiCompanyResearch(companyName, settings = {}) {
  const name = String(companyName || '').trim();
  if (!name) return null;
  try {
    const status = await aiStatus(settings);
    if (!status.available) return null;
    const prompt = `Provide a brief 2-3 sentence research summary of the company "${name}" useful for a job applicant. Mention what they do, their general size if known, and one notable thing about working there. If unsure, say "Limited information available." Output plain text only.`;
    const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.3, maxTokens: 250 });
    return { name, summary: stripPreamble(raw), researchedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}

// ============ AI Lab — raw passthrough ============
// Free-form prompt for the AI Lab page. `opts` may include
// { provider, temperature, maxTokens, system, model }. When `provider` is set
// to a concrete value ('chrome' | 'ollama' | 'openai') the call routes to that
// provider directly instead of letting aiStatus pick. Returns raw text.
export async function aiRawPrompt(prompt, opts = {}, settings = {}) {
  const provider = opts.provider && opts.provider !== 'auto' ? opts.provider : null;
  const callOpts = {
    system: opts.system || 'You are a helpful AI assistant.',
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.7,
    maxTokens: opts.maxTokens || 800,
    model: opts.model
  };
  if (!provider) {
    return aiPrompt(prompt, settings, callOpts);
  }
  const t0 = Date.now();
  try {
    let result;
    if (provider === 'chrome') {
      result = await callChromeAI(prompt, callOpts);
    } else if (provider === 'ollama') {
      result = await callOllama(prompt, { ...callOpts, baseUrl: settings.ollamaUrl, model: opts.model || settings.ollamaModel || 'gemma4:e4b' });
    } else if (provider === 'openai') {
      result = await callOpenAI(prompt, { ...callOpts, baseUrl: settings.openaiBaseUrl, apiKey: settings.openaiKey, model: opts.model || settings.openaiModel || 'gpt-4o-mini' });
    } else {
      throw new Error(`Unknown provider: ${provider}`);
    }
    log.info('ai.raw', `Direct ${provider} call ok`, { elapsed: Date.now() - t0, len: (result || '').length });
    return (result || '').trim();
  } catch (e) {
    log.error('ai.raw', `Direct ${provider} call failed: ${e.message || e}`, { elapsed: Date.now() - t0 });
    throw e;
  }
}

// ============================================================================
// v8 AI features (20 new)
// ============================================================================

// 1. Mock interview — multi-turn. Returns {nextQuestion, feedback?}
export async function aiMockInterview(job, profile, transcript, settings) {
  const tx = Array.isArray(transcript) ? transcript : [];
  const last = tx[tx.length - 1];
  const wantFeedback = last && last.role === 'candidate';
  const compact = tx.slice(-10).map((t) => `${t.role.toUpperCase()}: ${String(t.text || '').slice(0, 600)}`).join('\n');
  const prompt = `You are conducting a job interview for the role below. Output ONLY JSON:
{"nextQuestion": "...", ${wantFeedback ? '"feedback": {"strengths": ["..."], "gaps": ["..."], "suggestion": "..."}' : '"feedback": null'}}

ROLE: ${job?.title || ''} at ${job?.company || ''}
TYPE: ${job?.interviewType || 'behavioral'}
JD EXCERPT: ${(job?.description || '').slice(0, 1500)}
CANDIDATE: ${profile?.fullName || profile?.firstName || 'the candidate'} (${profile?.yearsExperience || '?'} yrs)

TRANSCRIPT SO FAR:
${compact || '(empty — open with a strong first question)'}

${wantFeedback ? "Give brief feedback on the candidate's last answer, then ask the next question (vary topic, escalate when answers are strong)." : 'Ask the next interviewer question. Keep it concise.'}`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.5, maxTokens: 600 });
  return parseJsonResponse(raw) || { nextQuestion: 'Tell me about yourself.', feedback: null };
}

// 2. Resume score
export async function aiResumeScore(resumeText, jobDescription, settings) {
  const prompt = `Score how well this resume matches the job description. Output ONLY JSON:
{"score": 0-100, "strengths": ["..."], "gaps": ["..."], "rewrite_suggestions": ["..."]}

JOB DESCRIPTION:
${(jobDescription || '').slice(0, 3500)}

RESUME:
${(resumeText || '').slice(0, 5000)}

Be specific and honest.`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.3, maxTokens: 700 });
  return parseJsonResponse(raw) || { score: 0, strengths: [], gaps: [], rewrite_suggestions: [] };
}

// 3. Cover letter score
export async function aiCoverLetterScore(coverText, job, settings) {
  const prompt = `Score this cover letter for the role. Output ONLY JSON:
{"score": 0-100, "strengths": ["..."], "gaps": ["..."], "rewrite_suggestions": ["..."]}

ROLE: ${job?.title || ''} at ${job?.company || ''}
JD: ${(job?.description || '').slice(0, 2500)}

COVER LETTER:
${(coverText || '').slice(0, 4000)}

Penalize generic phrasing, missing concrete examples, or weak openers.`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.3, maxTokens: 600 });
  return parseJsonResponse(raw) || { score: 0, strengths: [], gaps: [], rewrite_suggestions: [] };
}

// 4. Red flags in JD
export async function aiRedFlagsInJob(job, settings) {
  const prompt = `Scan this job description for red flags (vague comp, churn, "wear many hats", unpaid OT, ghost-job patterns, AI buzzword salad, sketchy contract terms). Output ONLY JSON:
{"flags": [{"kind": "...", "snippet": "exact quote", "severity": "low|medium|high"}], "summary": "one sentence"}

ROLE: ${job?.title || ''} at ${job?.company || ''}
DESCRIPTION:
${(job?.description || '').slice(0, 4500)}

If clean, return {"flags": [], "summary": "Looks clean."}`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.3, maxTokens: 600 });
  return parseJsonResponse(raw) || { flags: [], summary: '' };
}

// 5. LinkedIn outreach message
export async function aiLinkedInMessage(contact, job, intent, settings) {
  const i = String(intent || 'cold').toLowerCase();
  const prompt = `Draft a personalized LinkedIn message. Plain text, no preamble.

INTENT: ${i}
CONTACT: ${contact?.name || ''} — ${contact?.title || contact?.role || ''} at ${contact?.company || ''}
JOB CONTEXT: ${job?.title || ''} at ${job?.company || ''}
JD EXCERPT: ${(job?.description || '').slice(0, 800)}

Match intent:
- cold: under 300 chars, intro + one specific reason + soft ask
- warm: reference prior connection + concrete ask
- thank_you: warm gratitude + one specific follow-up note
- follow_up: polite check-in, no pressure

No emojis. No "I hope this finds you well".`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.55, maxTokens: 350 });
  return stripPreamble(raw);
}

// 6. Optimal follow-up time
export async function aiOptimalFollowUpTime(jobs, profile, settings) {
  const replies = (jobs || []).filter((j) => j.timeline && j.timeline.length).slice(-30).map((j) => ({
    company: j.company,
    status: j.status,
    timeline: (j.timeline || []).slice(-5).map((t) => ({ ts: t.timestamp, type: t.type }))
  }));
  const prompt = `Based on this user's reply data, suggest the optimal day-of-week and hour to send follow-ups. Output ONLY JSON:
{"dayOfWeek": "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday", "hour": 0-23, "rationale": "one sentence"}

DATA:
${JSON.stringify(replies).slice(0, 3500)}

If data is sparse, default to Tuesday 10:00 with rationale explaining the heuristic.`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.3, maxTokens: 250 });
  return parseJsonResponse(raw) || { dayOfWeek: 'Tuesday', hour: 10, rationale: 'Default — insufficient reply data.' };
}

// 7. Deep company research (extends earlier aiCompanyResearch shape)
export async function aiCompanyResearchDeep(company, settings) {
  const prompt = `Provide a quick research summary for the company below using only your training knowledge (no current web data). If unknown, say so. Output ONLY JSON:
{"tldr": "2-sentence overview", "recent_news_topics": ["..."], "rumored_culture": "1-2 sentences", "hiring_pace_estimate": "slow|steady|fast|unknown", "glassdoor_summary": "1-2 sentences"}

COMPANY: ${String(company || '').slice(0, 200)}`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.4, maxTokens: 600 });
  return parseJsonResponse(raw) || { tldr: '', recent_news_topics: [], rumored_culture: '', hiring_pace_estimate: 'unknown', glassdoor_summary: '' };
}

// 8. STAR format
export async function aiStarFormat(behavioralAnswer, settings) {
  const prompt = `Reformat the candidate's answer below into the STAR framework. Output ONLY JSON:
{"situation": "...", "task": "...", "action": "...", "result": "..."}

ANSWER:
${(behavioralAnswer || '').slice(0, 3000)}

Preserve the candidate's facts. Don't invent details. Keep each section 1-3 sentences.`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.3, maxTokens: 500 });
  return parseJsonResponse(raw) || { situation: '', task: '', action: '', result: '' };
}

// 9. Rejection email analysis
export async function aiAnalyzeRejection(emailBody, settings) {
  const prompt = `Analyze this rejection email. Output ONLY JSON:
{"verdict": "boilerplate|personalized|encouraging|harsh|ambiguous", "hidden_signals": ["..."], "suggested_action": "one sentence"}

EMAIL BODY:
${(emailBody || '').slice(0, 3000)}

"hidden_signals" should call out subtle hints (e.g., "encourages reapplying", "names a specific gap", "hints at headcount freeze").`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.3, maxTokens: 400 });
  return parseJsonResponse(raw) || { verdict: 'ambiguous', hidden_signals: [], suggested_action: '' };
}

// 10. Offer evaluator
export async function aiOfferEvaluator(offer, profile, marketData, settings) {
  const prompt = `Evaluate this job offer comprehensively. Output ONLY JSON:
{"overall": 0-100, "base_score": 0-100, "equity_score": 0-100, "benefits_score": 0-100, "culture_signals": ["..."], "negotiation_priorities": ["..."]}

OFFER: ${JSON.stringify(offer || {}).slice(0, 1500)}
CANDIDATE: ${JSON.stringify({ years: profile?.yearsExperience, expectation: profile?.salaryExpectation, location: profile?.city }).slice(0, 600)}
MARKET: ${JSON.stringify(marketData || {}).slice(0, 800)}

Be honest. Score equity 50 if unknown. Surface 2-4 negotiation priorities ordered by leverage.`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.3, maxTokens: 600 });
  return parseJsonResponse(raw) || { overall: 0, base_score: 0, equity_score: 0, benefits_score: 0, culture_signals: [], negotiation_priorities: [] };
}

// 11. Compare offers
export async function aiCompareOffers(offers, profile, settings) {
  const prompt = `Compare these offers side-by-side and rank them. Output ONLY JSON:
{"ranking": [{"offerId": "...", "score": 0-100, "reasons": ["..."]}], "winner_explanation": "2-3 sentences"}

OFFERS: ${JSON.stringify(offers || []).slice(0, 4000)}
CANDIDATE: ${JSON.stringify({ years: profile?.yearsExperience, expectation: profile?.salaryExpectation, location: profile?.city, willRelocate: profile?.willRelocate }).slice(0, 500)}

Weigh comp, growth, culture, commute, risk. Don't tie unless truly equal.`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.3, maxTokens: 800 });
  return parseJsonResponse(raw) || { ranking: [], winner_explanation: '' };
}

// 12. Thank-you email
export async function aiThankYouEmail(interviewer, job, mainTopics, profile, settings) {
  const topics = Array.isArray(mainTopics) ? mainTopics.join('; ') : String(mainTopics || '');
  const prompt = `Write a thank-you email after an interview. 100-160 words, plain text, no subject line, no preamble.

INTERVIEWER: ${interviewer?.name || 'the team'} (${interviewer?.title || ''})
ROLE: ${job?.title || ''} at ${job?.company || ''}
DISCUSSED: ${topics}
CANDIDATE: ${profile?.firstName || 'the candidate'}

Reference one specific topic, reaffirm enthusiasm, offer to provide anything else. Sign off "${profile?.firstName || 'Best'}".`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.55, maxTokens: 350 });
  return stripPreamble(raw);
}

// 13. Analyze answer history
export async function aiAnalyzeAnswerHistory(answers, settings) {
  const compact = (answers || []).slice(0, 60).map((a) => ({ q: (a.questions?.[0] || a.key || '').slice(0, 100), a: String(a.answer || '').slice(0, 200) }));
  const prompt = `Look at this user's saved Q&A history. Find patterns. Output ONLY JSON:
{"strengths": ["..."], "weaknesses": ["..."], "suggested_practice_topics": ["..."]}

DATA:
${JSON.stringify(compact).slice(0, 5000)}`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.4, maxTokens: 600 });
  return parseJsonResponse(raw) || { strengths: [], weaknesses: [], suggested_practice_topics: [] };
}

// 14. Style consistency across cover letters
export async function aiStyleConsistency(coverLetters, settings) {
  const samples = (coverLetters || []).slice(0, 6).map((c, i) => `--- COVER ${i + 1} ---\n${String(c.body || c.content || c.text || '').slice(0, 1500)}`).join('\n\n');
  const prompt = `Analyze these cover letters for voice consistency. Output ONLY JSON:
{"consistency_score": 0-100, "voice_summary": "one sentence", "drift_notes": ["..."], "suggestions": ["..."]}

${samples}`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.3, maxTokens: 500 });
  return parseJsonResponse(raw) || { consistency_score: 0, voice_summary: '', drift_notes: [], suggestions: [] };
}

// 15. TL;DR a job
export async function aiTLDRJob(job, settings) {
  const prompt = `Summarize this job in exactly 3 lines. Each line under 90 chars. Plain text, no bullets, no preamble.

ROLE: ${job?.title || ''} at ${job?.company || ''}
DESCRIPTION:
${(job?.description || '').slice(0, 3500)}

Line 1: what the role does. Line 2: who they want. Line 3: most distinctive perk or red flag.`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.4, maxTokens: 200 });
  return stripPreamble(raw);
}

// 16. Commute impact
export async function aiCommuteImpact(jobLocation, homeLocation, profile, settings) {
  const prompt = `Qualitatively analyze commute impact. No real-time map data, just reasoning. Output ONLY JSON:
{"estimate": "0-15min|15-30min|30-60min|60-90min|90+min|remote|unclear", "recommendation": "1-2 sentences", "alternatives": ["..."]}

JOB LOCATION: ${String(jobLocation || '')}
HOME: ${String(homeLocation || '')}
CANDIDATE WILL_RELOCATE: ${profile?.willRelocate || 'unknown'}

Consider transit, distance, work-mode hints in the location string ("Remote", "Hybrid").`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.3, maxTokens: 350 });
  return parseJsonResponse(raw) || { estimate: 'unclear', recommendation: '', alternatives: [] };
}

// 17. Work-life balance estimate from JD wording
export async function aiWLBEstimate(job, settings) {
  const prompt = `Estimate work-life balance signals from this job description's wording alone. Output ONLY JSON:
{"score": 0-100, "signals": ["..."], "red_flags": ["..."]}

JD:
${(job?.description || '').slice(0, 4000)}

Penalize "wear many hats", "fast-paced", "bring your A-game", on-call without comp. Reward concrete benefits, async-friendly, generous PTO.`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.3, maxTokens: 400 });
  return parseJsonResponse(raw) || { score: 50, signals: [], red_flags: [] };
}

// 18. Culture fit
export async function aiCultureFit(job, profile, settings) {
  const prompt = `Predict culture fit between this candidate and role. Output ONLY JSON:
{"score": 0-100, "alignments": ["..."], "frictions": ["..."]}

JD:
${(job?.description || '').slice(0, 3000)}

CANDIDATE:
- Summary: ${profile?.summary || ''}
- Headline: ${profile?.headline || ''}
- Years exp: ${profile?.yearsExperience || ''}
- Notes: ${profile?.cultureNotes || ''}

Surface concrete alignments and frictions. Don't be generic.`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.4, maxTokens: 500 });
  return parseJsonResponse(raw) || { score: 0, alignments: [], frictions: [] };
}

// 19. Career path projection
export async function aiCareerPath(jobs, profile, settings) {
  const recent = (jobs || []).slice(-12).map((j) => ({ title: j.title, company: j.company, status: j.status, applied: j.submittedAt }));
  const prompt = `Project this candidate's 1/3/5-year career trajectory based on their history. Output ONLY a JSON array:
[{"horizon": "1y|3y|5y", "milestone": "...", "rationale": "one sentence"}]

CANDIDATE: ${profile?.headline || ''} (${profile?.yearsExperience || '?'} yrs)
SUMMARY: ${(profile?.summary || '').slice(0, 800)}
RECENT APPLICATIONS: ${JSON.stringify(recent).slice(0, 2000)}

Return 5-7 milestones across the three horizons. Be ambitious but realistic.`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.5, maxTokens: 700 });
  const parsed = parseJsonResponse(raw);
  return Array.isArray(parsed) ? parsed.slice(0, 10) : [];
}

// 20. Inline ghost-text completion
export async function aiInlineComplete(promptText, context, settings) {
  const prompt = `Continue the user's draft naturally. Output ONLY the continuation text — no preamble, no quotes, no commentary. Keep it under 60 tokens.

CONTEXT (what they're writing): ${String(context || '').slice(0, 500)}

DRAFT SO FAR:
${String(promptText || '').slice(0, 1500)}

Continuation:`;
  const raw = await aiPrompt(prompt, settings, { system: SYSTEM_BASE, temperature: 0.4, maxTokens: 80 });
  return stripPreamble(raw);
}
