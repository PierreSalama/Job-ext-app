'use strict';
// ============================================================================
//  JAT v11 — escalation tools (AI Apply chunk 7)
//
//  The agent's only honest exit when it meets something it must not do alone, and the place the
//  autonomy toggle finally becomes real.
//
//  PARK THE JOB, NOT THE RUN
//  `ask_human` records a block and tells the agent to MOVE ON to the next application. One
//  unanswered screening question must never stall a night's work — that was the explicit rule from
//  the blueprint, and it is enforced here by what the tool returns.
//
//  THE AUTONOMY TOGGLE IS ONE BRANCH
//  `submit` is the same tool in both modes. In Prepare it does not click: it raises an
//  `awaiting_submit` block and stops, so nothing goes out unreviewed. In Full auto it clicks. That
//  is the entire difference between the two modes, which is why it was never worth building two
//  systems.
//
//  WHAT IS NEVER NEGOTIABLE
//  CAPTCHAs, account creation, passwords and voluntary demographic self-ID have no tool at all.
//  The only thing the agent can do about them is raise a block, and `self_id` does not even do
//  that — it is skipped and logged, because those questions are voluntary and the correct action
//  is to leave them blank.
// ============================================================================

const db = require('../../db');

let log = { info() {}, warn() {}, error() {} };
try { log = require('../../logger').scope('ai:tools:escalate'); } catch { /* usable outside the app */ }

// Kinds the agent may raise. Anything else is a mistake in its reasoning, not a new category.
const KINDS = {
  needs_answer: 'a screening question nobody has answered before',
  captcha: 'a human check the agent must never solve',
  account: 'the site demands an account before applying',
  password: 'a credential is required',
  payment: 'money is involved',
  other: 'something else only a human can do',
};

