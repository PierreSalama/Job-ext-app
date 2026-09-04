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
const MOTIVATION_RX = /\b(why (do|are) you|why this|what (interests|excites|draws|attracts)|tell us (a bit )?about (yourself|why)|what (do you know|interests you) about|reason for applying|what makes you|interested in (joining|working)|cover letter)\b/i;

// A fact hiding inside a motivation-shaped question still has to be escalated.
const FACT_RX = /\b(authoriz|sponsor|visa|citizen|permanent resident|clearance|salary|compensation|notice period|start date|graduat|degree|gpa|years? of experience|how many years)\b/i;

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
      description: 'Submit the completed application. REQUIRES the company name and the job title, which '
        + 'you already read off the posting. In Prepare mode this does not click, it hands the '
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
        const hit = p.find('submit')[0] || p.find('apply')[0];
        if (!hit) throw new Error('no submit button found on this page — read_page and look again');
        await p.click(hit.ref);
        return `clicked "${hit.name}". Now read the page and CONFIRM it actually submitted before logging anything.`;
      },
    },
  ];

  return { tools, raise, KINDS };
}

module.exports = { makeEscalateTools, KINDS };
