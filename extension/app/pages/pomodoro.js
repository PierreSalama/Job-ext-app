// Pomodoro timer page + floating mini-overlay.
// Stores completed sessions in `pomodoroSessions` so we can show a daily total.
// 25-min work / 5-min break by default; configurable via prompts.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const local = {
  workMins: 25,
  breakMins: 5,
  mode: 'idle',          // 'idle' | 'work' | 'break'
  remainingMs: 25 * 60000,
  startedAt: null,       // ISO timestamp of when current session started
  intervalId: null,
  notifyDone: true,
};

let _ctxRef = null;       // hold a reference to ctx so the overlay can call rerender

export function render(state) {
  const today = todayKey();
  const sessions = (state.pomodoroSessions || []).filter((s) => s.day === today);
  const totalMins = sessions.reduce((n, s) => n + (s.minutes || 0), 0);
  return `
    <div class="page-h">
      <div><h1>Pomodoro</h1><div class="sub">Focus timer · ${sessions.length} session${sessions.length === 1 ? '' : 's'} today · ${totalMins} min focused</div></div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="pomo-set-work">Work: ${local.workMins} min</button>
        <button class="btn" id="pomo-set-break">Break: ${local.breakMins} min</button>
      </div>
    </div>
    <div class="card" style="text-align:center;padding:40px">
      <div style="font-size:64px;font-weight:700;font-family:ui-monospace,Consolas,monospace;color:${local.mode === 'work' ? 'var(--primary)' : local.mode === 'break' ? 'var(--success)' : 'var(--text)'}">${formatTime(local.remainingMs)}</div>
      <div style="color:var(--muted);margin-top:6px;text-transform:uppercase;letter-spacing:0.08em;font-size:11px">${local.mode === 'idle' ? 'Ready' : local.mode === 'work' ? '🎯 Focus' : '☕ Break'}</div>
      <div style="margin-top:18px;display:flex;justify-content:center;gap:8px;flex-wrap:wrap">
        ${local.mode === 'idle' ? `<button class="btn primary" id="pomo-start">▶ Start ${local.workMins}-min focus</button>` :
          `<button class="btn" id="pomo-stop">■ Stop</button>`}
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0;font-size:14px">Today's sessions</h3>
      ${sessions.length === 0 ? '<div class="empty">No focus sessions yet today.</div>' : sessions.map((s) => `
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
          <span>${esc(s.kind || 'work')} · ${s.minutes} min</span>
          <span style="color:var(--muted)">${esc(new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span>
        </div>
      `).join('')}
    </div>
  `;
}

export function attach($main, ctx) {
  _ctxRef = ctx;
  const $ = (sel) => $main.querySelector(sel);
  $('#pomo-start')?.addEventListener('click', () => startTimer('work', ctx));
  $('#pomo-stop')?.addEventListener('click', () => stopTimer(ctx, true));
  $('#pomo-set-work')?.addEventListener('click', () => {
    const v = prompt('Work duration (minutes):', String(local.workMins));
    const n = parseInt(v || '', 10);
    if (n >= 1 && n <= 180) { local.workMins = n; if (local.mode === 'idle') local.remainingMs = n * 60000; ctx.render(); }
  });
  $('#pomo-set-break')?.addEventListener('click', () => {
    const v = prompt('Break duration (minutes):', String(local.breakMins));
    const n = parseInt(v || '', 10);
    if (n >= 1 && n <= 60) { local.breakMins = n; ctx.render(); }
  });
}

// ============ Timer engine + floating mini overlay ============
function todayKey() { return new Date().toISOString().slice(0, 10); }
function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function startTimer(mode, ctx) {
  if (local.intervalId) clearInterval(local.intervalId);
  local.mode = mode;
  local.startedAt = new Date().toISOString();
  local.remainingMs = (mode === 'work' ? local.workMins : local.breakMins) * 60000;
  const tickEnd = Date.now() + local.remainingMs;
  local.intervalId = setInterval(() => {
    local.remainingMs = Math.max(0, tickEnd - Date.now());
    updateOverlay();
    if (local.remainingMs <= 0) {
      stopTimer(ctx, false);
      const next = local.mode === 'work' ? 'break' : 'work';
      if (local.notifyDone) {
        try {
          ctx?.toast?.(local.mode === 'work' ? '🎉 Focus done — take a break.' : '⏰ Break over — back to it.', 'success');
        } catch {}
      }
      // Auto-roll into next phase but don't restart automatically; just reset.
      local.mode = 'idle';
      local.remainingMs = (next === 'work' ? local.workMins : local.breakMins) * 60000;
      try { ctx?.render?.(); } catch {}
    } else {
      // Re-render the page if it's currently active so the big timer updates
      const onPage = location.hash === '#/pomodoro';
      if (onPage) { try { ctx?.render?.(); } catch {} }
    }
  }, 1000);
  ensureOverlay(ctx);
  try { ctx?.render?.(); } catch {}
}

export async function stopTimer(ctx, manual = true) {
  if (local.intervalId) { clearInterval(local.intervalId); local.intervalId = null; }
  // If we ran for at least 1 minute, log the session
  const elapsedMs = local.startedAt ? (Date.now() - new Date(local.startedAt).getTime()) : 0;
  const minutes = Math.round(elapsedMs / 60000);
  if (minutes >= 1 && local.startedAt) {
    try {
      await ctx?.send?.('add-pomodoroSessions', {
        kind: local.mode,
        minutes,
        day: todayKey(),
        startedAt: local.startedAt,
        endedAt: new Date().toISOString()
      });
    } catch {}
  }
  local.mode = 'idle';
  local.remainingMs = local.workMins * 60000;
  local.startedAt = null;
  removeOverlay();
  try { ctx?.render?.(); } catch {}
}

// Floating overlay — rendered into document.body so it persists across page nav.
export function togglePomodoroOverlay(ctx) {
  if (local.mode !== 'idle') {
    stopTimer(ctx, true);
  } else {
    startTimer('work', ctx);
  }
}

function ensureOverlay(ctx) {
  if (document.getElementById('pomo-overlay')) return;
  const el = document.createElement('div');
  el.id = 'pomo-overlay';
  el.style.cssText = 'position:fixed;bottom:18px;left:18px;z-index:9000;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:10px 14px;display:flex;align-items:center;gap:10px;box-shadow:0 8px 24px rgba(0,0,0,0.45);font-family:ui-monospace,Consolas,monospace';
  el.innerHTML = `
    <span style="font-size:18px">⏱</span>
    <strong id="pomo-overlay-time" style="font-size:15px">--:--</strong>
    <span id="pomo-overlay-mode" style="font-size:11px;color:var(--muted);text-transform:uppercase"></span>
    <button id="pomo-overlay-stop" style="background:transparent;border:0;color:var(--muted);cursor:pointer;font-size:16px;line-height:1">×</button>
  `;
  document.body.appendChild(el);
  el.querySelector('#pomo-overlay-stop').addEventListener('click', () => stopTimer(ctx, true));
  updateOverlay();
}

function updateOverlay() {
  const el = document.getElementById('pomo-overlay');
  if (!el) return;
  const t = el.querySelector('#pomo-overlay-time');
  const m = el.querySelector('#pomo-overlay-mode');
  if (t) t.textContent = formatTime(local.remainingMs);
  if (m) m.textContent = local.mode === 'idle' ? '' : (local.mode === 'work' ? 'focus' : 'break');
}

function removeOverlay() {
  const el = document.getElementById('pomo-overlay');
  if (el) el.remove();
}
