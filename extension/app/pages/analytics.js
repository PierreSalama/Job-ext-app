// Analytics — funnel, source breakdown, response time, weekly trend.
// All charts rendered inline as SVG. Period selector + PNG export.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const local = { period: '30d' };

const PERIODS = [['7d', '7d'], ['30d', '30d'], ['90d', '90d'], ['all', 'All-time']];
const FUNNEL = ['submitted', 'received', 'reviewing', 'interview', 'offer'];
const FUNNEL_LABEL = { submitted: 'Applied', received: 'Received', reviewing: 'Reviewing', interview: 'Interview', offer: 'Offer' };

function periodCutoff(p) {
  if (p === 'all') return 0;
  const days = { '7d': 7, '30d': 30, '90d': 90 }[p] || 30;
  return Date.now() - days * 86400000;
}

function within(j, cutoff) {
  if (cutoff === 0) return true;
  const t = new Date(j.submittedAt || j.createdAt || 0).getTime();
  return t >= cutoff;
}

function funnel(jobs) {
  const counts = Object.fromEntries(FUNNEL.map((s) => [s, 0]));
  // A job at status N counts at all stages up to N (the order field gives priority)
  const order = { submitted: 1, received: 2, reviewing: 3, recruiter_replied: 3, interview: 4, assessment: 4, offer: 5, rejected: 0, withdrawn: 0, archived: 0 };
  for (const j of jobs) {
    const lvl = order[j.status] || 0;
    if (j.applied || lvl >= 1) counts.submitted++;
    if (lvl >= 2) counts.received++;
    if (lvl >= 3) counts.reviewing++;
    if (lvl >= 4) counts.interview++;
    if (lvl >= 5) counts.offer++;
  }
  return counts;
}

