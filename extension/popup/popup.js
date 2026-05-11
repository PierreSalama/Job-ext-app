// v6 popup. Coexists with sidebar-agent's HTML overhaul: every DOM access is
// optional/defensive so a missing element never throws. Adds three things on
// top of the redesigned popup: theme application, sync-status pill, and
// theme-picker dropdown (footer).
import { applyTheme, subscribeThemeChanges, THEMES } from '../lib/themes.js';

const send = (type, data) => new Promise((res) => chrome.runtime.sendMessage({ type, data }, res));
const $ = (s) => document.querySelector(s);

function paintSync(status) {
  const pill = $('#sync-pill');
  const label = $('#sync-label');
  if (pill && label) {
    if (status?.connected) { pill.className = 'pill ok'; label.textContent = 'Desktop: connected'; }
    else if (status?.healthy) { pill.className = 'pill ok'; label.textContent = 'Desktop: online'; }
    else { pill.className = 'pill bad'; label.textContent = 'Desktop: offline'; }
  } else {
    // No dedicated pill — append into the header subtitle when present
    const sub = document.querySelector('.h .sub');
    if (sub && !sub.querySelector('#sync-pill')) {
      const span = document.createElement('span');
      span.id = 'sync-pill';
      span.className = 'pill bad';
      span.innerHTML = '<span id="sync-label">Desktop: offline</span>';
      sub.appendChild(span);
      paintSync(status);
    }
  }
  // Install banner when desktop offline
  paintInstallBanner(status?.connected || status?.healthy);
}

function paintInstallBanner(isOnline) {
  let bnr = $('#install-app-banner');
  if (isOnline) { if (bnr) bnr.remove(); return; }
  if (bnr) return;
  const root = $('.b') || document.body;
  if (!root) return;
  bnr = document.createElement('div');
  bnr.id = 'install-app-banner';
  bnr.style.cssText = 'background:linear-gradient(135deg,rgba(99,102,241,0.18),rgba(139,92,246,0.10));border:1px solid rgba(99,102,241,0.3);border-radius:8px;padding:10px;margin-top:10px;font-size:11px;cursor:pointer';
  bnr.innerHTML = `<strong style="color:var(--primary,#6366f1)">🖥️ Want more power?</strong><div style="margin-top:3px;color:var(--muted,#94a3b8)">Install the optional desktop app for real-time sync and folder watching.</div>`;
  bnr.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html#/install-app') }));
  root.insertBefore(bnr, root.firstChild?.nextSibling || null);
}

function paintThemePicker(currentId) {
  const sel = $('#theme-pick');
  if (!sel) return;
  if (!sel.options.length) {
    sel.innerHTML = THEMES.map((t) => `<option value="${t.id}">${t.icon} ${t.name}</option>`).join('');
  }
  sel.value = currentId;
  sel.onchange = async () => {
    const id = sel.value;
    applyTheme(id);
    await send('patch-settings', { theme: id });
  };
}

(async () => {
  const settingsRes = await send('get-settings');
  const themeId = settingsRes?.settings?.theme || 'midnight';
  applyTheme(themeId);
  subscribeThemeChanges((id) => { applyTheme(id); paintThemePicker(id); });
  paintThemePicker(themeId);

  const sum = await send('status-summary');
  if (sum?.ok) {
    if ($('#s-today'))  $('#s-today').textContent  = sum.summary.today;
    if ($('#s-week'))   $('#s-week').textContent   = sum.summary.week;
    if ($('#s-total'))  $('#s-total').textContent  = sum.summary.total;
    if ($('#s-active')) $('#s-active').textContent = sum.summary.active || 0;
  }
  const list = await send('list-jobs');
  if (list?.ok && $('#recent')) {
    const recent = (list.items || []).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 5);
    $('#recent').innerHTML = recent.length === 0
      ? '<div class="empty">No applications yet.</div>'
      : recent.map((j) => `<div class="row"><div class="label"><strong>${escapeHtml(j.title || 'Untitled')}</strong><small>${escapeHtml(j.company || '')} · ${j.status}</small></div></div>`).join('');
  }

  const ss = await send('sync.status');
  paintSync(ss?.status || { healthy: false, connected: false });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'jat-event' && msg.name === 'sync.status') paintSync(msg.data);
  });

  $('#open')?.addEventListener('click', () => send('open-app'));
  $('#ai')?.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html#/settings') }));
  $('#add')?.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html#/jobs') }));
  $('#tour')?.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html#/tour') }));
  $('#sync')?.addEventListener('click', () => chrome.tabs.create({ url: 'https://www.linkedin.com/my-items/saved-jobs/' }));
})();

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- Greeting + AI status pill + due/overdue + AI nudge ----------
function _greetingPart() {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 21 ? 'Good evening' : 'Good night';
}

