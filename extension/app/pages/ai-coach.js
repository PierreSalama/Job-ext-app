// Always-on chat assistant. Free-form Q&A with full state context.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const local = {
  messages: [], // [{role:'user'|'coach', text}]
  draft: '',
  loading: false
};

function buildContextSummary(state) {
  const jobs = state.jobs || [];
  const counts = {};
  for (const j of jobs) counts[j.status] = (counts[j.status] || 0) + 1;
  const recent = jobs.slice(-5).map((j) => `${j.title} @ ${j.company} (${j.status})`).join('; ');
  return `User profile: ${state.profile?.headline || ''} (${state.profile?.yearsExperience || '?'} yrs). ${jobs.length} total apps. Status counts: ${JSON.stringify(counts)}. Recent: ${recent}.`;
}

export function render(state) {
  return `
    <div class="page-h"><div><h1>AI Coach</h1><div class="sub">Free-form chat about your job search.</div></div>
      <button class="btn small" id="ac-clear">Clear</button>
    </div>
    <div class="card" style="padding:14px;display:flex;flex-direction:column;min-height:560px">
      <div id="ac-stream" style="flex:1;overflow:auto;padding:6px;background:var(--bg);border:1px solid var(--border);border-radius:8px;min-height:420px">
        ${local.messages.length === 0 ? `
          <div style="color:var(--muted);padding:20px;text-align:center">
            <div style="font-size:32px;margin-bottom:6px">💡</div>
            Ask about anything — strategy, follow-ups, weak spots in your funnel, prep ideas.
          </div>` :
          local.messages.map((m) => `
            <div style="margin-bottom:10px">
              <div style="font-size:11px;color:var(--muted);margin-bottom:2px">${m.role === 'user' ? 'You' : 'Coach'}</div>
              <div style="padding:8px 10px;border-radius:8px;background:${m.role === 'coach' ? 'rgba(99,102,241,0.10)' : 'var(--panel)'};border:1px solid var(--border);white-space:pre-wrap">${esc(m.text)}</div>
            </div>`).join('')}
        ${local.loading ? `<div style="padding:8px;color:var(--muted);font-size:12px">Thinking…</div>` : ''}
      </div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <textarea id="ac-input" placeholder="What would you like to know?" style="flex:1;padding:8px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;min-height:60px;resize:vertical;font-size:13px" ${local.loading ? 'disabled' : ''}>${esc(local.draft)}</textarea>
        <button class="btn primary" id="ac-send" style="align-self:stretch" ${local.loading ? 'disabled' : ''}>Send</button>
      </div>
    </div>
  `;
}

export function attach($main, ctx) {
  const ta = $main.querySelector('#ac-input');
  ta?.addEventListener('input', (e) => { local.draft = e.target.value; });
  ta?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      $main.querySelector('#ac-send')?.click();
    }
  });

  $main.querySelector('#ac-clear')?.addEventListener('click', () => {
    if (!confirm('Clear chat?')) return;
    local.messages = []; ctx.render();
  });

  $main.querySelector('#ac-send')?.addEventListener('click', async () => {
    const text = (ta?.value || '').trim();
    if (!text) return;
    local.messages.push({ role: 'user', text });
    local.draft = '';
    local.loading = true;
    ctx.render();
    const ctxSummary = buildContextSummary(ctx.state);
    const history = local.messages.slice(-8).map((m) => `${m.role.toUpperCase()}: ${m.text}`).join('\n');
    const prompt = `You are a candid job-search coach. Use the user's context to give concrete advice. Avoid generic platitudes.

USER CONTEXT:
${ctxSummary}

CONVERSATION:
${history}

COACH:`;
    const r = await ctx.aiCall({ feature: 'rawPrompt', prompt, opts: { temperature: 0.5, maxTokens: 700, system: 'You are a direct, helpful career coach. Concise. No hype.' } });
    local.loading = false;
    if (!r?.ok) {
      local.messages.push({ role: 'coach', text: 'AI error: ' + (r?.error || 'unknown') });
    } else {
      local.messages.push({ role: 'coach', text: String(r.result || '').trim() });
    }
    ctx.render();
    // scroll to bottom
    const stream = $main.querySelector('#ac-stream');
    if (stream) stream.scrollTop = stream.scrollHeight;
  });
}
