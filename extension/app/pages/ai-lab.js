// AI Lab — free-form prompt sandbox. Saves history into the `experiments`
// IDB store. Supports a "compare two providers" mode that runs the same
// prompt against two providers in parallel.
import { db } from '../../lib/db.js';
import { renderMarkdown } from '../../lib/markdown.js';

const send = (type, data) => new Promise((res) => chrome.runtime.sendMessage({ type, data }, res));

function escape(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'x' + Date.now() + Math.random().toString(36).slice(2, 8);
}

const local = {
  prompt: '',
  provider: 'auto',
  providerB: 'ollama',
  compare: false,
  temperature: 0.7,
  maxTokens: 800,
  busy: false,
  output: '',
  outputB: '',
  durationMs: 0,
  durationMsB: 0,
  error: '',
  errorB: '',
  history: [],
  historyLoaded: false
};

async function loadHistory() {
  try {
    const all = await db.getAll('experiments');
    local.history = all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 25);
  } catch { local.history = []; }
  local.historyLoaded = true;
}

const PROVIDERS = [
  { id: 'auto', label: 'Auto (best available)' },
  { id: 'ollama', label: 'Ollama (local)' },
  { id: 'openai', label: 'OpenAI compatible' },
  { id: 'chrome', label: 'Chrome built-in (Gemini Nano)' }
];

export function render(state) {
  if (!local.historyLoaded) loadHistory().then(() => state.__rerender && state.__rerender());
  return `
    <div class="page-h">
      <div><h1>🧪 AI Lab</h1><div class="sub">Tinker with prompts. Compare providers side-by-side. Every run is saved to the experiments store.</div></div>
    </div>
    <div class="card" style="margin-bottom:14px">
      <textarea id="lab-prompt" placeholder="Type a prompt. Anything goes." style="width:100%;min-height:140px;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-family:inherit;font-size:13px;resize:vertical">${escape(local.prompt)}</textarea>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-top:10px">
        <label style="font-size:11px;color:var(--muted)">Provider
          <select id="lab-provider" style="width:100%;margin-top:4px">${PROVIDERS.map((p) => `<option value="${p.id}"${local.provider === p.id ? ' selected' : ''}>${p.label}</option>`).join('')}</select>
        </label>
        <label style="font-size:11px;color:var(--muted)">Temperature: ${local.temperature.toFixed(2)}
          <input type="range" id="lab-temp" min="0" max="2" step="0.05" value="${local.temperature}" style="width:100%" />
        </label>
        <label style="font-size:11px;color:var(--muted)">Max tokens
          <input type="number" id="lab-maxt" value="${local.maxTokens}" min="32" max="8000" step="32" style="width:100%;padding:6px;margin-top:4px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text)" />
        </label>
        <label style="font-size:11px;color:var(--muted);display:flex;flex-direction:column;justify-content:flex-end">
          <span><input type="checkbox" id="lab-compare" ${local.compare ? 'checked' : ''} /> Compare two providers</span>
          ${local.compare ? `<select id="lab-providerB" style="margin-top:6px">${PROVIDERS.filter((p) => p.id !== 'auto').map((p) => `<option value="${p.id}"${local.providerB === p.id ? ' selected' : ''}>${p.label}</option>`).join('')}</select>` : ''}
        </label>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
        <button class="btn primary" id="lab-run" ${local.busy ? 'disabled' : ''}>${local.busy ? 'Running…' : 'Run'}</button>
        ${local.busy ? '<span style="font-size:12px;color:var(--muted)">Working… AI calls can take 10–60s on local models.</span>' : ''}
      </div>
    </div>

    ${local.compare ? `
      <div class="grid-2" style="margin-bottom:14px">
        ${renderOutputPane(local.provider, local.output, local.error, local.durationMs)}
        ${renderOutputPane(local.providerB, local.outputB, local.errorB, local.durationMsB)}
      </div>
    ` : `
      <div style="margin-bottom:14px">${renderOutputPane(local.provider, local.output, local.error, local.durationMs)}</div>
    `}

    <div class="card">
      <h3 style="margin-top:0;font-size:14px">History · ${local.history.length}</h3>
      ${local.history.length === 0
        ? `<div style="color:var(--muted);font-size:12px">No experiments yet.</div>`
        : `<div style="max-height:340px;overflow:auto;display:flex;flex-direction:column;gap:6px">
          ${local.history.map((h) => `
            <div style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:12px">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                <strong style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escape((h.prompt || '').slice(0, 100))}</strong>
                <span style="color:var(--muted);font-size:11px">${escape(formatTime(h.createdAt))} · ${h.durationMs || 0}ms · ${escape(h.opts?.provider || 'auto')}</span>
                <button class="btn small" data-history-load="${escape(h.id)}">Load</button>
                <button class="btn small danger" data-history-del="${escape(h.id)}">×</button>
              </div>
            </div>
          `).join('')}
        </div>`}
    </div>
  `;
}

