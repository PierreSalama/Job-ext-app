// Interview Prep — generate questions for a job, practice answers (text + audio
// recording), get AI coach feedback per question.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const local = {
  jobId: '',
  loadingQuestions: false,
  questions: [],          // [{id, text, jobId, answer, feedback, audioBase64, recording}]
  feedbackLoading: {},    // qid -> bool
  recordingId: null,
  _recorder: null,
  _chunks: []
};

function questionsForJob(state) {
  if (!local.jobId) return [];
  return (state.interviewQuestions || []).filter((q) => q.jobId === local.jobId).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

export function render(state) {
  const jobs = state.jobs || [];
  const qs = questionsForJob(state);

  return `
    <div class="page-h">
      <div><h1>Interview Prep</h1><div class="sub">AI-generated questions, practice answers, and coach feedback.</div></div>
    </div>
    <div class="card">
      <div style="display:flex;gap:10px;align-items:flex-end">
        <div style="flex:1">
          <label style="font-size:12px;color:var(--muted)">Application</label>
          <select id="ip-job" style="width:100%;padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px">
            <option value="">— Select —</option>
            ${jobs.map((j) => `<option value="${esc(j.id)}"${local.jobId === j.id ? ' selected' : ''}>${esc(j.title)} · ${esc(j.company)}</option>`).join('')}
          </select>
        </div>
        <button class="btn primary" id="ip-gen" ${local.loadingQuestions || !local.jobId ? 'disabled' : ''}>${local.loadingQuestions ? 'Generating…' : '✨ Generate 10 questions'}</button>
      </div>
    </div>

    ${qs.length === 0 ? `<div class="card empty" style="margin-top:14px">${local.jobId ? 'No questions yet — click Generate.' : 'Pick an application above.'}</div>` :
      `<div style="margin-top:14px;display:flex;flex-direction:column;gap:10px">${qs.map((q, i) => renderQuestion(q, i)).join('')}</div>`}
  `;
}

function renderQuestion(q, i) {
  const fb = q.feedback;
  const isLoading = local.feedbackLoading[q.id];
  const isRec = local.recordingId === q.id;
  return `
    <div class="card">
      <div style="font-weight:600;margin-bottom:8px">${i + 1}. ${esc(q.text)}</div>
      <textarea data-ip-ans="${esc(q.id)}" placeholder="Type your answer…" style="width:100%;min-height:90px;padding:8px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:13px;resize:vertical">${esc(q.answer || '')}</textarea>
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
        <button class="btn small${isRec ? ' danger' : ''}" data-ip-rec="${esc(q.id)}">${isRec ? '■ Stop' : '● Record'}</button>
        ${q.audioBase64 ? `<audio controls style="height:32px" src="${esc(q.audioBase64)}"></audio>` : ''}
        <button class="btn small primary" data-ip-fb="${esc(q.id)}" ${isLoading ? 'disabled' : ''}>${isLoading ? 'Coaching…' : '✨ Get feedback'}</button>
        <button class="btn small danger" data-ip-del="${esc(q.id)}" style="margin-left:auto">Delete</button>
      </div>
      ${fb ? `
        <div class="card" style="margin-top:8px;background:var(--bg)">
          ${fb.strengths?.length ? `<div style="margin-bottom:6px"><strong style="color:var(--success)">Strengths</strong><ul style="margin:4px 0 0 18px">${fb.strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
          ${fb.gaps?.length ? `<div style="margin-bottom:6px"><strong style="color:var(--warn)">Gaps</strong><ul style="margin:4px 0 0 18px">${fb.gaps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
          ${fb.suggestion ? `<div><strong style="color:var(--primary)">Try this</strong><br>${esc(fb.suggestion)}</div>` : ''}
        </div>` : ''}
    </div>
  `;
}

export function attach($main, ctx) {
  const { send, aiCall } = ctx;
  $main.querySelector('#ip-job')?.addEventListener('change', (e) => { local.jobId = e.target.value; ctx.render(); });

  $main.querySelector('#ip-gen')?.addEventListener('click', async () => {
    const job = (ctx.state.jobs || []).find((j) => j.id === local.jobId);
    if (!job) return;
    local.loadingQuestions = true; ctx.render();
    const r = await aiCall({ feature: 'questions', job });
    local.loadingQuestions = false;
    if (!r?.ok) { ctx.toast('Failed: ' + (r?.error || 'AI'), 'danger'); ctx.render(); return; }
    const list = Array.isArray(r.result) ? r.result : [];
    for (const text of list.slice(0, 10)) {
      await send('add-interviewQuestions', { jobId: local.jobId, text: String(text), answer: '', feedback: null, audioBase64: '' });
    }
    await ctx.reload('interviewQuestions');
  });

  $main.querySelectorAll('[data-ip-ans]').forEach((t) => t.addEventListener('blur', async (e) => {
    await send('patch-interviewQuestions', { id: t.dataset.ipAns, patch: { answer: e.target.value } });
    await ctx.reload('interviewQuestions');
  }));

  $main.querySelectorAll('[data-ip-fb]').forEach((b) => b.addEventListener('click', async () => {
    const qid = b.dataset.ipFb;
    const q = (ctx.state.interviewQuestions || []).find((x) => x.id === qid);
    if (!q) return;
    const ta = $main.querySelector(`[data-ip-ans="${qid}"]`);
    const answer = ta ? ta.value : (q.answer || '');
    local.feedbackLoading[qid] = true; ctx.render();
    const r = await aiCall({ feature: 'interviewFeedback', question: q.text, answer });
    local.feedbackLoading[qid] = false;
    if (!r?.ok) { ctx.toast('Feedback failed.', 'danger'); ctx.render(); return; }
    await send('patch-interviewQuestions', { id: qid, patch: { answer, feedback: r.result, practicedAt: new Date().toISOString() } });
    await ctx.reload('interviewQuestions');
  }));

  $main.querySelectorAll('[data-ip-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this question?')) return;
    await send('delete-interviewQuestions', { id: b.dataset.ipDel });
    await ctx.reload('interviewQuestions');
  }));

  $main.querySelectorAll('[data-ip-rec]').forEach((b) => b.addEventListener('click', async () => {
    const qid = b.dataset.ipRec;
    if (local.recordingId === qid) {
      // Stop
      try { local._recorder?.stop(); } catch {}
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) { ctx.toast('Recording not supported.', 'danger'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      local._chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) local._chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(local._chunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onload = async () => {
          await send('patch-interviewQuestions', { id: qid, patch: { audioBase64: reader.result } });
          local.recordingId = null;
          local._recorder = null;
          await ctx.reload('interviewQuestions');
        };
        reader.readAsDataURL(blob);
      };
      rec.start();
      local._recorder = rec;
      local.recordingId = qid;
      ctx.render();
    } catch (e) {
      ctx.toast('Mic access denied.', 'danger');
    }
  }));
}
