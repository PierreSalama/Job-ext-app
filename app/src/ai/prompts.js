// JAT v11 — prompt library.
// Each builder returns { kind, system, prompt, schema?, prose? } consumed by
// provider.run(). Schemas are plain JSON Schema — codex enforces them via
// --output-schema, Ollama via the `format` field, so one definition drives both.
// Templates descend from v9 lib/ai.js (battle-tested) with tightened grounding
// rules; answerQuestion is new (v9 never wrote it).

const SYSTEM_BASE =
  'You are a careful career assistant helping with job applications. ' +
  'Be concise, factual, and warm. Never invent details about the candidate; ' +
  'only use facts provided in the prompt. If information is missing, say so.';

function clip(s, n) { return String(s || '').slice(0, n); }

function jobBlock(job) {
  return [
    `Title: ${clip(job.title, 200)}`,
    `Company: ${clip(job.company, 200)}`,
    job.location ? `Location: ${clip(job.location, 120)}` : '',
    job.compensation ? `Compensation: ${clip(job.compensation, 120)}` : '',
    job.workMode ? `Work mode: ${clip(job.workMode, 60)}` : '',
    job.employmentType ? `Type: ${clip(job.employmentType, 60)}` : '',
    job.description ? `Description:\n${clip(job.description, 6000)}` : '',
  ].filter(Boolean).join('\n');
}

function profileBlock(profile) {
  const d = profile?.data || profile || {};
  const lines = [];
  const add = (label, v) => { if (v) lines.push(`${label}: ${clip(v, 400)}`); };
  add('Name', [d.firstName, d.lastName].filter(Boolean).join(' ') || d.fullName);
  add('Headline', d.headline);
  add('Summary', d.summary);
  add('Location', [d.city, d.region, d.country].filter(Boolean).join(', ') || d.location);
  add('Email', d.email);
  add('Phone', d.phone);
  add('LinkedIn', d.linkedinUrl);
  add('GitHub', d.githubUrl);
  add('Portfolio', d.portfolioUrl);
  add('Years of experience', d.yearsExperience);
  add('Work authorization', d.workAuthorization);
  add('Needs sponsorship', d.sponsorshipRequired);
  add('Salary expectation', d.salaryExpectation);
  add('Notice period', d.noticePeriod);
  add('Education', [d.degree, d.major, d.university, d.gradYear].filter(Boolean).join(', '));
  if (Array.isArray(d.skills) && d.skills.length) add('Skills', d.skills.join(', '));
  return lines.join('\n') || '(profile is empty)';
}

// ---------- fit score ----------
function fitScore({ job, profile, resumeText }) {
  return {
    kind: 'fit-score',
    system: SYSTEM_BASE,
    prompt:
`Score how well this candidate fits this job, 0-100. Be honest: if the profile/resume is sparse or the overlap is weak, score below 50. Identify concrete strengths and gaps grounded ONLY in the provided material.

== JOB ==
${jobBlock(job)}

== CANDIDATE PROFILE ==
${profileBlock(profile)}

== RESUME (extracted text) ==
${clip(resumeText, 6000) || '(no resume on file)'}`,
    schema: {
      type: 'object',
      required: ['score', 'strengths', 'gaps', 'summary'],
      additionalProperties: false,
      properties: {
        score: { type: 'integer', minimum: 0, maximum: 100 },
        strengths: { type: 'array', items: { type: 'string' }, maxItems: 6 },
        gaps: { type: 'array', items: { type: 'string' }, maxItems: 6 },
        summary: { type: 'string' },
      },
    },
  };
}

// ---------- cover letter ----------
function coverLetter({ job, profile, resumeText, tone }) {
  return {
    kind: 'cover-letter',
    prose: true,
    system: SYSTEM_BASE,
    prompt:
`Write a cover letter for this application. Rules:
- 250-350 words, ${tone || 'professional but personable'} tone.
- Open with something specific to THIS job/company picked from the description — never "I am writing to apply".
- No clichés ("team player", "fast-paced environment", "passionate about").
- Ground every claim in the profile/resume below; do not invent experience.
- Close with a short, confident sign-off using the candidate's name.

== JOB ==
${jobBlock(job)}

== CANDIDATE PROFILE ==
${profileBlock(profile)}

== RESUME ==
${clip(resumeText, 6000) || '(no resume on file)'}

Return ONLY the letter text.`,
  };
}

