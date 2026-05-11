// v8: JD red-flag detector. Pattern-matches well-known burnout/scam signals
// across every active job's description and surfaces them prioritized.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

const FLAGS = [
  { id: 'unlimited_pto', label: 'Unlimited PTO claim', severity: 'med', test: /\bunlimited\s+(pto|vacation|time\s*off)\b/i, note: 'Often correlates with lower take-up than capped PTO.' },
  { id: 'fast_paced', label: 'Fast-paced / hustle language', severity: 'low', test: /\b(fast[- ]paced|hustle|grind|wear\s+many\s+hats|all\s+hands\s+on\s+deck)\b/i, note: 'May signal under-staffing or chaotic workload.' },
  { id: 'family', label: 'We\'re a family', severity: 'med', test: /\b(we['\s]+re|we are)\s+a\s+family\b|like\s+family/i, note: 'Often used to justify long hours or low pay.' },
  { id: 'no_comp', label: 'No compensation range', severity: 'high', test: null, note: 'Required by law in some jurisdictions; absence is a yellow flag.' },
  { id: 'rockstar', label: 'Ninja / rockstar / 10x', severity: 'low', test: /\b(rockstar|ninja|10x|jedi|guru)\b/i, note: 'Buzzword-y. Suggests culture without substance.' },
  { id: 'work_hard_play_hard', label: 'Work hard, play hard', severity: 'low', test: /\bwork\s+hard[, ]+\s*play\s+hard\b/i, note: 'Frequently a marker for late-night culture.' },
  { id: 'salary_commensurate', label: 'Salary commensurate with experience', severity: 'med', test: /\bsalary\s+commensurate\b|\bcompetitive\s+salary\b(?!.{0,30}\$)/i, note: 'Code for "we will offer the lowest you accept".' },
  { id: 'stock_only', label: 'Heavy stock / equity only', severity: 'med', test: /\b(equity[- ]heavy|stock\s+option(s)?\s+package|generous\s+equity)\b/i, note: 'Verify cash component. Equity often valued at 0 in early stage.' },
  { id: 'on_call_24', label: '24/7 on-call', severity: 'high', test: /\b(24[\/x]7|round[- ]the[- ]clock)\b.{0,30}\b(on[- ]call|coverage)\b/i, note: 'Confirm rotation, comp, and headcount.' },
  { id: 'asap', label: 'ASAP / immediate start', severity: 'low', test: /\b(asap|immediate\s+start|start\s+yesterday|need\s+someone\s+now)\b/i, note: 'Reactive hire — ask why the role opened.' },
  { id: 'no_remote_clarity', label: 'Hybrid/remote unclear', severity: 'low', test: /\b(hybrid|remote)\b.{0,40}\bdiscussed/i, note: 'Pin down days-per-week before applying.' },
  { id: 'wear_many_hats', label: 'Wear many hats', severity: 'low', test: /\bwear\s+many\s+hats\b/i, note: 'Code for under-staffing.' },
  { id: 'self_starter', label: '"Self-starter" / minimal supervision', severity: 'low', test: /\bself[- ]starter\b|minimal\s+supervision/i, note: 'Could mean independent or could mean abandoned.' }
];

export function detect(job) {
  const text = `${job.description || ''} ${job.title || ''}`;
  const hits = [];
  for (const f of FLAGS) {
    if (f.id === 'no_comp') {
      if (!/\$\s?\d/.test(job.compensation || '') && !/\$\s?\d/.test(job.description || '')) {
        hits.push({ id: f.id, label: f.label, severity: f.severity, note: f.note });
      }
      continue;
    }
    if (f.test && f.test.test(text)) hits.push({ id: f.id, label: f.label, severity: f.severity, note: f.note });
  }
  return hits;
}

export function render(state) {
  const jobs = (state.jobs || []).filter((j) => !['archived', 'withdrawn'].includes(j.status));
  const rows = jobs.map((j) => ({ job: j, flags: detect(j) })).filter((r) => r.flags.length > 0);
  rows.sort((a, b) => b.flags.length - a.flags.length);

  return `
    <div class="page-h">
      <div><h1>🚩 JD Red Flags</h1>
      <div class="sub">${rows.length} job${rows.length === 1 ? '' : 's'} flagged out of ${jobs.length}</div></div>
    </div>
    ${rows.length === 0 ? `<div class="card empty"><strong>No red flags detected. ✨</strong> Either you have no JDs saved or the descriptions look clean.</div>` :
    `<div class="card"><div class="list">
      ${rows.map(({ job, flags }) => `
        <div class="list-row" style="flex-direction:column;align-items:stretch">
          <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
            <div class="t">${esc(job.title || '')} · <span style="color:var(--muted)">${esc(job.company || '')}</span></div>
            <a class="btn small" href="#/job/${esc(job.id)}">Open →</a>
          </div>
          <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">
            ${flags.map((f) => `<span class="pill" title="${esc(f.note)}" style="background:${sevColor(f.severity)};color:#fff">${esc(f.label)}</span>`).join('')}
          </div>
        </div>
      `).join('')}
    </div></div>`}
  `;
}

function sevColor(s) {
  return s === 'high' ? '#cf222e' : s === 'med' ? '#d29922' : '#6e7781';
}

export function attach() {}
