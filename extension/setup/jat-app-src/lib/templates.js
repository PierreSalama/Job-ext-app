// Email templates per status. Pure functions — input is a job + profile,
// output is { subject, body } you can copy/paste.
//
// Variables substituted: {title} {company} {recruiterFirst} {firstName}
// {applyDate} {daysSinceApply}

function firstNameOf(full) {
  return String(full || '').trim().split(/\s+/)[0] || '';
}

function daysSince(iso) {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function fillVars(text, ctx) {
  return text
    .replace(/\{title\}/g, ctx.title || 'the role')
    .replace(/\{company\}/g, ctx.company || 'your company')
    .replace(/\{recruiterFirst\}/g, ctx.recruiterFirst || 'there')
    .replace(/\{firstName\}/g, ctx.firstName || '')
    .replace(/\{fullName\}/g, ctx.fullName || ctx.firstName || '')
    .replace(/\{applyDate\}/g, ctx.applyDate || '')
    .replace(/\{daysSinceApply\}/g, String(ctx.daysSinceApply || 0));
}

const TEMPLATES = {
  follow_up_after_apply: {
    label: 'Polite follow-up — no response',
    subject: 'Following up on my application for {title}',
    body: `Hi {recruiterFirst},

I wanted to follow up on my application for the {title} position at {company}, submitted {daysSinceApply} days ago.

I remain very interested in the role and would be happy to provide any additional materials or context that would help. Please let me know if there's anything else you need from me.

Thanks for your time,
{firstName}`
  },
  thank_you_post_interview: {
    label: 'Thank-you note — after interview',
    subject: 'Thank you — {title} at {company}',
    body: `Hi {recruiterFirst},

Thank you for taking the time to speak with me today about the {title} role at {company}. I really enjoyed our conversation and learning more about the team's work.

Our discussion reinforced my interest in the role and the company. I'm confident I can contribute meaningfully and I'm excited about the opportunity to do so.

Please let me know if there's anything further I can provide.

Best,
{firstName}`
  },
  schedule_interview: {
    label: 'Schedule confirmation / availability',
    subject: 'Re: Interview availability — {title}',
    body: `Hi {recruiterFirst},

Thank you for considering me for the {title} role at {company}. I'm available for an interview at any of the following times (please let me know which works best):

• [Day, time, timezone]
• [Day, time, timezone]
• [Day, time, timezone]

Looking forward to it.

Best,
{firstName}`
  },
  withdraw_politely: {
    label: 'Withdraw application',
    subject: 'Withdrawing my application — {title}',
    body: `Hi {recruiterFirst},

I wanted to let you know that I'd like to withdraw my application for the {title} position at {company}. After reflection, I've decided to focus my search elsewhere.

Thank you for your time and consideration. I have a lot of respect for {company} and hope our paths cross again.

Best,
{firstName}`
  },
  ask_for_update: {
    label: 'Status check — long silence',
    subject: 'Quick check-in — {title} application',
    body: `Hi {recruiterFirst},

I hope you're doing well. I'm reaching out to see if there's any update on my application for the {title} role. I applied {daysSinceApply} days ago and I'm still very interested.

If the role has moved forward without me, totally understandable — I'd just appreciate knowing where things stand so I can plan accordingly.

Thanks,
{firstName}`
  },
  decline_offer_politely: {
    label: 'Decline offer politely',
    subject: 'Re: Offer for {title}',
    body: `Hi {recruiterFirst},

Thank you very much for the offer for the {title} role at {company}. After careful consideration, I've decided to pursue another opportunity that's a closer fit for what I'm looking for right now.

I genuinely appreciate the time you and the team invested. {company} is a great place and I have a lot of respect for the work you're doing.

Wishing you and the team the best.

Best,
{firstName}`
  },
  accept_offer: {
    label: 'Accept offer',
    subject: 'Re: Offer for {title} — accepting',
    body: `Hi {recruiterFirst},

I'm thrilled to formally accept the offer for the {title} position at {company}.

Thank you for your patience throughout the process. I'm excited to join the team and get started.

Please let me know what you need from me to move forward.

Best,
{firstName}`
  }
};

export function listTemplates() {
  return Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label }));
}

export function renderTemplate(id, job, profile) {
  const t = TEMPLATES[id];
  if (!t) return null;
  const ctx = {
    title: job.title || 'the role',
    company: job.company || 'your company',
    recruiterFirst: firstNameOf(job.recruiterName) || 'there',
    firstName: profile.firstName || firstNameOf(profile.fullName) || '',
    fullName: profile.fullName || [profile.firstName, profile.lastName].filter(Boolean).join(' '),
    applyDate: job.submittedAt ? new Date(job.submittedAt).toLocaleDateString() : '',
    daysSinceApply: daysSince(job.submittedAt)
  };
  return {
    subject: fillVars(t.subject, ctx),
    body: fillVars(t.body, ctx)
  };
}

// Suggest the most relevant templates for a job based on its status
export function suggestTemplates(job) {
  const s = job.status;
  if (s === 'started' || s === 'submitted') return ['follow_up_after_apply', 'ask_for_update', 'withdraw_politely'];
  if (s === 'received' || s === 'reviewing') return ['ask_for_update', 'follow_up_after_apply'];
  if (s === 'recruiter_replied') return ['schedule_interview', 'thank_you_post_interview'];
  if (s === 'interview' || s === 'assessment') return ['thank_you_post_interview', 'schedule_interview', 'ask_for_update'];
  if (s === 'offer') return ['accept_offer', 'decline_offer_politely'];
  if (s === 'rejected' || s === 'withdrawn') return ['follow_up_after_apply'];
  return ['follow_up_after_apply', 'thank_you_post_interview'];
}
