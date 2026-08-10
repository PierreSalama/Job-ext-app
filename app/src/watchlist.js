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

// ---- board poller ------------------------------------------------------------------------------
//
// A watchlist that can only react to what broad discovery already surfaced is a label, not a
// mechanism — the whole thesis was "be early at a small number of well-chosen employers".
//
// SCOPE, set by measurement rather than ambition. Probing all 27 watched companies against the
// public ATS JSON APIs on 2026-08-10 found exactly TWO reachable: Syntronic (lever/syntronic) and
// Kepler (lever/kepler). The other 25 run Workday, SuccessFactors, or bespoke career pages and
// expose no public board. That is not a gap in the probe — it is what those employers are, and it
// is also why broad discovery never found them either.
//
// So this polls two companies. Deliberately NOTIFY-ONLY: at this population size speed buys
// nothing and a tailored application buys a lot, especially at a company where Pierre already has
// a named recruiter. Nothing here queues an application.
//
// Rate discipline: 11 days after an account restriction caused by discovery volume, a new poller
// must not become the next thing that gets throttled. Two requests per cycle, twice a day, jittered.
const BOARD_URLS = {
  greenhouse: (t) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs?content=false`,
  lever: (t) => `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`,
  ashby: (t) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}`,
};

// Titles worth telling him about, and places he can actually take. Both deliberately generous:
// this is a notification, and the cost of one extra line in a twice-daily digest is nothing next
// to missing the role at the one company where he has a warm contact.
const FIT_TITLE_RX = /(developer|développeur|engineer|ingénieur|programmer|programmeur|software|logiciel|analyst|analyste|application|systems?|automation|full.?stack|back.?end|front.?end|web|concepteur)/i;
const FIT_GEO_RX = /(canada|ontario|toronto|quebec|québec|montr[eé]al|ottawa|kanata|waterloo|remote|télétravail|mississauga|oakville)/i;

function boardPostings(ats, data) {
  if (ats === 'lever') return Array.isArray(data) ? data : [];
  return Array.isArray(data?.jobs) ? data.jobs : [];
}
function postingTitle(ats, j) { return String((ats === 'lever' ? j.text : j.title) || '').trim(); }
function postingLocation(ats, j) {
  if (ats === 'lever') return String(j.categories?.location || '');
  if (ats === 'greenhouse') return String(j.location?.name || '');
  return String(j.location || j.locationName || '');
}
function postingUrl(ats, j) { return String(j.hostedUrl || j.absolute_url || j.jobUrl || j.applyUrl || ''); }
function postingId(ats, j) { return String(j.id || j.jobId || postingUrl(ats, j) || postingTitle(ats, j)); }

function fitsPierre(ats, j) {
  const loc = postingLocation(ats, j);
  return FIT_TITLE_RX.test(postingTitle(ats, j)) && (!loc || FIT_GEO_RX.test(loc));
}

// Poll the entries that carry a `board`. `seen` is a Set of already-alerted posting keys, passed in
// by the caller so this stays testable and the dedupe survives restarts (it is kv-backed).
async function pollBoards({ entries, seen = new Set(), fetchFn = fetch, now = () => new Date() } = {}) {
  const alerts = [];
  const errors = [];
  for (const entry of entries || []) {
    if (!entry || entry.enabled === false || !entry.board || !entry.board.ats || !entry.board.token) continue;
    const { ats, token } = entry.board;
    const makeUrl = BOARD_URLS[String(ats).toLowerCase()];
    if (!makeUrl) { errors.push(`${entry.company}: unknown ats "${ats}"`); continue; }
    try {
      const res = await fetchFn(makeUrl(token));
      if (!res || !res.ok) { errors.push(`${entry.company}: HTTP ${res ? res.status : '?'}`); continue; }
      const data = await res.json();
      for (const j of boardPostings(ats, data)) {
        if (!fitsPierre(ats, j)) continue;
        const key = `${entry.company}|${postingId(ats, j)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        alerts.push({
          key,
          company: entry.company,
          title: postingTitle(ats, j),
          location: postingLocation(ats, j),
          url: postingUrl(ats, j),
          source: `${ats}:${token}`,
          contact: entry.contact || null,
          note: entry.note || '',
          at: now().toISOString(),
        });
      }
    } catch (e) { errors.push(`${entry.company}: ${String(e && e.message || e).slice(0, 120)}`); }
  }
  return { alerts, errors, polled: (entries || []).filter((e) => e && e.board && e.enabled !== false).length };
}

module.exports = {
  normalizeCompany, matchesWatch, watchesFor, alertFor,
  pollBoards, fitsPierre, postingTitle, postingLocation, BOARD_URLS,
};
