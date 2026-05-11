// Negotiation workshop — pick offer → evaluate → strategize → iterate via chat.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const local = {
  jobId: '',
  evaluation: null,
  strategy: null,
  chat: [], // [{role, text}]
  draft: '',
  loading: false,
  step: 'pick' // 'pick' | 'evaluated' | 'strategized' | 'chatting'
};

function offers(state) { return (state.jobs || []).filter((j) => j.status === 'offer'); }

export function render(state) {
  const list = offers(state);
  const job = list.find((j) => j.id === local.jobId);

  return `
    <div class="page-h"><div><h1>Negotiation Studio</h1><div class="sub">Evaluate, strategize, then iterate via AI follow-ups.</div></div></div>

    <div class="card" style="padding:14px;margin-bottom:12px">
      <label style="font-size:12px;color:var(--muted)">Pick an offer</label>
      <select id="ng-job" style="width:100%;padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px">
        <option value="">— Select —</option>
        ${list.map((j) => `<option value="${esc(j.id)}"${local.jobId === j.id ? ' selected' : ''}>${esc(j.title)} · ${esc(j.company)}</option>`).join('')}
      </select>
      <div style="display:flex;gap:6px;margin-top:10px">
        <button class="btn primary" id="ng-eval" ${!local.jobId || local.loading ? 'disabled' : ''}>1. Evaluate offer</button>
        <button class="btn" id="ng-strat" ${!local.evaluation || local.loading ? 'disabled' : ''}>2. Negotiation strategy</button>
      </div>
    </div>

    ${local.evaluation ? `
      <div class="card" style="padding:14px;margin-bottom:12px">
        <h3 style="margin:0 0 8px">Evaluation</h3>
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:13px">
          <div><strong>Overall:</strong> ${local.evaluation.overall || 0}/100</div>
          <div><strong>Base:</strong> ${local.evaluation.base_score || 0}</div>
          <div><strong>Equity:</strong> ${local.evaluation.equity_score || 0}</div>
          <div><strong>Benefits:</strong> ${local.evaluation.benefits_score || 0}</div>
        </div>
        ${local.evaluation.culture_signals?.length ? `<div style="margin-top:8px"><strong>Culture signals:</strong> ${local.evaluation.culture_signals.map(esc).join('; ')}</div>` : ''}
        ${local.evaluation.negotiation_priorities?.length ? `<div style="margin-top:6px"><strong>Negotiation priorities:</strong><ul style="margin:4px 0 0 18px">${local.evaluation.negotiation_priorities.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
      </div>` : ''}

    ${local.strategy ? `
      <div class="card" style="padding:14px;margin-bottom:12px">
        <h3 style="margin:0 0 8px">Strategy</h3>
        ${local.strategy.anchor ? `<div style="margin-bottom:8px"><strong>Anchor:</strong> ${esc(local.strategy.anchor)}</div>` : ''}
        ${local.strategy.talkingPoints?.length ? `<div><strong>Talking points</strong><ul style="margin:4px 0 0 18px">${local.strategy.talkingPoints.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
        ${local.strategy.watchOuts?.length ? `<div style="margin-top:6px"><strong>Watch-outs</strong><ul style="margin:4px 0 0 18px">${local.strategy.watchOuts.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
        ${local.strategy.draftEmail ? `<div style="margin-top:8px"><strong>Draft email</strong><pre style="background:var(--bg);padding:8px;border-radius:6px;border:1px solid var(--border);white-space:pre-wrap;font-family:inherit;font-size:12px">${esc(local.strategy.draftEmail)}</pre></div>` : ''}
      </div>` : ''}

    ${local.evaluation || local.strategy ? `
      <div class="card" style="padding:14px">
        <h3 style="margin:0 0 8px">Iterate (chat)</h3>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px;max-height:280px;overflow:auto;margin-bottom:8px;min-height:80px">
          ${local.chat.length === 0 ? `<div style="color:var(--muted);font-size:12px">Ask follow-ups: "What if they counter?", "Push for sign-on?"…</div>` :
            local.chat.map((m) => `<div style="margin-bottom:8px"><div style="font-size:11px;color:var(--muted)">${m.role === 'user' ? 'You' : 'AI'}</div><div style="padding:6px 8px;border-radius:6px;background:${m.role === 'ai' ? 'rgba(99,102,241,0.10)' : 'var(--panel)'};white-space:pre-wrap">${esc(m.text)}</div></div>`).join('')}
          ${local.loading ? `<div style="font-size:12px;color:var(--muted)">Thinking…</div>` : ''}
        </div>
        <div style="display:flex;gap:6px">
          <input id="ng-chat-input" placeholder="Ask a follow-up…" style="flex:1;padding:8px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px" value="${esc(local.draft)}" ${local.loading ? 'disabled' : ''}/>
          <button class="btn primary" id="ng-chat-send" ${local.loading ? 'disabled' : ''}>Send</button>
        </div>
      </div>` : ''}
  `;
}

export function attach($main, ctx) {
  $main.querySelector('#ng-job')?.addEventListener('change', (e) => {
    local.jobId = e.target.value;
    local.evaluation = null; local.strategy = null; local.chat = [];
    ctx.render();
  });

  $main.querySelector('#ng-eval')?.addEventListener('click', async () => {
    const job = (ctx.state.jobs || []).find((j) => j.id === local.jobId);
    if (!job) return;
    local.loading = true; ctx.render();
    const offer = { base: job.compensation, bonus: job.bonus, equity: job.equity, benefits: job.benefits, location: job.location, role: job.title };
    const r = await ctx.aiCall({ feature: 'offerEvaluator', offer, profile: ctx.state.profile });
    local.loading = false;
    if (!r?.ok) { ctx.toast('Failed: ' + (r?.error || ''), 'danger'); ctx.render(); return; }
    local.evaluation = r.result;
    ctx.render();
  });

  $main.querySelector('#ng-strat')?.addEventListener('click', async () => {
    const job = (ctx.state.jobs || []).find((j) => j.id === local.jobId);
    if (!job) return;
    local.loading = true; ctx.render();
    const r = await ctx.aiCall({ feature: 'negotiate', job, profile: ctx.state.profile });
    local.loading = false;
    if (!r?.ok) { ctx.toast('Failed: ' + (r?.error || ''), 'danger'); ctx.render(); return; }
    local.strategy = r.result;
    ctx.render();
  });

  const inp = $main.querySelector('#ng-chat-input');
  inp?.addEventListener('input', (e) => { local.draft = e.target.value; });

  $main.querySelector('#ng-chat-send')?.addEventListener('click', async () => {
    const text = (inp?.value || '').trim();
    if (!text) return;
    const job = (ctx.state.jobs || []).find((j) => j.id === local.jobId);
    local.chat.push({ role: 'user', text });
    local.draft = '';
    local.loading = true;
    ctx.render();
    const history = local.chat.slice(-6).map((m) => `${m.role.toUpperCase()}: ${m.text}`).join('\n');
    const prompt = `You are a salary-negotiation coach. The candidate has an offer for ${job?.title || ''} at ${job?.company || ''} (${job?.compensation || 'comp unknown'}). Prior evaluation: ${JSON.stringify(local.evaluation || {}).slice(0, 800)}. Prior strategy: ${JSON.stringify(local.strategy || {}).slice(0, 800)}.

CONVERSATION:
${history}

AI:`;
    const r = await ctx.aiCall({ feature: 'rawPrompt', prompt, opts: { temperature: 0.4, maxTokens: 500, system: 'You are a sharp negotiation coach. Be specific and pragmatic.' } });
    local.loading = false;
    local.chat.push({ role: 'ai', text: r?.ok ? String(r.result || '').trim() : 'Error: ' + (r?.error || '') });
    ctx.render();
  });
}