// A QUESTION ABOUT HIM, OR A QUESTION FOR HIM TO ANSWER?
//
// "Never invent experience" is about FACTS: years with Kubernetes, work authorisation, a degree, a
// notice period. Get one of those wrong and it is a false statement about the candidate.
//
// "Why do you want to work here" is not a fact. It is writing, and the agent has everything needed
// to do it: the posting in front of it, his real résumé, and the overlap check_fit just computed.
// Three end-to-end runs in a row prepared a complete application and then parked on exactly this,
// which would park most real Greenhouse and Ashby forms, since nearly all of them ask some version
// of it. Escalating it is not caution. It is handing back work that was already done.
// A MOTIVATION question is one the agent can write for itself, from the posting and the resume.
// The guard below refuses to escalate one, because escalating PARKS THE APPLICATION.
//
// This was one long single-line regex until 2026-09-05. Three things were wrong with that, all
// found by diffing it against Pierre's own live answer bank (4,543 rows) rather than by reading it:
//
//   1. It was English only, so "Pourquoi voulez-vous travailler ici?" was escalated and parked.
//      Four real French questions in the bank, one of them bilingual, as Quebec postings are.
//   2. Twenty more real questions were missed in ENGLISH: "why Wealthsimple?", "tell us why you
//      would like to work with us", "what motivates you", "describe why ... a strong fit".
//   3. Editing one 400-character line is how a clause gets dropped by accident. The first
//      attempt at the fix above replaced "cover letter" instead of adding beside it, losing ten
//      live questions. Nothing failed. One clause per line so that cannot happen quietly.
//
// Adding a clause is safe in one direction only: it makes the agent WRITE an answer instead of
// parking. So a clause must never match a question asking for a FACT about the candidate. It
// cannot, in practice, because FACT_RX is tested first and wins, but keep clauses narrow anyway.
// Regex LITERALS, not strings. As strings these need doubled backslashes, and the first pass here
// wrote them singly: '\b' is the backspace character, so every word boundary silently vanished and
// node --check was perfectly happy. A literal has no escaping layer to get wrong.
const MOTIVATION_SOURCES = [
  /\bwhy (do|are) you\b/,                                                           // why do/are you
  /\bwhy this\b/,                                                                   // why this
  /\bwhy [a-z][\w.'-]{2,}\s*[?,]/,                                                  // why <Company>?
  /\bwhat (interests|excites|draws|attracts)\b/,                                    // what interests/excites
  /\bwhat (do you know|interests you) about\b/,                                     // what do you know about
  /\bwhat makes you\b/,                                                             // what makes you
  /\bwhat motivates you\b/,                                                         // what motivates you
  /\bwhat is motivating you\b/,                                                     // what is motivating you
  /\btell (us|me) (a bit )?about (yourself|why)\b/,                                 // tell us about yourself
  /\btell (us|me) something about (yourself|you)\b/,                                // tell us something about
  /\btell (us|me) why\b/,                                                           // tell us why
  /\bdescribe (to \w+ )?why\b/,                                                     // describe why
  /\breason for applying\b/,                                                        // reason for applying
  /\breasons? why you\b/,                                                           // reasons why you
  /\bmotivation to (join|apply|work)\b/,                                            // motivation to join/apply
  /\binterested in (joining|working)\b/,                                            // interested in joining
  /\binterest(ed)? in (this|the|our) (role|position|company|team|opportunity)\b/,   // interest in this role
  /\b(strong|great|good) fit for (this|the|our)\b/,                                 // fit for this role
  /\bwould like to work (with|for) (us|our)\b/,                                     // would like to work with us
  /\bcover letter\b/,                                                               // cover letter
  /\bpourquoi (?:voulez|souhaitez|d[\u00e9e]sirez)-vous/,                           // FR pourquoi voulez-vous
  /\bqu['\u2019]est-ce qui vous (?:attire|int[\u00e9e]resse|motive|pla[i\u00ee]t)/, // FR qu'est-ce qui vous
  /\bparlez-nous de vous\b/,                                                        // FR parlez-nous de vous
  /\bpourquoi (ce poste|notre|nous)\b/,                                             // FR pourquoi ce poste
  /\blettre de motivation\b/,                                                       // FR lettre de motivation
];
const MOTIVATION_RX = new RegExp(MOTIVATION_SOURCES.map((r) => r.source).join('|'), 'i');

// A fact hiding inside a motivation-shaped question still has to be escalated.
// STEMS NEED \\w*, OR THE CLOSING \\b KILLS THEM. `\b(authoriz|sponsor|...|graduat)\b` could not match
// "authorization", "sponsorship" or "graduated": the boundary requires a non-word character right
// after the stem. Measured 2026-09-05, this rule answered rather than escalated:
//   "Are you authorized to work in Canada?"        -> false
//   "What is your work authorization status?"      -> false
//   "Do you require sponsorship?"                  -> false
// which is the whole point of the rule inverted. Same defect as HIGH_STAKES_RECALL in db.js,
// found the same day by sweeping every pattern for stems sitting in front of a boundary.
const FACT_RX = /\b(authori[sz]\w*|sponsor\w*|visa\w*|citizen\w*|permanent resident\w*|clearance|salary|compensation|notice period|start date|graduat\w*|degree|gpa|years? of experience|how many years|citoyennet\w*|l[\u00e9e]galement\s+autoris\w*|autoris\w*\s+(?:\w+\s+)?[\u00e0a]\s+travailler|parrainage|permis\s+de\s+travail|r[\u00e9e]sidence\s+permanente|salarial\w*|r[\u00e9e]mun[\u00e9e]ration|niveau\s+d['\u2019]\s*[\u00e9e]tudes|dipl[\u00f4o]me|ann[\u00e9e]es?\s+d['\u2019]\s*exp[\u00e9e]rience)/i;

function makeEscalateTools(opts = {}) {
  const {
    profileId = null,
    // A GETTER, not a value: the tools are built before the loop has created its run row, so
    // resolving this at construction time would attach every block to a null run.
    getRunId = () => null,
    autonomy = 'prepare',
    page = () => null,          // the live CDP page, when a browser toolset is attached
    onBlock = () => {},         // notified so the server can push an alert
    context = () => ({}),       // { company, title, url } the agent is working on
  } = opts;

  const raise = (kind, question, detail) => {
    const c = context() || {};
    const block = db.aiBlockCreate({
      runId: getRunId(), profileId, kind, question, detail,
      company: c.company || null, title: c.title || null, url: c.url || null,
    });
    try { onBlock(block); } catch (e) { log.warn('block notify failed', e.message); }
    log.info(`block ${block.id} (${kind}) raised: ${String(question).slice(0, 80)}`);
    return block;
  };

  // ---------------------------------------------------------------------------
  // Is the form actually finished?
  //
  // On a real run the agent filled name, email and phone, left the salary box and the
  // "why do you want to work here" box empty, and called submit anyway. Prepare mode dutifully
  // parked it, and what Pierre would have opened is a half-completed application with his name on
  // it. Worse than not applying.
  //
  // So submit ASKS THE PAGE before it parks anything. This is not a policy refusal: an empty field
  // is a fact the agent needs, not a rule it broke, so it comes back as an ordinary observation the
  // agent can act on by filling the field or by escalating it with ask_human.
  // ---------------------------------------------------------------------------
  const EMPTY_PROBE = `(() => {
    const out = [];
    const sel = 'input:not([type=hidden]):not([type=file]):not([type=radio]):not([type=checkbox]),textarea,select';
    for (const el of document.querySelectorAll(sel)) {
      if (el.disabled || el.readOnly) continue;
      if (el.type === 'submit' || el.type === 'button' || el.type === 'password') continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;              // genuinely hidden, not the agent's problem
      if (String(el.value || '').trim()) continue;      // already answered
      // A COMMITTED react-select LOOKS EMPTY.
      //
      // Greenhouse's School, Degree and Discipline keep the chosen value in a rendered element and
      // CLEAR the input they searched with. Measured on the real Ritual form: after successfully
      // choosing "Ryerson University" the input read "" and the page showed the choice beside it.
      // Without this, submit would report those three as still empty for ever and refuse to hand
      // over an application that was actually complete.
      const combo = el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete');
      if (combo) {
        // Walk UP, do not guess a wrapper by name. closest() matches the element itself, so a
        // selector list including [class*="select"] returned the input, whose own class is
        // select__input. Narrowing it to [class*="container"] then matched select__input-container,
        // one level below the control that actually holds the value. Four hops finds it whatever
        // the class names are this month.
        let shown = null;
        let box = el.parentElement;
        for (let i = 0; i < 4 && box && !shown; i++, box = box.parentElement) {
          shown = box.querySelector('[class*="singleValue"], [class*="single-value"], [class*="multiValue"], [class*="multi-value"]');
        }
        if (shown && String(shown.textContent || '').trim()) continue;
      }
      // aria-labelledby too, or every react-select reports as "(unlabelled field)" and he is told
      // an application is blocked on something with no name.
      const labelledBy = el.getAttribute('aria-labelledby');
      const byId = labelledBy && labelledBy.split(/\s+/).map((id) => {
        const n = document.getElementById(id);
        return n ? String(n.textContent || '').trim() : '';
      }).filter(Boolean).join(' ');
      const lab = (el.getAttribute('aria-label')
        || (el.labels && el.labels[0] && el.labels[0].textContent)
        || byId
        || el.getAttribute('placeholder') || el.name || el.id || '').trim();
      // Voluntary self-ID is CORRECTLY left blank. Never nag the agent into answering one.
      if (/gender|race|ethnic|veteran|disabilit|pronoun|sexual|orientation/i.test(lab)) continue;
      out.push(lab.slice(0, 70) || '(unlabelled field)');
    }
    return out.slice(0, 8);
  })()`;

  // Company and title are what Pierre reads on the block. On real runs the agent handed over a
  // documents-folder slug as the company, and a job title ("Robotics Engineer") that appears
  // nowhere on the posting. A block naming a role that does not exist is worse than no block: he
  // opens it, cannot match it to anything, and stops trusting the queue. So both are checked
  // against the page before anything is handed over.
  async function notOnPage(company, title) {
    const p = page();
    if (!p) return null;
    let body = '';
    try { body = String(await p.text() || ''); } catch { return null; }
    if (!body) return null;
    const squash = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const hay = squash(body);
    const missing = [];
    if (company && !hay.includes(squash(company))) missing.push(`company "${company}"`);
    // Titles get reworded ("Software Developer, Platform" vs "Software Developer"), so require the
    // words rather than the whole string. Inventing a title fails this. Shortening one does not.
    if (title) {
      // EVERY significant word must be on the page. A majority is not enough: "Robotics Engineer"
      // scored fine against "Northbeam Robotics" on the word "robotics" alone, which is exactly the
      // invented title this check exists to catch.
      const words = squash(title).split(' ').filter((w) => w.length > 3);
      const absent = words.filter((w) => !hay.includes(w));
      if (absent.length) missing.push(`title "${title}" (nothing on the page says ${absent.join(', ')})`);
    }
    return missing.length ? missing.join(' and ') : null;
  }

  // ---------------------------------------------------------------------------
  // Is there a human check on this page?
  //
  // The agent has never been able to SEE a CAPTCHA. `captcha` has had alert copy, a dashboard
  // label and a block kind since the beginning, and nothing has ever raised one, because noticing
  // a CAPTCHA was left to the model reading an accessibility tree that does not contain it. Recon
  // on 2026-09-05 found reCAPTCHA on Ashby and hCaptcha on Lever.
  //
  // THE DISTINCTION THAT MATTERS: most ATS CAPTCHAs today are INVISIBLE. reCAPTCHA v3 and
  // Enterprise score in the background with no widget and nothing for a human to do. Ritual's
  // Greenhouse form is one of those. Blocking on those would park almost every Greenhouse and Ashby
  // application for a human who has nothing to click. Only a challenge with a visible, interactive
  // widget is a reason to stop.
  // ---------------------------------------------------------------------------
  const CAPTCHA_PROBE = `(() => {
    const seen = [];
    const vendorOf = (src) => /recaptcha/i.test(src) ? 'reCAPTCHA'
      : /hcaptcha/i.test(src) ? 'hCaptcha'
      : /turnstile|challenges\.cloudflare/i.test(src) ? 'Cloudflare Turnstile'
      : /arkoselabs|funcaptcha/i.test(src) ? 'Arkose' : null;
    for (const f of document.querySelectorAll('iframe')) {
      const v = vendorOf(f.src || '');
      if (!v) continue;
      const r = f.getBoundingClientRect();
      // THE BADGE IS NOT A CHALLENGE. Measured on the real forms 2026-09-05: Ritual's invisible
      // reCAPTCHA Enterprise renders a 256x60 anchor frame inside .grecaptcha-badge whose parent
      // carries grecaptcha-logo. That is the "protected by reCAPTCHA" branding and there is nothing
      // to click. Lever's hCaptcha renders 749x485 frames under .h-captcha, which is a real one.
      // Size alone marked both as challenges and would have parked every Greenhouse application.
      const parentClass = String((f.parentElement && f.parentElement.className) || '');
      const isBadge = !!f.closest('.grecaptcha-badge') || /grecaptcha-logo/.test(parentClass);
      seen.push({ vendor: v, interactive: !isBadge && r.width > 40 && r.height > 20 });
    }
    for (const el of document.querySelectorAll('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]')) {
      const r = el.getBoundingClientRect();
      if (r.width > 40 && r.height > 20) seen.push({ vendor: 'a human check', interactive: true });
    }
    const vendors = [...new Set(seen.map((x) => x.vendor))];
    return { any: seen.length > 0, interactive: seen.some((x) => x.interactive), vendors };
  })()`;

  async function humanCheck() {
    const p = page();
    if (!p) return null;
    try { return await p.evaluate(CAPTCHA_PROBE); }
    catch (e) { log.warn(`captcha probe failed: ${e.message}`); return null; }
  }

  async function stillEmpty() {
    const p = page();
    if (!p) return [];                                  // no browser attached: nothing to check
    try { return (await p.evaluate(EMPTY_PROBE)) || []; }
    catch (e) { log.warn(`empty-field probe failed: ${e.message}`); return []; }
  }

  const tools = [
    {
      name: 'ask_human',
      // The valid kinds are listed HERE, in the description the model actually reads. Without them
      // it guessed on both end-to-end runs, burned a step on a refusal, and only then corrected —
      // a refusal that teaches after the fact is worse than a description that teaches up front.
      description: 'Escalate something only the human can answer or do. This PARKS the current application. '
        + `say what you need, then move on to a different one. kind must be one of: ${Object.keys(KINDS).join(', ')}.`,
      args: ['kind', 'question', 'detail'],
      guard: ({ kind, question }) => {
        if (!question || String(question).trim().length < 5) return 'refused: say specifically what you need';
        const q = String(question);
        if (MOTIVATION_RX.test(q) && !FACT_RX.test(q)) {
          return 'refused: that is a question you can answer yourself. It asks for motivation, not '
            + 'for a fact about the candidate. Write it from the posting and from what my_resume and '
            + 'check_fit already told you, in his voice, claiming nothing he has not done. Only '
            + 'escalate if it asks for a FACT you have no source for.';
        }
        if (kind && !KINDS[String(kind)]) {
          return `refused: kind must be one of ${Object.keys(KINDS).join(', ')}`;
        }
        return null;
      },
      run: ({ kind, question, detail }) => {
        const b = raise(String(kind || 'needs_answer'), String(question), detail ? String(detail) : null);
        return `PARKED. Block ${b.id} raised for the human (${b.urgency === 'alert' ? 'they are being alerted now' : 'it is queued on their page'}).`
          + ' Do NOT wait and do NOT guess. Move on to a different application, or finish if there is nothing else.';
      },
    },
    {
      name: 'skip_self_id',
      description: 'Record that a voluntary diversity or demographic question was left blank. Use this instead of answering one.',
      args: ['question'],
      run: ({ question }) => {
        log.info(`self-ID left blank: ${String(question || '').slice(0, 80)}`);
        return 'left blank, as it must be. These questions are voluntary and are never answered on the candidate\'s behalf. Carry on with the rest of the form.';
      },
    },
    {
      name: 'submit',
      // "which application is this?" cost a step on a real run. Say what is required, up front.
      // The title is checked against the page, and on 2 of 3 runs on 2026-09-05 the agent passed
      // its own resume headline instead: "Full-Stack Software Engineer" and "Software Engineer"
      // against a posting reading "Software Developer, Platform". Each cost two steps to recover.
      // Saying what the title must be is cheaper than refusing it afterwards.
      description: 'Submit the completed application. REQUIRES the company name and the job title '
        + 'EXACTLY as the POSTING writes them, copied from the page. Not the title on the resume '
        + 'you just wrote, not a shortened or tidied version: both are checked against the page and '
        + 'refused if they do not appear on it. In Prepare mode this does not click, it hands the '
        + 'finished form to the human.',
      args: ['company', 'title'],
      guard: ({ company }) => {
        if (!company) return 'refused: which application is this?';
        // The slug off a documents folder is not the employer's name. It ends up in front of Pierre.
        if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(String(company).trim())) {
          return `refused: "${company}" is a folder slug, not a company name. Use the name as it is`
            + ' written on the posting.';
        }
        return null;
      },
      run: async ({ company, title }) => {
        const wrong = await notOnPage(company, title);
        if (wrong) {
          return `NOT SUBMITTED. The ${wrong} does not appear anywhere on this page. Use page_text `
            + 'and read the employer and the role exactly as the posting writes them, then call '
            + 'submit again. Do not use a folder name or a guess.';
        }
        // A human check the agent must never solve. Checked BEFORE the empty-field sweep, because
        // if a person has to come to this page anyway there is no point listing fields first.
        const check = await humanCheck();
        if (check && check.interactive) {
          return `NOT SUBMITTED. This page has ${check.vendors.join(' and ')} with a visible challenge, `
            + 'which you must never solve or click. Use ask_human with kind "captcha" so a person can '
            + 'tick it and press Submit themselves, then move on to a different application.';
        }

        const blank = await stillEmpty();
        if (blank.length) {
          return `NOT SUBMITTED. ${blank.length} field(s) on this page are still empty: `
            + `${blank.join(' | ')}. Fill each one, using recall_answer or my_profile for anything `
            + 'about the candidate. If a question genuinely has no answer you can source, use '
            + 'ask_human for that one field. Then call submit again.';
        }
        if (autonomy !== 'auto') {
          const b = raise('awaiting_submit',
            `Ready to submit: ${company}${title ? ` — ${title}` : ''}`,
            'Every field is filled and the documents are attached. Review it and press Submit yourself.');
          return `NOT SUBMITTED — you are in Prepare mode. Block ${b.id} hands it to the human with the form ready.`
            + ' Leave the page exactly as it is and move on.';
        }
        const p = page();
        if (!p) throw new Error('no browser page is attached, so nothing can be submitted');
        // Full auto: find the real submit control and press it.
        await p.readTree();
        // find() returns null when no tree has been read; the readTree above rules that out, but
        // the guard keeps this correct if the ordering above ever changes.
        const hit = (p.find('submit') || [])[0] || (p.find('apply') || [])[0];
        if (!hit) throw new Error('no submit button found on this page — read_page and look again');
        await p.click(hit.ref);
        return `clicked "${hit.name}". Now read the page and CONFIRM it actually submitted before logging anything.`;
      },
    },
  ];

  return { tools, raise, KINDS };
}

module.exports = { makeEscalateTools, KINDS };
