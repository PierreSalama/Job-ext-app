// v8: pure-JS deterministic job-fit scoring. Tokenizes both the JD and the
// user's profile/skills, returns score 0-100 + matched/missing token lists.
// Lives in lib/ so background.js can import it statically (MV3 service workers
// can't reliably do dynamic imports of page modules at chrome-extension://).
const STOP = new Set('a,an,the,and,or,of,to,in,for,on,at,by,with,from,is,are,be,as,this,that,we,our,you,your,will,can,must,should,have,has,had,not,no'.split(','));

export function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9+#.\-\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));
}

export function computeFit(job, profile) {
  const jd = tokens(`${job.description || ''} ${job.title || ''}`);
  const skills = tokens((profile.skills || []).join(' ') + ' ' + (profile.summary || '') + ' ' + (profile.headline || ''));
  if (jd.length === 0) return { score: 0, matched: [], missing: [] };
  const skillSet = new Set(skills);
  const jdSet = new Set(jd);
  const matched = [...skillSet].filter((s) => jdSet.has(s)).slice(0, 30);
  const missingTop = [...jdSet].filter((t) => !skillSet.has(t) && t.length > 3).slice(0, 15);
  const denom = Math.min(20, Math.max(5, [...jdSet].filter((t) => t.length > 3).length / 5));
  const score = Math.min(100, Math.round((matched.length / denom) * 100));
  return { score, matched, missing: missingTop };
}
