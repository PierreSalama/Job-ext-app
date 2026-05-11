// Live AI mock interview studio. Pick a job + interview type, run a chat-style
// session. Each candidate turn → AI returns next question + inline feedback.
// Transcripts persist to the mockInterviews IDB store.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const local = {
  jobId: '',
  interviewType: 'behavioral',
  sessionId: null,
  transcript: [], // [{role: 'interviewer'|'candidate', text}]
  pendingFeedback: null,
  loading: false,
  draft: ''
};

function activeSession(state) {
  if (!local.sessionId) return null;
  return (state.mockInterviews || []).find((s) => s.id === local.sessionId);
}

export function render(state) {
  const jobs = state.jobs || [];
  const sessions = (state.mockInterviews || []).slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const job = jobs.find((j) => j.id === local.jobId);

  return `
    <div class="page-h">
      <div><h1>Mock Interview</h1><div class="sub">Practice live with an AI interviewer. Each answer gets inline feedback.</div></div>
    </div>
    <div style="display:grid;grid-template-columns:280px 1fr;gap:14px">
      <div class="card" style="padding:12px">
        <div style="font-weight:600;margin-bottom:8px">Setup</div>
        <label style="font-size:12px;color:var(--muted)">Job</label>
        <select id="mi-job" style="width:100%;padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;margin-bottom:8px">
          <option value="">— Select —</option>
          ${jobs.map((j) => `<option value="${esc(j.id)}"${local.jobId === j.id ? ' selected' : ''}>${esc(j.title)} · ${esc(j.company)}</option>`).join('')}
        </select>
        <label style="font-size:12px;color:var(--muted)">Type</label>
        <select id="mi-type" style="width:100%;padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;margin-bottom:10px">
          ${['behavioral','technical','case'].map((t) => `<option value="${t}"${local.interviewType === t ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <button class="btn primary" id="mi-start" style="width:100%" ${!local.jobId || local.loading ? 'disabled' : ''}>${local.loading ? 'Starting…' : '▶ Start session'}</button>
        <div style="margin-top:14px;font-weight:600;font-size:12px;color:var(--muted)">Past sessions</div>
        <div style="display:flex;flex-direction:column;gap:4px;margin-top:6px;max-height:340px;overflow:auto">
          ${sessions.length === 0 ? `<div style="font-size:12px;color:var(--muted)">None yet.</div>` :
            sessions.map((s) => `
              <div style="padding:6px;border:1px solid var(--border);border-radius:6px;font-size:12px;cursor:pointer;${local.sessionId === s.id ? 'border-color:var(--primary)' : ''}" data-mi-load="${esc(s.id)}">
                <div style="font-weight:600">${esc(s.jobTitle || 'Untitled')}</div>
                <div style="color:var(--muted)">${esc((s.interviewType || '') + ' · ' + new Date(s.createdAt).toLocaleDateString())}</div>
              </div>`).join('')}
        </div>
      </div>
      <div class="card" style="padding:14px;display:flex;flex-direction:column;min-height:520px">
        <div style="font-weight:600;margin-bottom:8px">${job ? esc(job.title + ' · ' + job.company) : 'Pick a job to begin'}</div>
        <div id="mi-stream" style="flex:1;overflow:auto;padding:6px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
          ${local.transcript.length === 0 ? `<div style="color:var(--muted);padding:14px;text-align:center">Click Start session to begin.</div>` :
            local.transcript.map((t, i) => renderBubble(t, local.transcript[i + 1] === undefined ? local.pendingFeedback : null)).join('')}
          ${local.loading ? `<div style="padding:8px;color:var(--muted);font-size:12px">Interviewer is thinking…</div>` : ''}
        </div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <textarea id="mi-input" placeholder="Type your answer…" style="flex:1;padding:8px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;min-height:60px;resize:vertical;font-size:13px" ${!local.sessionId || local.loading ? 'disabled' : ''}>${esc(local.draft)}</textarea>
          <div style="display:flex;flex-direction:column;gap:4px">
            <button class="btn primary" id="mi-send" ${!local.sessionId || local.loading ? 'disabled' : ''}>Send</button>
            <button class="btn small" id="mi-end" ${!local.sessionId ? 'disabled' : ''}>End</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderBubble(turn, feedback) {
  const isAi = turn.role === 'interviewer';
  return `
    <div style="margin-bottom:10px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:2px">${isAi ? 'Interviewer' : 'You'}</div>
      <div style="padding:8px 10px;border-radius:8px;background:${isAi ? 'rgba(99,102,241,0.10)' : 'var(--panel)'};border:1px solid var(--border);white-space:pre-wrap">${esc(turn.text)}</div>
      ${feedback ? `
        <div style="margin-top:6px;padding:8px;border-radius:8px;background:var(--bg);border:1px dashed var(--border);font-size:12px">
          ${feedback.strengths?.length ? `<div><strong style="color:var(--success)">Strengths:</strong> ${feedback.strengths.map(esc).join('; ')}</div>` : ''}
          ${feedback.gaps?.length ? `<div><strong style="color:var(--warn)">Gaps:</strong> ${feedback.gaps.map(esc).join('; ')}</div>` : ''}
          ${feedback.suggestion ? `<div><strong style="color:var(--primary)">Try:</strong> ${esc(feedback.suggestion)}</div>` : ''}
        </div>` : ''}
    </div>
  `;
}

async function callAi(ctx, job, profile) {
  local.loading = true; ctx.render();
  const r = await ctx.aiCall({ feature: 'mockInterview', job: { ...job, interviewType: local.interviewType }, profile, transcript: local.transcript });
  local.loading = false;
  if (!r?.ok) { ctx.toast('AI failed: ' + (r?.error || ''), 'danger'); ctx.render(); return; }
  const out = r.result || {};
  local.pendingFeedback = out.feedback || null;
  if (out.nextQuestion) {
    local.transcript.push({ role: 'interviewer', text: String(out.nextQuestion) });
  }
  await persist(ctx, job);
  ctx.render();
}

async function persist(ctx, job) {
  if (!local.sessionId) return;
  await ctx.send('patch-mockInterviews', {
    id: local.sessionId,
    patch: {
      transcript: local.transcript,
      pendingFeedback: local.pendingFeedback,
      jobTitle: job?.title || '',
      jobId: local.jobId,
      interviewType: local.interviewType
    }
  });
  await ctx.reload('mockInterviews');
}

export function attach($main, ctx) {
  $main.querySelector('#mi-job')?.addEventListener('change', (e) => { local.jobId = e.target.value; ctx.render(); });
  $main.querySelector('#mi-type')?.addEventListener('change', (e) => { local.interviewType = e.target.value; ctx.render(); });

  $main.querySelector('#mi-start')?.addEventListener('click', async () => {
    const job = (ctx.state.jobs || []).find((j) => j.id === local.jobId);
    if (!job) return;
    local.transcript = [];
    local.pendingFeedback = null;
    const r = await ctx.send('add-mockInterviews', {
      jobId: local.jobId,
      jobTitle: job.title,
      interviewType: local.interviewType,
      transcript: [],
      pendingFeedback: null
    });
    if (r?.ok) { local.sessionId = r.item.id; }
    await ctx.reload('mockInterviews');
    await callAi(ctx, job, ctx.state.profile || {});
  });

  $main.querySelectorAll('[data-mi-load]').forEach((el) => el.addEventListener('click', () => {
    const sid = el.dataset.miLoad;
    const sess = (ctx.state.mockInterviews || []).find((s) => s.id === sid);
    if (!sess) return;
    local.sessionId = sid;
    local.jobId = sess.jobId || '';
    local.interviewType = sess.interviewType || 'behavioral';
    local.transcript = sess.transcript || [];
    local.pendingFeedback = sess.pendingFeedback || null;
    ctx.render();
  }));

  const ta = $main.querySelector('#mi-input');
  ta?.addEventListener('input', (e) => { local.draft = e.target.value; });

  $main.querySelector('#mi-send')?.addEventListener('click', async () => {
    const text = (ta?.value || '').trim();
    if (!text) return;
    const job = (ctx.state.jobs || []).find((j) => j.id === local.jobId);
    if (!job) return;
    local.transcript.push({ role: 'candidate', text });
    local.draft = '';
    await persist(ctx, job);
    await callAi(ctx, job, ctx.state.profile || {});
  });

  $main.querySelector('#mi-end')?.addEventListener('click', async () => {
    if (!confirm('End this session?')) return;
    local.sessionId = null;
    local.transcript = [];
    local.pendingFeedback = null;
    ctx.render();
  });
}
