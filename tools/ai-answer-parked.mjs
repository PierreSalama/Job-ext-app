#!/usr/bin/env node
/*
 * Answer PARKED screening questions with the app's own AI, but only when it is genuinely confident.
 *
 * The executor already asks the AI mid-apply; when it can't answer, the job parks and nothing ever
 * revisits it — which is how a backlog of 200+ parked jobs built up while the AI itself was working
 * fine. This is the missing second pass: it re-asks each parked question with the FULL profile +
 * résumé in context, and saves an answer only when the model reports high confidence AND cites the
 * profile/résumé fact behind it. Saved answers are stored per-profile, so every future posting that
 * asks the same thing is filled automatically without an AI call.
 *
 * Deliberately NOT answered:
 *   - site_gate / CAPTCHA  → needs a human by design; never auto-solved.
 *   - resume               → an attachment problem, not a question.
 *   - anything the model isn't sure of, or that asks for consent//legal agreement → left for Pierre.
 *
 * Usage: node tools/ai-answer-parked.mjs --base http://host:port --token XXX [--min 0.8] [--dry]
 */
const args = process.argv.slice(2);
const arg = (k, d = null) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
// 7744 is the app's real port (config.js server.port); the 7746 this defaulted to was never
// listening anywhere. The scheduled task passes --base explicitly, so the default only ever bit
// somebody running this by hand — with a connection error that looks like "the app is down".
const BASE = arg('base', 'http://127.0.0.1:7744').replace(/\/$/, '');
const TOKEN = arg('token', '');
const MIN = Number(arg('min', '0.8'));
const DRY = args.includes('--dry');

