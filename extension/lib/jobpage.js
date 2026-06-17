// JAT v11 — pure URL predicate: "is this tab a job / application page?"
// Used by Watch & Teach (background.js) to decide whether to supervise the
// CURRENT active tab instead of pulling the next queued job. Kept PURE (no
// chrome/DOM/window) so it imports under `node --test` and is unit-testable.
//
// Two ways a URL qualifies:
//   1. it's on a known board / ATS host (linkedin, indeed, glassdoor, workday,
//      greenhouse, lever, …), OR
//   2. its path/query looks like an apply/job page on ANY host (company career
//      sites, external ATS handoffs) — so "teach me on the job I'm looking at"
//      works off the big boards too.

// Known job boards + common ATS vendors. Matched as a host substring so
// subdomains/regional TLDs (uk.indeed.com, glassdoor.ca, acme.wd5.myworkdayjobs.com)
// all hit.
const JOB_HOST_RX = /(^|\.)(linkedin\.com|indeed\.[a-z.]+|glassdoor\.[a-z.]+|ziprecruiter\.com|monster\.[a-z.]+|dice\.com|wellfound\.com|angel\.co|simplyhired\.[a-z.]+|workday(jobs)?\.com|myworkdayjobs\.com|myworkdaysite\.com|greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com|bamboohr\.com|icims\.com|taleo\.net|jobvite\.com|breezy\.hr|recruitee\.com|teamtailor\.com|jazzhr\.com|paylocity\.com|dayforcehcm\.com|successfactors\.com|brassring\.com|avature\.net|eightfold\.ai|phenom\.com|oraclecloud\.com)/i;

// Path / query shapes that mean "job or application page" on ANY host.
const JOB_PATH_RX = /\/(jobs?|careers?|viewjob|apply|application|applications|postings?|openings?|positions?|vacanc(?:y|ies)|requisitions?|smartapply|easy-?apply|candidate|gh_jid)\b/i;
const JOB_QUERY_RX = /(currentjobid|jobid|job_id|\bjk=|jobkey|gh_jid|ashby_jid|gh_src)/i;

export function isJobPageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname || '';
  if (JOB_HOST_RX.test(host)) return true;
  const path = (u.pathname || '').toLowerCase();
  if (JOB_PATH_RX.test(path)) return true;
  const q = (u.search || '').toLowerCase();
  if (JOB_QUERY_RX.test(q)) return true;
  return false;
}