function renderOutputPane(provider, output, error, ms) {
  return `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong style="font-size:13px">Output · ${escape(provider || 'auto')}</strong>
        <span style="font-size:11px;color:var(--muted)">${ms ? ms + 'ms' : ''}</span>
      </div>
      ${error
        ? `<div style="color:var(--danger);font-size:12px">${escape(error)}</div>`
        : output
          ? `<div style="font-size:13px;line-height:1.5">${renderMarkdown(output)}</div>`
          : `<div style="color:var(--muted);font-size:12px">Output will appear here.</div>`}
    </div>
  `;
}

function formatTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export function attach($main, state) {
  const rerender = () => state.__rerender && state.__rerender();
  document.getElementById('lab-prompt')?.addEventListener('input', (e) => { local.prompt = e.target.value; });
  document.getElementById('lab-provider')?.addEventListener('change', (e) => { local.provider = e.target.value; rerender(); });
  document.getElementById('lab-providerB')?.addEventListener('change', (e) => { local.providerB = e.target.value; });
  document.getElementById('lab-temp')?.addEventListener('input', (e) => { local.temperature = parseFloat(e.target.value); rerender(); });
  document.getElementById('lab-maxt')?.addEventListener('input', (e) => { local.maxTokens = parseInt(e.target.value || '800', 10); });
  document.getElementById('lab-compare')?.addEventListener('change', (e) => { local.compare = e.target.checked; rerender(); });

  document.getElementById('lab-run')?.addEventListener('click', async () => {
    if (!local.prompt.trim()) return;
    local.busy = true; local.output = ''; local.outputB = ''; local.error = ''; local.errorB = '';
    local.durationMs = 0; local.durationMsB = 0;
    rerender();
    const opts = { provider: local.provider, temperature: local.temperature, maxTokens: local.maxTokens };
    const promises = [runOne(local.prompt, opts).then((r) => { local.output = r.text; local.error = r.error; local.durationMs = r.durationMs; })];
    if (local.compare) {
      const optsB = { provider: local.providerB, temperature: local.temperature, maxTokens: local.maxTokens };
      promises.push(runOne(local.prompt, optsB).then((r) => { local.outputB = r.text; local.errorB = r.error; local.durationMsB = r.durationMs; }));
    }
    await Promise.all(promises);
    local.busy = false;
    rerender();

    // Save to history
    try {
      const entry = {
        id: uuid(),
        prompt: local.prompt,
        opts,
        output: local.output,
        durationMs: local.durationMs,
        createdAt: new Date().toISOString()
      };
      await db.put('experiments', entry);
      if (local.compare) {
        await db.put('experiments', {
          id: uuid(),
          prompt: local.prompt,
          opts: { provider: local.providerB, temperature: local.temperature, maxTokens: local.maxTokens },
          output: local.outputB,
          durationMs: local.durationMsB,
          createdAt: new Date().toISOString(),
          comparedTo: entry.id
        });
      }
      await loadHistory();
      rerender();
    } catch {}
  });

  document.querySelectorAll('[data-history-load]').forEach((b) => b.addEventListener('click', () => {
    const item = local.history.find((h) => h.id === b.dataset.historyLoad);
    if (!item) return;
    local.prompt = item.prompt || '';
    local.provider = item.opts?.provider || 'auto';
    local.temperature = item.opts?.temperature ?? 0.7;
    local.maxTokens = item.opts?.maxTokens || 800;
    local.output = item.output || '';
    local.durationMs = item.durationMs || 0;
    rerender();
  }));
  document.querySelectorAll('[data-history-del]').forEach((b) => b.addEventListener('click', async () => {
    try { await db.delete('experiments', b.dataset.historyDel); } catch {}
    await loadHistory();
    rerender();
  }));
}

async function runOne(prompt, opts) {
  const t0 = Date.now();
  const r = await send('ai-call', { feature: 'rawPrompt', prompt, opts });
  const durationMs = Date.now() - t0;
  if (r?.ok) return { text: r.result || '', error: '', durationMs };
  return { text: '', error: r?.error || 'AI call failed', durationMs };
}
