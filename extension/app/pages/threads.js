// Conversation threads — group messages by threadId (or contactId fallback).
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

let _expanded = null;

function fmt(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export function render(state) {
  const all = (state.messages || []);
  const groups = {};
  for (const m of all) {
    const k = m.threadId || m.contactId || ('lone-' + m.id);
    (groups[k] ||= []).push(m);
  }
  const threads = Object.entries(groups).map(([id, msgs]) => {
    msgs.sort((a, b) => (a.receivedAt || '').localeCompare(b.receivedAt || ''));
    const latest = msgs[msgs.length - 1];
    return { id, msgs, latest };
  }).sort((a, b) => (b.latest.receivedAt || '').localeCompare(a.latest.receivedAt || ''));

  return `
    <div class="page-h">
      <div><h1>Threads</h1><div class="sub">${threads.length} conversation${threads.length === 1 ? '' : 's'} across ${all.length} messages</div></div>
    </div>
    <div class="card">
      ${threads.length === 0 ? `<div class="empty"><strong>No conversations yet.</strong>Threads appear automatically as messages with the same threadId or sender are captured.</div>` : `
        <div class="list">
          ${threads.map((t) => threadHtml(t, state)).join('')}
        </div>
      `}
    </div>
  `;
}

function threadHtml(t, state) {
  const isOpen = _expanded === t.id;
  const last = t.latest;
  const snippet = (last.subject || last.body || '').slice(0, 100);
  return `
    <div class="thr-row${isOpen ? ' open' : ''}">
      <div class="list-row" data-thr="${esc(t.id)}">
        <div>
          <div class="t">${esc(last.from || 'Unknown')} <span style="color:var(--muted);font-weight:400">· ${t.msgs.length} message${t.msgs.length === 1 ? '' : 's'}</span></div>
          <div class="s">${esc(snippet)}${snippet.length === 100 ? '…' : ''}</div>
        </div>
        <span class="pill source">${esc(last.source || 'Manual')}</span>
        <span class="s" style="font-size:11px;color:var(--muted)">${esc(fmt(last.receivedAt))}</span>
      </div>
      ${isOpen ? `
        <div class="card" style="margin:6px 0 12px;background:rgba(255,255,255,0.02)">
          ${t.msgs.map((m) => `
            <div style="padding:10px 0;border-top:1px solid var(--border)">
              <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
                <strong>${esc(m.from || 'Unknown')}</strong>
                <span style="color:var(--muted)">${esc(fmt(m.receivedAt))}</span>
              </div>
              ${m.subject ? `<div style="font-size:13px;font-weight:600;margin-bottom:4px">${esc(m.subject)}</div>` : ''}
              <div style="white-space:pre-wrap;font-size:13px;line-height:1.5;color:var(--text)">${esc(m.body || '')}</div>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

export function attach($main, ctx) {
  const { render: rerender } = ctx;
  $main.querySelectorAll('[data-thr]').forEach((el) => el.addEventListener('click', () => {
    _expanded = _expanded === el.dataset.thr ? null : el.dataset.thr;
    rerender();
  }));
}
