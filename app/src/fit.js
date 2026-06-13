// JAT v11 — deterministic fit score (no AI required).
// Port of v9 lib/fit.js: token-overlap between the job text and the
// candidate's skills/resume. Instant, free, honest — the AI deep score
// refines it on demand.

const STOP = new Set(('a an and are as at be by for from has have in is it of on or our the to was '
  + 'we will with you your this that they their than then there what when where who how why '
  + 'job role team work experience years skills required preferred responsibilities qualifications')
  .split(' '));

function tokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9+#.]+/g, ' ')
      .split(' ')
      .filter((t) => t.length >= 2 && !STOP.has(t)),
  );
}

// score(job, profile, resumeText) → { score 0-100, matched[], missing[] }
function score(job, profile, resumeText) {
  const jobText = `${job?.title || ''} ${job?.description || ''}`;
  const jobToks = tokens(jobText);
  if (!jobToks.size) return { score: 0, matched: [], missing: [] };

  const d = profile?.data || profile || {};
  const mine = tokens(`${(d.skills || []).join(' ')} ${d.headline || ''} ${d.summary || ''} ${resumeText || ''}`);
  if (!mine.size) return { score: 0, matched: [], missing: [] };

  // Weight: skill-looking tokens (in the job's requirement-ish vocabulary) count most.
  let hit = 0;
  const matched = [];
  const missing = [];
  for (const t of jobToks) {
    if (mine.has(t)) { hit++; if (matched.length < 30) matched.push(t); }
    else if (missing.length < 30) missing.push(t);
  }
  const raw = hit / Math.min(jobToks.size, 120);
  return {
    score: Math.max(0, Math.min(100, Math.round(raw * 130))),
    matched,
    missing,
  };
}

module.exports = { score, tokens };