// ---------- resume tailoring ----------
function tailorResume({ job, resumeText, profile }) {
  return {
    kind: 'tailor-resume',
    prose: true,
    system: SYSTEM_BASE,
    prompt:
`Rewrite this resume so it is tailored to the job below. HARD RULES:
- Never invent experience, employers, titles, dates, or credentials.
- Keep every employer, role, and date exactly as in the original.
- You may: reorder bullets for relevance, rephrase bullets to mirror the job's vocabulary, tighten weak wording, move the most relevant experience and skills up.
- Keep roughly the same length. Plain text, no markdown tables.

== JOB ==
${jobBlock(job)}

== ORIGINAL RESUME ==
${clip(resumeText, 12000)}

${profile ? `== PROFILE (context only) ==\n${profileBlock(profile)}` : ''}

Return ONLY the tailored resume text.`,
  };
}

// ---------- application question answering (NEW in v11) ----------
function answerQuestion({ question, fieldType, options, job, profile, qaHistory, resumeText }) {
  const historyBlock = (qaHistory || [])
    .slice(0, 12)
    .map((q) => `Q: ${clip(q.question, 200)}\nA: ${clip(q.answer, 200)}`)
    .join('\n');
  return {
    kind: 'answer-question',
    system: SYSTEM_BASE,
    prompt:
`You are filling out a job application form on behalf of the candidate. Answer ONE question.

HARD RULES:
- Ground the answer ONLY in the candidate profile, resume, and previously-given answers below.
- If the question asks about work authorization, visa, citizenship, demographics (EEO), criminal history, or anything legal: ONLY answer if the profile explicitly contains that field; otherwise refuse.
- If you cannot answer truthfully from the provided data, set refuse=true.
- ${options && options.length ? `The form is a choice field. You MUST pick exactly one of these options verbatim: ${JSON.stringify(options.slice(0, 30))}` : 'Free-text field: keep the answer short and natural (1-3 sentences for open questions, a single value for factual ones).'}
- confidence: 0-1, how certain you are this answer is truthful and appropriate.

ANSWER THESE COMMON QUESTIONS WITH HIGH CONFIDENCE (they are safe to derive from the profile):
- LOCATION / RESIDENCY (yes/no: "are you located in / residing in / based in / a resident of <place>?", "within commuting distance of <place>?"): derive from the candidate's location (city/region/country). E.g. in "Toronto, Ontario" → "residing in BC?" = No, "in Ontario?" = Yes, "in Canada?" = Yes. Confidence ~0.9.
- WHICH-LOCATION (fill-in/choice: "what country/province/state/city are you located in?", "where are you based?"): answer with the candidate's country / region / city from the profile (e.g. country → "Canada", province → "Ontario", city → "Toronto"). Match an option verbatim if options are given. Confidence ~0.9.
- PREFERRED LANGUAGE ("what is your preferred language?", "language of correspondence"): answer "English" unless the profile says otherwise (pick the matching option if given). Confidence ~0.85.
- RELOCATION / REMOTE / ONSITE ("willing to relocate?", "able to work remotely?", "comfortable with hybrid/onsite?"): use a profile preference if present, else default Yes (willing/able), ~0.8 — a candidate applying is presumed open to the job's arrangement.
- YEARS OF EXPERIENCE with a skill/tool ("how many years of X?"): estimate from the resume's work history with that skill; if the skill clearly appears, give a concrete number (round down), ~0.75; only refuse if the resume shows no relevant experience at all. NEVER answer a "how many years" question with a URL or link — it must be a number.
- EDUCATION ("have you completed / do you hold a <Bachelor's/Master's/Diploma/etc.> degree?", "highest level of education?", "minimum education met?"): derive from the resume's education history — if the candidate holds that level OR higher, answer Yes (or pick the matching option); if clearly lower, No; ~0.9.
- For a Yes/No or choice field, the answer MUST be exactly one of the given options.

== QUESTION ==
${clip(question, 500)}
${fieldType ? `(field type: ${fieldType})` : ''}

== JOB CONTEXT ==
${jobBlock(job || {})}

== CANDIDATE PROFILE ==
${profileBlock(profile)}

== RESUME ==
${clip(resumeText, 4000) || '(none)'}

== PREVIOUSLY GIVEN ANSWERS (this candidate, other applications) ==
${historyBlock || '(none)'}`,
    schema: {
      type: 'object',
      required: ['answer', 'confidence', 'refuse', 'reason'],
      additionalProperties: false,
      properties: {
        answer: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        refuse: { type: 'boolean' },
        reason: { type: 'string', description: 'one line: why this answer / why refused' },
      },
    },
  };
}

