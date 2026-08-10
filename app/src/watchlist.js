// COMPANY WATCHLIST — "tell me the moment Syntronic posts anything."
//
// Why this beats more cold volume. Two months of auto-applying produced exactly two real
// conversations, and both died for reasons that had nothing to do with Pierre: Automated
// DesignWorks was 5-days-on-site in Vaughan (he is Toronto-based and does not drive), and
// Syntronic's Montreal req was cancelled by their Director on 2026-08-10 — the role stopped
// existing. Adam Ortner closed the loop decently and Pierre asked to be kept in mind.
//
// So he now holds something a thousand cold applications cannot manufacture: a named recruiter at
// a company that keeps hiring across Montreal, Ottawa/Kanata and elsewhere. The value is TIMING —
// being early on their next posting, with a name to reference.
//
// Design constraints that matter:
//   • A watch NEVER auto-applies. It raises a flag. Auto-applying to a warm contact's company
//     with a generic application is precisely how you spend the relationship instead of using it.
//   • Matching is on the COMPANY, not the search keywords — a watched company's postings should
//     surface even when the title is outside his usual list, because "anything matching" from a
//     warm contact is a different question from "anything matching" cold.
//   • Generalises: any company where he has a contact is addable, with the contact recorded
//     alongside so the reference is at hand when he writes.

// Company names are messy: "Syntronic", "Syntronic Inc.", "Syntronic R&D Canada", "SYNTRONIC AB".
// Normalise away the corporate furniture so one watch entry catches the family, then match on a
// containment test rather than equality.
// Note the ORDER dependency below: '&' becomes ' and ' before this runs, so "R&D" arrives as
// "r and d" and has to be listed in that form. Listing it as "r&d" silently does nothing.
const SUFFIX_RX = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|ab|nv|bv|plc|sa|pty|group|holdings|technologies|technology|solutions|services|systems|labs|studio|studios|software|consulting|canada|usa|international|global|r and d|and)\b/g;

function normalizeCompany(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[&]/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(SUFFIX_RX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Does this job belong to a watched company? Containment in EITHER direction, because the watch
// term may be shorter than the posting's company ("syntronic" vs "syntronic r&d canada") or longer
// ("automated designworks" vs a posting that says "designworks").
function matchesWatch(jobCompany, watchCompany) {
  const j = normalizeCompany(jobCompany);
  const w = normalizeCompany(watchCompany);
  if (!j || !w) return false;
  if (j === w) return true;
  // Guard against a one-token watch that is too generic to be safe ("group", "labs" already
  // stripped, but e.g. "core"). Require the shorter side to be a whole-word run of the longer.
  const shorter = j.length <= w.length ? j : w;
  const longer = j.length <= w.length ? w : j;
  if (shorter.length < 4) return false;
  return new RegExp(`(^|\\s)${shorter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(longer);
}

// Which watch entries does this job hit? Returns entries, so the caller can surface the CONTACT
// along with the posting — the whole point is that Pierre writes to a person, not a careers page.
function watchesFor(job, entries) {
  const company = (job && (job.company || job.companyName)) || '';
  if (!company) return [];
  return (entries || []).filter((e) => e && e.enabled !== false && matchesWatch(company, e.company));
}

// A newly-discovered job at a watched company. Deliberately NOT a queue entry: it is a
// notification with everything needed to act — the posting, the watch, and the contact.
function alertFor(job, entry) {
  return {
    jobId: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    url: job.jobUrl,
    source: job.source,
    watch: entry.company,
    contact: entry.contact || null,
    note: entry.note || '',
    at: new Date().toISOString(),
  };
}

module.exports = { normalizeCompany, matchesWatch, watchesFor, alertFor };
