// v8: Permissions audit — show every Chrome permission with rationale.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

const RATIONALE = {
  storage: 'Save settings, profile, and IndexedDB metadata.',
  alarms: 'Schedule periodic Gmail sync and reminder firing.',
  notifications: 'Surface deadline + interview alerts.',
  scripting: 'Inject the universal autofill script into job sites.',
  declarativeNetRequest: 'Rewrite Ollama CORS headers so local AI works from the extension.',
  downloads: 'Save the bundled desktop installer to your Downloads folder.',
  contextMenus: 'Right-click "Save to Job Tracker" on any page.',
  unlimitedStorage: 'Store resumes, cover letters, JD snapshots without quota errors.',
  tabs: 'Open captured job URLs in new tabs and read the active tab title.',
  identity: 'Connect Gmail OAuth (only if you enable Gmail sync).',
  offscreen: 'Run document parsing in an offscreen document (Chrome 109+).',
  webRequest: 'Detect captcha pages so autofill knows to pause.'
};

let _state = null;

export function render() {
  return `
    <div class="page-h">
      <div><h1>🛡️ Permissions audit</h1>
      <div class="sub">Every Chrome permission this extension has — and why.</div></div>
      <div><button class="btn" id="pa-refresh">Refresh</button></div>
    </div>
    <div class="card">
      ${!_state ? `<div class="empty">Loading…</div>` : `
        <div class="list">
          ${(_state.permissions || []).map((p) => `
            <div class="list-row">
              <div>
                <div class="t">🔓 ${esc(p)}</div>
                <div class="s" style="font-size:12px;color:var(--muted)">${esc(RATIONALE[p] || 'No rationale provided.')}</div>
              </div>
            </div>
          `).join('')}
          ${(_state.origins || []).map((o) => `
            <div class="list-row">
              <div>
                <div class="t">🌐 ${esc(o)}</div>
                <div class="s" style="font-size:12px;color:var(--muted)">Host permission for capture + autofill on this domain.</div>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </div>
    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0">Local-only mode</h3>
      <p style="font-size:13px">
        When enabled, the extension makes <strong>zero outbound network calls</strong>. AI, sync, and Gmail features are disabled. Capture and autofill still work.
      </p>
      <button class="btn" id="pa-local-only">Toggle in Settings →</button>
    </div>
  `;
}

export async function attach($main, ctx) {
  try { _state = await chrome.permissions.getAll(); } catch { _state = { permissions: [], origins: [] }; }
  ctx.render();
  $main.querySelector('#pa-refresh')?.addEventListener('click', async () => {
    try { _state = await chrome.permissions.getAll(); } catch {}
    ctx.render();
  });
  $main.querySelector('#pa-local-only')?.addEventListener('click', () => { location.hash = '#/settings'; });
}
