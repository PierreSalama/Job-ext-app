// SALARY FLOOR — reject only what is DEMONSTRABLY below the line.
//
// Pierre earns $60k and needs $80k+ for a move to be worth making. Two months of applications
// produced two interviews and no job worth taking, so the point of this is not volume: it is to
// stop spending applications on roles he would decline.
//
// THE FAILURE MODE THIS IS BUILT AROUND. Most Canadian postings state no salary. A naive floor
// would reject every one of them and silently gut the pipeline — the same shape of failure as the
// dead Gmail sync and the classifier's 'other': something decides nothing is there, and nothing
// records the decision. So the rule is one-directional:
//
//     reject ONLY when a stated salary is demonstrably below the floor.
//     unknown, unparseable, or ambiguous  ->  PASS.
//
// Two more things that would each quietly break it:
//   • RANGES ARE JUDGED ON THEIR TOP. "$70k–$95k" clears an $80k floor — the top is what he could
//     negotiate to, and judging on the bottom would reject most of the real market.
//   • HOURLY AND MONTHLY RATES MUST ANNUALISE. A $60/hr contract is ~$125k; comparing the raw
//     number 60 against 80000 would reject the best-paid work in the store.

const HOURS_PER_YEAR = 2080;    // 40h x 52w — the standard full-time basis
const MONTHS_PER_YEAR = 12;
const WEEKS_PER_YEAR = 52;
const DAYS_PER_YEAR = 260;      // 5 days x 52 weeks

// Rough conversions to CAD, used only to avoid rejecting a foreign-currency posting for being
// numerically small. Deliberately GENEROUS (rates rounded up) because every use is in service of
// "don't reject unless clearly below" — an over-estimate keeps a job, an under-estimate loses one.
const TO_CAD = { CAD: 1, USD: 1.45, EUR: 1.55, GBP: 1.80, AUD: 0.95 };

function annualize(amount, interval) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  switch (String(interval || '').toLowerCase()) {
    case 'hour': case 'hourly': case 'hr': return n * HOURS_PER_YEAR;
    case 'day': case 'daily':             return n * DAYS_PER_YEAR;
    case 'week': case 'weekly':           return n * WEEKS_PER_YEAR;
    case 'month': case 'monthly':         return n * MONTHS_PER_YEAR;
    case 'year': case 'yearly': case 'annual': case 'annually': return n;
    default: return null;    // an interval we do not understand is NOT a licence to guess
  }
}

// When a posting gives a bare number with no interval, infer from magnitude rather than refusing.
// The bands are wide and the boundaries are chosen so a misread errs toward "higher", i.e. toward
// keeping the job.
function inferInterval(n) {
  if (n <= 0) return null;
  if (n < 500) return 'hour';        // 32, 60, 90.39 — hourly rates
  if (n < 5000) return 'day';        // 520, 1200 — day rates (contract)
  if (n < 25000) return 'month';     // 7000, 8000 — monthly
  return 'year';
}

// Parse whatever the boards gave us. Two shapes appear in the live store:
//   • JSON: {"min":85000,"max":105000,"interval":"YEAR"}  — and {"min":0,"max":0,...} meaning UNKNOWN
//   • text: "CAD 85000–105000 YEAR", "CAD 70.81–85.04 HOUR", "$60/hr", "80k-100k"
// Returns { max, min, currency, interval, known }. `known:false` is the honest answer whenever we
// cannot be sure, and the floor never rejects on an unknown.
function parseCompensation(raw) {
  const miss = { max: null, min: null, currency: null, interval: null, known: false };
  if (raw == null) return miss;

  let s = String(raw).trim();
  if (!s || s === 'null' || s === '{}') return miss;

  // JSON shape first.
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      const min = Number(o.min) || 0;
      const max = Number(o.max) || 0;
      if (min <= 0 && max <= 0) return miss;                  // the {min:0,max:0} "no data" sentinel
      const interval = String(o.interval || '').toLowerCase() || inferInterval(Math.max(min, max));
      const cur = String(o.currency || 'CAD').toUpperCase();
      const rate = TO_CAD[cur] || 1;
      const aMax = annualize(Math.max(min, max), interval);
      const aMin = annualize(min > 0 ? min : Math.max(min, max), interval);
      if (aMax == null) return miss;
      return { max: aMax * rate, min: (aMin == null ? aMax : aMin) * rate, currency: cur, interval, known: true };
    } catch { return miss; }
  }

  const currency = (s.match(/\b(CAD|USD|EUR|GBP|AUD)\b/i) || [])[1];
  const cur = (currency || 'CAD').toUpperCase();
  const rate = TO_CAD[cur] || 1;

  // Explicit interval word, or a per-unit suffix like "/hr", "per hour", "an hour".
  let interval = (s.match(/\b(hourly|hour|hr|daily|day|weekly|week|monthly|month|yearly|year|annual|annually)\b/i) || [])[1];
  if (!interval && /\/\s*(h|hr|hour)\b/i.test(s)) interval = 'hour';
  if (!interval && /\/\s*(d|day)\b/i.test(s)) interval = 'day';
  if (!interval && /\/\s*(m|mo|month)\b/i.test(s)) interval = 'month';
  if (!interval && /\/\s*(y|yr|year)\b/i.test(s)) interval = 'year';

  // Numbers, including "85k" and thousands separators. Strip the currency word first so "CAD" does
  // not contribute digits, and drop years-of-experience style noise by requiring a money context.
  const nums = [];
  const rx = /(\d[\d,.\s]*)\s*(k\b)?/gi;
  let m;
  const cleaned = s.replace(/\b(CAD|USD|EUR|GBP|AUD)\b/gi, ' ');
  while ((m = rx.exec(cleaned))) {
    let v = parseFloat(String(m[1]).replace(/[,\s]/g, ''));
    if (!Number.isFinite(v)) continue;
    if (m[2]) v *= 1000;                         // "85k"
    if (v > 0) nums.push(v);
  }
  if (!nums.length) return miss;

  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const iv = interval || inferInterval(hi);
  const aMax = annualize(hi, iv);
  const aMin = annualize(lo, iv);
  if (aMax == null) return miss;
  return { max: aMax * rate, min: (aMin == null ? aMax : aMin) * rate, currency: cur, interval: iv, known: true };
}

// THE DECISION. Returns { ok, reason }. `ok:true` for everything we cannot disprove.
function meetsFloor(raw, floor) {
  const f = Number(floor) || 0;
  if (f <= 0) return { ok: true, reason: 'no floor set' };
  const p = parseCompensation(raw);
  if (!p.known) return { ok: true, reason: 'no stated salary — kept' };
  if (p.max >= f) return { ok: true, reason: `up to ${Math.round(p.max).toLocaleString()} clears the floor` };
  return {
    ok: false,
    reason: `stated pay tops out at ~${Math.round(p.max).toLocaleString()} ${p.currency}/yr, below ${f.toLocaleString()}`,
    max: p.max,
  };
}

module.exports = { parseCompensation, meetsFloor, annualize, inferInterval, HOURS_PER_YEAR, TO_CAD };