// ---------- email classification (Gmail sync, stage 2) ----------
function classifyEmail({ subject, from, body }) {
  return {
    kind: 'classify-email',
    system: SYSTEM_BASE,
    prompt:
`Classify this email in the context of a job search. Extract the company and job title if identifiable.

From: ${clip(from, 200)}
Subject: ${clip(subject, 300)}
Body:
${clip(body, 4000)}`,
    schema: {
      type: 'object',
      required: ['category', 'confidence'],
      additionalProperties: false,
      properties: {
        category: {
          enum: ['application_confirmation', 'recruiter_reply', 'interview_request',
                 'assessment_request', 'offer', 'rejection', 'status_update',
                 'newsletter', 'unrelated'],
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        company: { type: 'string' },
        jobTitle: { type: 'string' },
      },
    },
  };
}

// ---------- job summary ----------
function summarizeJob({ job }) {
  return {
    kind: 'summarize-job',
    system: SYSTEM_BASE,
    prompt:
`Summarize this job posting in 3-5 bullet points (what the role actually is, seniority, stack/skills, comp if stated, anything unusual). Then one line: "Red flags: ..." listing any concerning patterns (or "none obvious").

${jobBlock(job)}`,
  };
}

// ---------- follow-up email ----------
function followUp({ job, profile, daysSince }) {
  return {
    kind: 'follow-up',
    prose: true,
    system: SYSTEM_BASE,
    prompt:
`Draft a short follow-up email for this application (submitted ${daysSince ?? 'several'} days ago, no response yet). 4-7 sentences, polite, specific to the role, restates interest, easy to answer. No begging, no clichés.

== JOB ==
${jobBlock(job)}

== CANDIDATE ==
${profileBlock(profile)}

Return ONLY the email body (no subject line).`,
  };
}

// ---------- resume → profile bootstrap ----------
function resumeParse({ resumeText }) {
  return {
    kind: 'resume-parse',
    system: SYSTEM_BASE,
    prompt:
`Extract structured profile data from this résumé. Include ONLY facts present in the text; omit/leave empty anything absent.

Capture EVERY job in workExperience (most recent first) and EVERY school in educationHistory — do not collapse them. Copy dates as written (e.g. "2024", "Jan 2024", "Present"); set current:true for a role with no end date. For each job, put the responsibility/achievement bullets into description (newline-separated). Also fill the flat highestDegree / university / major / graduationYear from the most recent or highest degree, and split the contact location into city / state / country. Capture linkedinUrl / githubUrl / portfolioUrl as full URLs.

${clip(resumeText, 14000)}`,
    schema: {
      type: 'object',
      required: ['firstName', 'lastName', 'email', 'phone', 'headline', 'summary', 'skills', 'workExperience', 'educationHistory'],
      additionalProperties: false,
      properties: {
        firstName: { type: 'string' }, lastName: { type: 'string' },
        email: { type: 'string' }, phone: { type: 'string' },
        city: { type: 'string' }, state: { type: 'string' }, country: { type: 'string' },
        headline: { type: 'string' }, summary: { type: 'string' },
        linkedinUrl: { type: 'string' }, githubUrl: { type: 'string' }, portfolioUrl: { type: 'string' },
        skills: { type: 'array', items: { type: 'string' }, maxItems: 40 },
        yearsExperience: { type: 'string' },
        highestDegree: { type: 'string' }, university: { type: 'string' }, major: { type: 'string' }, graduationYear: { type: 'string' },
        workExperience: {
          type: 'array', maxItems: 20,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              title: { type: 'string' }, company: { type: 'string' }, location: { type: 'string' },
              startDate: { type: 'string' }, endDate: { type: 'string' }, current: { type: 'boolean' },
              description: { type: 'string' },
            },
          },
        },
        educationHistory: {
          type: 'array', maxItems: 10,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              degree: { type: 'string' }, school: { type: 'string' }, field: { type: 'string' },
              startYear: { type: 'string' }, endYear: { type: 'string' }, gpa: { type: 'string' }, details: { type: 'string' },
            },
          },
        },
      },
    },
  };
}

// ---------- capture validation ----------
function validateCapture({ job }) {
  return {
    kind: 'validate-capture',
    system: SYSTEM_BASE,
    prompt:
`This job record was scraped automatically. Check each field for UI garbage (button text, cookie banners, navigation labels) or obviously wrong values. Suggest corrections where the right value is inferable from other fields.

${JSON.stringify({
  title: clip(job.title, 200), company: clip(job.company, 200),
  location: clip(job.location, 200), compensation: clip(job.compensation, 200),
  workMode: clip(job.workMode, 60), employmentType: clip(job.employmentType, 60),
}, null, 2)}`,
    schema: {
      type: 'object',
      required: ['ok', 'problems'],
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        problems: {
          type: 'array',
          items: {
            type: 'object',
            required: ['field', 'issue'],
            additionalProperties: false,
            properties: {
              field: { type: 'string' }, issue: { type: 'string' },
              suggested: { type: 'string' },
            },
          },
        },
      },
    },
  };
}