(async () => {
  // Greeting
  try {
    const pr = await send('get-profile');
    const name = pr?.profile?.firstName || pr?.profile?.preferredName || '';
    if ($('#greet')) $('#greet').textContent = name ? `${_greetingPart()}, ${name}` : _greetingPart();
  } catch {}

  // AI status pill
  try {
    const aiR = await send('ai-status');
    const pill = $('#ai-pill');
    if (pill) {
      if (aiR?.status?.available) { pill.className = 'pill ok'; pill.textContent = `AI: ${aiR.status.provider} ready`; }
      else { pill.className = 'pill bad'; pill.textContent = 'AI: off'; }
    }
  } catch {}

  // Due / overdue (jobs follow-ups + reminders + events) - if list-due section exists
  if ($('#due-list')) {
    try {
      const [jobsR, evR, remR] = await Promise.all([
        send('list-jobs'),
        send('list-events').catch(() => null),
        send('list-reminders').catch(() => null)
      ]);
      const jobs = jobsR?.items || [];
      const events = evR?.items || [];
      const reminders = remR?.items || [];
      const now = Date.now();
      const due = [];
      for (const j of jobs) {
        if (j.followUpDueAt && new Date(j.followUpDueAt).getTime() <= now + 86400000 && !['offer','rejected','withdrawn','archived'].includes(j.status)) {
          due.push({ label: `Follow up: ${j.title}`, sub: `${j.company} · ${new Date(j.followUpDueAt).toLocaleDateString()}` });
        }
      }
      for (const r of reminders) {
        if (r.done) continue;
        const t = r.fireAt ? new Date(r.fireAt).getTime() : 0;
        if (t && t <= now + 86400000) due.push({ label: r.title || 'Reminder', sub: r.fireAt ? new Date(r.fireAt).toLocaleString() : '' });
      }
      for (const e of events) {
        const t = e.startsAt ? new Date(e.startsAt).getTime() : 0;
        if (t && t >= now - 3600000 && t <= now + 86400000) due.push({ label: e.title || 'Interview', sub: e.startsAt ? new Date(e.startsAt).toLocaleString() : '' });
      }
      if (due.length > 0) {
        $('#due-list').innerHTML = due.slice(0, 4).map((d) => `<div class="row"><div class="label"><strong>${escapeHtml(d.label)}</strong><small>${escapeHtml(d.sub)}</small></div></div>`).join('');
      }
    } catch {}
  }

  // AI nudge of the day — only when AI is available
  if ($('#nudge-section') && $('#nudge')) {
    try {
      const aiR = await send('ai-status');
      if (aiR?.status?.available) {
        const jobsR = await send('list-jobs');
        const jobs = jobsR?.items || [];
        if (jobs.length > 0) {
          const r = await send('ai-call', { feature: 'nudges', jobs: jobs.slice(0, 30) });
          if (r?.ok && Array.isArray(r.result) && r.result.length > 0) {
            const top = r.result.find((n) => n.priority === 'high') || r.result[0];
            const job = jobs.find((j) => j.id === top.jobId);
            if (job) {
              $('#nudge-section').hidden = false;
              $('#nudge').innerHTML = `<strong>${escapeHtml(job.title)} · ${escapeHtml(job.company)}</strong>${escapeHtml(top.reason || '')}`;
            }
          }
        }
      }
    } catch {}
  }
})();