function svgFunnel(counts) {
  const max = Math.max(1, ...FUNNEL.map((k) => counts[k]));
  const w = 600, rowH = 40, gap = 8;
  const h = FUNNEL.length * (rowH + gap);
  const rows = FUNNEL.map((k, i) => {
    const v = counts[k];
    const bw = Math.max(2, (v / max) * (w - 180));
    const conv = i === 0 ? '' : (counts[FUNNEL[i - 1]] ? Math.round((v / counts[FUNNEL[i - 1]]) * 100) + '%' : '—');
    const y = i * (rowH + gap);
    return `
      <text x="0" y="${y + 24}" fill="var(--text)" font-size="13" font-weight="600">${FUNNEL_LABEL[k]}</text>
      <rect x="100" y="${y + 6}" width="${bw}" height="${rowH - 12}" fill="var(--primary)" rx="4" />
      <text x="${100 + bw + 8}" y="${y + 24}" fill="var(--text)" font-size="13">${v}</text>
      ${conv ? `<text x="${w - 50}" y="${y + 24}" fill="var(--muted)" font-size="11">${conv}</text>` : ''}
    `;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet">${rows}</svg>`;
}

function svgBars(items, label) {
  if (items.length === 0) return `<div class="empty">No data.</div>`;
  const max = Math.max(1, ...items.map((x) => x[1]));
  const w = 500, rowH = 26;
  const h = items.length * rowH + 8;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet">${items.map(([k, v], i) => {
    const y = i * rowH + 4;
    const bw = Math.max(2, (v / max) * (w - 200));
    return `
      <text x="0" y="${y + 16}" fill="var(--text)" font-size="12">${esc(k).slice(0, 24)}</text>
      <rect x="140" y="${y + 4}" width="${bw}" height="${rowH - 10}" fill="var(--primary2)" rx="3" />
      <text x="${140 + bw + 6}" y="${y + 16}" fill="var(--muted)" font-size="11">${v}</text>
    `;
  }).join('')}</svg>`;
}

function svgHistogram(buckets, labels) {
  const max = Math.max(1, ...buckets);
  const w = 500, h = 160, barW = (w - 30) / buckets.length;
  return `<svg viewBox="0 0 ${w} ${h + 24}" width="100%" preserveAspectRatio="xMidYMid meet">${buckets.map((v, i) => {
    const bh = (v / max) * h;
    const x = 20 + i * barW;
    return `
      <rect x="${x + 2}" y="${h - bh + 4}" width="${barW - 4}" height="${bh}" fill="var(--success)" rx="2" />
      <text x="${x + barW / 2}" y="${h + 18}" fill="var(--muted)" font-size="10" text-anchor="middle">${labels[i]}</text>
    `;
  }).join('')}</svg>`;
}

function svgLine(weekly) {
  const w = 500, h = 140;
  if (weekly.length === 0) return `<div class="empty">No data.</div>`;
  const max = Math.max(1, ...weekly.map((p) => p.count));
  const stepX = (w - 30) / Math.max(1, weekly.length - 1);
  const pts = weekly.map((p, i) => `${20 + i * stepX},${h - (p.count / max) * (h - 20)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h + 22}" width="100%" preserveAspectRatio="xMidYMid meet">
    <polyline points="${pts}" fill="none" stroke="var(--primary)" stroke-width="2" />
    ${weekly.map((p, i) => `<circle cx="${20 + i * stepX}" cy="${h - (p.count / max) * (h - 20)}" r="3" fill="var(--primary)" />`).join('')}
    ${weekly.map((p, i) => i % Math.ceil(weekly.length / 6 || 1) === 0 ? `<text x="${20 + i * stepX}" y="${h + 18}" fill="var(--muted)" font-size="9" text-anchor="middle">${p.label}</text>` : '').join('')}
  </svg>`;
}

export function render(state) {
  const cutoff = periodCutoff(local.period);
  const jobs = (state.jobs || []).filter((j) => within(j, cutoff));
  const f = funnel(jobs);

  // Source breakdown
  const bySource = {};
  for (const j of jobs) bySource[j.source || 'Unknown'] = (bySource[j.source || 'Unknown'] || 0) + 1;
  const sourceItems = Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 8);

  // Response time histogram (days from submitted → received/reviewing/interview)
  const responseDays = [];
  for (const j of jobs) {
    if (!j.submittedAt) continue;
    const tl = (j.timeline || []).find((t) => t.type === 'status_changed' && /received|reviewing|interview|recruiter/.test(t.summary || ''));
    if (!tl) continue;
    const d = (new Date(tl.timestamp).getTime() - new Date(j.submittedAt).getTime()) / 86400000;
    if (d >= 0 && d < 60) responseDays.push(Math.floor(d));
  }
  const buckets = [0, 0, 0, 0, 0, 0];
  const labels = ['0-2d', '3-5d', '6-9d', '10-14d', '15-21d', '22+d'];
  for (const d of responseDays) {
    if (d <= 2) buckets[0]++;
    else if (d <= 5) buckets[1]++;
    else if (d <= 9) buckets[2]++;
    else if (d <= 14) buckets[3]++;
    else if (d <= 21) buckets[4]++;
    else buckets[5]++;
  }

  // Weekly trend
  const weeks = 12;
  const weekly = [];
  const now = new Date(); now.setHours(0, 0, 0, 0);
  for (let i = weeks - 1; i >= 0; i--) {
    const start = now.getTime() - (i * 7 + 6) * 86400000;
    const end = now.getTime() - i * 7 * 86400000 + 86400000;
    const count = (state.jobs || []).filter((j) => {
      const t = new Date(j.submittedAt || j.createdAt || 0).getTime();
      return t >= start && t < end;
    }).length;
    const d = new Date(start);
    weekly.push({ count, label: `${d.getMonth() + 1}/${d.getDate()}` });
  }

  return `
    <div class="page-h">
      <div><h1>Analytics</h1><div class="sub">${jobs.length} application${jobs.length === 1 ? '' : 's'} in this period.</div></div>
      <div style="display:flex;gap:6px">
        ${PERIODS.map(([id, label]) => `<button class="btn small${local.period === id ? ' primary' : ''}" data-an-period="${id}">${label}</button>`).join('')}
        <button class="btn small" id="an-export">⤓ Export PNG</button>
      </div>
    </div>

    <div id="an-charts">
      <div class="card">
        <h3 style="margin-top:0;font-size:14px">Funnel</h3>
        ${svgFunnel(f)}
      </div>

      <div class="grid-2" style="margin-top:14px">
        <div class="card">
          <h3 style="margin-top:0;font-size:14px">By source</h3>
          ${svgBars(sourceItems, 'jobs')}
        </div>
        <div class="card">
          <h3 style="margin-top:0;font-size:14px">Response time (days)</h3>
          ${responseDays.length === 0 ? `<div class="empty">No responses recorded yet.</div>` : svgHistogram(buckets, labels)}
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <h3 style="margin-top:0;font-size:14px">Weekly trend (last 12 weeks)</h3>
        ${svgLine(weekly)}
      </div>
    </div>
  `;
}

async function exportPng($container) {
  // Walk SVGs, rasterize each via canvas, then stitch into one tall canvas.
  const svgs = $container.querySelectorAll('svg');
  if (svgs.length === 0) return;
  const items = [];
  for (const s of svgs) {
    const xml = new XMLSerializer().serializeToString(s);
    const blob = new Blob([xml], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
    items.push({ img, w: img.naturalWidth || 600, h: img.naturalHeight || 200, url });
  }
  const W = Math.max(...items.map((it) => it.w)) + 40;
  const H = items.reduce((s, it) => s + it.h + 20, 40);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, W, H);
  let y = 20;
  for (const it of items) {
    ctx.drawImage(it.img, 20, y, it.w, it.h);
    y += it.h + 20;
    URL.revokeObjectURL(it.url);
  }
  const link = document.createElement('a');
  link.download = `analytics-${new Date().toISOString().slice(0, 10)}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

export function attach($main, ctx) {
  $main.querySelectorAll('[data-an-period]').forEach((b) => b.addEventListener('click', () => { local.period = b.dataset.anPeriod; ctx.render(); }));
  $main.querySelector('#an-export')?.addEventListener('click', async () => {
    try { await exportPng($main.querySelector('#an-charts')); ctx.toast('Exported.', 'success'); }
    catch (e) { ctx.toast('Export failed.', 'danger'); }
  });
}