// applyRescue — the AI "guide" the executor calls when a step BREAKS (no advance control found,
// the page stopped advancing, a required field it couldn't detect/answer). Given the live page
// state + the candidate's profile + learned memory, return the EXACT next UI actions to make the
// application progress truthfully. This is the brain behind the per-step fallback.
function applyRescue({ url, routeState, failureReason, fields, buttons, pageText, job, profile, qaHistory, resumeText }) {
  const fieldBlock = (fields || []).slice(0, 40).map((f, i) =>
    `[${i}] label="${clip(f.label || '', 160)}" type=${f.type || '?'}${f.required ? ' REQUIRED' : ''}${f.value ? ` value="${clip(String(f.value), 40)}"` : ''}${(f.options && f.options.length) ? ` options=${JSON.stringify(f.options.slice(0, 20))}` : ''}`).join('\n') || '(none detected)';
  const buttonBlock = (buttons || []).slice(0, 25).map((b) => `"${clip(String(b), 60)}"`).join(', ') || '(none)';
  const historyBlock = (qaHistory || []).slice(0, 12).map((q) => `Q: ${clip(q.question, 160)}\nA: ${clip(q.answer, 160)}`).join('\n');
  return {
    kind: 'apply-rescue',
    system: SYSTEM_BASE,
    prompt:
`You are driving a job-application form on the candidate's behalf and the automation is STUCK. Decide the next UI actions to progress the application.

HARD RULES (truthfulness + safety — non-negotiable):
- Ground every value ONLY in the candidate profile, resume, and previously-given answers below. NEVER invent employers, dates, degrees, numbers, or claims not supported there.
- Work authorization / visa / citizenship / demographics (EEO) / criminal history / salary: only act if the profile explicitly has it; otherwise return a "park" action for that field.
- NEVER choose a final-submit button ("Submit application", "Submit", "Send application") unless EVERY required field on the page is already satisfied. When unsure, advance ("Next"/"Review"/"Continue") instead, or "park".
- For a choice/radio/select field, the value MUST be exactly one of its listed options.
- "how many years of X" → a NUMBER from the resume (never a URL); estimate conservatively; if no relevant experience, a small number or park.
- If you cannot make safe progress (a required field you can't ground, a login wall, a CAPTCHA), return a single "park" action with a clear reason. Do NOT guess.

ACTION TYPES you may return (in order to perform):
- {type:"fill", target:"<field label>", value:"<text>"}            — type into a text/number/textarea field
- {type:"select", target:"<field label>", value:"<exact option>"}   — choose a dropdown/radio option (verbatim)
- {type:"check", target:"<field label>", value:"yes"|"no"}          — a single checkbox (consent etc.) — only if truthful + safe
- {type:"click", target:"<button label>", value:""}                 — click an advance/open control (NOT final submit unless complete)
- {type:"park", target:"", value:"", reason:"..."}                  — stop + hand to the user (unknown/required/legal/captcha/login)

== WHY WE'RE STUCK ==
${clip(failureReason || 'no progress', 200)}   (route: ${routeState || 'unknown'}, url: ${clip(url || '', 120)})

== DETECTED FIELDS ON THIS PAGE ==
${fieldBlock}

== BUTTONS ON THIS PAGE ==
${buttonBlock}

== VISIBLE PAGE TEXT (snippet) ==
${clip(pageText || '', 1500)}

== JOB CONTEXT ==
${jobBlock(job || {})}

== CANDIDATE PROFILE ==
${profileBlock(profile)}

== RESUME ==
${clip(resumeText, 3500) || '(none)'}

== PREVIOUSLY GIVEN ANSWERS (this candidate, other applications) ==
${historyBlock || '(none)'}`,
    schema: {
      type: 'object',
      required: ['actions', 'assessment', 'confident'],
      additionalProperties: false,
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            // ALL properties required — OpenAI/codex structured output rejects a schema with
            // additionalProperties:false AND an optional property (the cause of the "codex exited 1"
            // rescue failures). `value` is always present; use "" for park/click actions.
            required: ['type', 'target', 'value', 'reason'],
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['fill', 'select', 'check', 'click', 'park'] },
              target: { type: 'string', description: 'the field label or button text to act on ("" for park)' },
              value: { type: 'string', description: 'text to fill / option to select / yes|no for check ("" for click/park)' },
              reason: { type: 'string', description: 'one line: why, grounded in the profile/resume' },
            },
          },
        },
        assessment: { type: 'string', description: 'one line: what this page is + the plan' },
        confident: { type: 'boolean', description: 'true only if the actions truthfully progress the application' },
      },
    },
  };
}

module.exports = {
  SYSTEM_BASE,
  fitScore, coverLetter, tailorResume, answerQuestion, applyRescue,
  classifyEmail, summarizeJob, followUp, resumeParse, validateCapture,
};