const H = { 'X-JAT-Token': TOKEN, 'Content-Type': 'application/json' };
const api = async (p, opts = {}) => {
  const r = await fetch(BASE + p, { headers: H, ...opts });
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`);
  return r.json();
};

// Questions we must never machine-answer.
const SKIP_TYPES = new Set(['site_gate', 'resume', 'captcha', 'login']);
const CONSENT_RX = /\b(i (have )?(read|agree|consent|acknowledge)|privacy policy|terms|authorize a background|non-?compet|conflict of interest)\b/i;
// Combobox/listbox ARIA help text sometimes gets scraped as if it were the question ("5 results
// available. Use Up and Down to choose options…"). It is screen-reader instructions, not a prompt —
// answering it is meaningless and it would poison the saved-answer store.
const UI_NOISE_RX = /results available|use up and down|press enter to select|press escape|screen ?reader|combobox|listbox/i;

function classify(q) {
  const type = String(q.fieldType || '').toLowerCase();
  if (SKIP_TYPES.has(type)) return 'skip-type';
  const text = String(q.question || '').trim();
  if (!text) return 'skip-empty';
  if (UI_NOISE_RX.test(text)) return 'skip-ui-noise';
  if (CONSENT_RX.test(text)) return 'skip-consent';   // legal/consent is the user's to give, not ours
  return 'ask';
}

const main = async () => {
  const [{ items: profiles }, parked] = await Promise.all([
    api('/profiles'), api('/auto-apply/needs-you'),
  ]);
  const profile = profiles?.[0] || {};
  let resumeText = '';
  try {
    const docs = await api('/documents');
    const resume = (docs.items || []).find((d) => d.role === 'resume');
    if (resume) {
      const full = await api('/documents/' + encodeURIComponent(resume.id));
      resumeText = (full.item || full.document || {}).textContent || '';
    }
  } catch {}

  // de-duplicate: the same question often blocks many postings; answering once unblocks them all
  const seen = new Map();
  for (const job of parked.items || []) {
    for (const q of job.questions || []) {
      const verdict = classify(q);
      const key = String(q.question || '').trim().toLowerCase();
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, { q, verdict, companies: new Set() });
      seen.get(key).companies.add(job.company || '?');
    }
  }

  const asks = [...seen.values()].filter((x) => x.verdict === 'ask');
  const skipped = [...seen.values()].filter((x) => x.verdict !== 'ask');
  console.log(`parked jobs=${(parked.items || []).length} unique questions=${seen.size} answerable=${asks.length} skipped=${skipped.length}`);
  for (const s of skipped) console.log(`  SKIP (${s.verdict}) ${String(s.q.question).slice(0, 70)}`);

  const system = 'You fill job-application screening questions for ONE specific candidate. '
    + 'Answer ONLY from the profile and résumé provided. Never invent experience. '
    + 'If the evidence does not clearly support an answer, set confidence to 0. '
    + 'Match the expected field type: for radio/select answer with one of the given options '
    + '(or exactly "Yes"/"No"); for numbers answer with digits only; keep text answers under 40 words.';

  // `additionalProperties: false` is NOT optional. OpenAI structured outputs reject an object
  // schema without it, so /ai/generate answered HTTP 500 for every question — this job had never
  // produced a single answer in its life: ~23 questions x 500, every 30 minutes, since it was
  // written. Verified on the live laptop 2026-08-24: the identical request with this one line
  // added returns 200 and a correct answer. Every schema in app/src/ai/prompts.js already carries
  // it; this script was the one that did not.
  //
  // The paired trap (see prompts.js): with additionalProperties:false, EVERY declared property
  // must also be listed in `required` — an optional one makes the provider exit non-zero instead.
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      answer: { type: 'string' },
      confidence: { type: 'number' },
      evidence: { type: 'string' },
    },
    required: ['answer', 'confidence', 'evidence'],
  };

  const accepted = [];
  for (const { q, companies } of asks) {
    const prompt = [
      'CANDIDATE PROFILE (JSON):', JSON.stringify(profile.data || profile, null, 1).slice(0, 3000),
      '', 'RÉSUMÉ:', resumeText.slice(0, 5000),
      '', `QUESTION (field type: ${q.fieldType || 'text'}): ${q.question}`,
      q.options?.length ? `OPTIONS: ${JSON.stringify(q.options)}` : '',
      '', 'Answer as JSON with: answer, confidence (0-1), evidence (the profile/résumé fact you used).',
      'confidence must be 0 if the profile and résumé do not support a truthful answer.',
    ].join('\n');

    let out = null;
    try {
      const r = await api('/ai/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt, system, schema, kind: 'json' }),
      });
      out = r.json || (() => { try { return JSON.parse(r.text); } catch { return null; } })();
    } catch (e) { console.log(`  ERR ${String(q.question).slice(0, 55)} → ${e.message}`); continue; }

    const conf = Number(out?.confidence ?? 0);
    const ans = String(out?.answer ?? '').trim();
    const label = `${[...companies].slice(0, 2).join(',')} | ${String(q.question).slice(0, 58)}`;
    if (!ans || conf < MIN) { console.log(`  LOW  (${conf.toFixed(2)}) ${label}`); continue; }
    // LinkedIn ships its Easy Apply options with the form-element URN glued on, so "answer with
    // one of the given options" yields a job-specific identifier. The server refuses these at the
    // write boundary (db.isOpaqueTokenAnswer); refusing here too means the run REPORTS it as junk
    // instead of announcing a save the store then silently drops.
    if (/\burn:[a-z0-9][\w.-]*:/i.test(ans)) {
      console.log(`  JUNK (${conf.toFixed(2)}) ${label}\n         a scraped widget identifier, not an answer: ${JSON.stringify(ans.slice(0, 120))}`);
      continue;
    }
    // Print the answer IN FULL. This line is the only record of what goes into Pierre's permanent
    // answer memory, and it used to truncate at 40 characters — so the one thing a reviewer needs
    // to check was the one thing they could not see. Rejected answers stay short; accepted ones
    // are the ones that matter.
    console.log(`  OK   (${conf.toFixed(2)}) ${label}\n         ANSWER: ${JSON.stringify(ans)}\n         EVIDENCE: ${String(out.evidence).slice(0, 200)}`);
    accepted.push({ question: q.question, value: ans, fieldType: q.fieldType || 'text' });
  }

  if (!accepted.length) { console.log('nothing confident enough to save'); return; }
  if (DRY) { console.log(`DRY RUN — would save ${accepted.length}`); return; }
  const r = await api('/auto-apply/intake', { method: 'POST', body: JSON.stringify({ answers: accepted }) });
  console.log(`SAVED ${r.saved} answer(s); requeued ${r.requeued} job(s)`);
};

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
