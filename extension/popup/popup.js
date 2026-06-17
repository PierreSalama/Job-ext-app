// JAT v11 popup — mission control.
// One popup-state fetch paints connection/queue/auto-apply; in parallel it
// queries the active tab's content script for what JAT sees on THIS page, and
// (when paired) pulls /stats + recent jobs through the SW api-call proxy.

const $ = (s) => document.querySelector(s);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }));
const SNOOZE_KEY = 'jat11.updateSnoozeVersion';

const STAGE_LABEL = { detected: 'Detected', started: 'Apply opened', progressing: 'In progress', submitted: 'Submitted' };
const STATUS_LABEL = {
  started: 'Started', submitted: 'Submitted', contacted: 'Contacted',
  interview_1: 'First interview', interview_2: 'Second interview', interview_final: 'Final interview',
  offer: 'Offer', hired: 'Hired', rejected: 'Rejected', withdrawn: 'Withdrawn', ghosted: 'Ghosted',
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const relTime = (iso) => {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'now'; if (m < 60) return m + 'm';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
};
function setHint(el, msg, cls = '') { el.className = 'hint ' + cls; el.textContent = msg; }
function openDashboard(hash = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html') + hash });
  window.close();
}

let suppressedHost = null;

async function paintConnection() {
  $('#ext-version').textContent = 'v' + chrome.runtime.getManifest().version;
  const st = await send({ type: 'popup-state' });
  if (!st?.ok) return null;

  const dot = $('#conn-dot');
  if (st.health?.ok) {
    dot.className = 'conn-dot ok';
    $('#conn-text').textContent = `app v${st.health.app?.version || '?'}${st.queueN ? ' · ' + st.queueN + ' queued' : ''}`;
    $('#pair-row').hidden = st.paired || st.setupNeeded;
  } else if (st.connected) {
    // Paired + recently healthy: the app is up but this one probe blipped (the Teach
    // crop/distill makes /health briefly slow). Keep the connected UI — do NOT drop to
    // a re-pair/Connect prompt over a transient stall.
    dot.className = 'conn-dot ok';
    $('#conn-text').textContent = `app connected${st.queueN ? ' · ' + st.queueN + ' queued' : ''}`;
    $('#pair-row').hidden = true;
  } else {
    dot.className = 'conn-dot bad';
    $('#conn-text').textContent = 'app offline';
    $('#pair-row').hidden = true;
  }

  // Not connected yet → show the guided-setup card and hide the data sections
  // (they're meaningless without a paired app).
  if (st.setupNeeded) {
    $('#setup-row').hidden = false;
    $('#page-card').hidden = true;
    if (st.appInstalledButClosed) {
      $('#setup-title').textContent = 'Your app isn\'t running';
      $('#setup-sub').textContent = 'Open the desktop app to keep capturing and syncing.';
      $('#btn-setup').textContent = 'Open the app';
      $('#btn-setup').dataset.mode = 'launch';
    } else if (st.health?.ok) {
      $('#setup-title').textContent = 'Almost there';
      $('#setup-sub').textContent = 'The app is running — connect to finish setup.';
      $('#btn-setup').textContent = 'Connect →';
      $('#btn-setup').dataset.mode = 'onboard';
    } else {
      $('#btn-setup').dataset.mode = 'onboard';
    }
  } else {
    $('#setup-row').hidden = true;
    $('#page-card').hidden = false;
  }

  if (st.autoApply) {
    $('#aa-row').hidden = false;
    const a = $('#aa-state');
    a.textContent = st.autoApply.enabled ? `on · ${st.autoApply.mode} mode` : 'off';
    a.className = 'aa-state' + (st.autoApply.enabled ? ' on' : '');
  }

  if (st.extUpdate?.hasUpdate) {
    $('#ext-mine').textContent = 'v' + st.extUpdate.mine;
    $('#ext-latest').textContent = 'v' + st.extUpdate.latest;
    $('#ext-update-banner').hidden = false;
  }
  return st;
}

async function paintPage() {
  const body = $('#page-body');
  const hint = $('#capture-hint');
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch {}
  if (!tab?.id || !/^https?:/.test(tab.url || '')) {
    body.innerHTML = '<div class="page-line muted">JAT doesn\'t run on this page.</div>';
    $('#btn-capture').disabled = true;
    return;
  }

  let ps = null;
  try { ps = await chrome.tabs.sendMessage(tab.id, { type: 'jat11.page-state' }); } catch { ps = null; }

  if (ps?.suppressed) {
    suppressedHost = new URL(tab.url).hostname;
    body.innerHTML = `<div class="page-line warn">JAT is silenced on ${esc(suppressedHost)}.</div>`;
    setHint(hint, 'Tracking here is off. Re-enable it, or track this one page anyway.');
    $('#capture-hint').insertAdjacentHTML('beforeend', ' <a href="#" id="reenable" style="color:var(--primary)">Re-enable</a>');
    $('#reenable')?.addEventListener('click', async (e) => {
      e.preventDefault();
      const cur = (await chrome.storage.local.get('jat11.suppressHosts'))['jat11.suppressHosts'] || [];
      await chrome.storage.local.set({ 'jat11.suppressHosts': cur.filter((h) => h !== suppressedHost) });
      paintPage();
    });
    return;
  }

  if (ps?.detected && ps.title) {
    const captured = ps.persisted || ps.stage === 'submitted';
    body.innerHTML = `
      ${ps.stage ? `<div class="page-stage"><span class="dot"></span>${esc(STAGE_LABEL[ps.stage] || ps.stage)}</div>` : ''}
      <div class="page-title">${esc(ps.title)}</div>
      ${ps.company ? `<div class="page-co">${esc(ps.company)}${ps.source ? ' · ' + esc(ps.source) : ''}</div>` : ''}`;
    if (captured) setHint(hint, ps.saveState === 'queued' ? 'Captured — queued until the app is back.' : 'Saved to your tracker ✓', ps.saveState === 'queued' ? 'warn' : 'ok');
    else setHint(hint, 'Detected. It saves automatically once you apply — or track it now.');
    $('#btn-capture').textContent = captured ? '📌 Update this entry' : '📌 Track this page';
  } else if (ps && ps.loaded === false && ps.plausible) {
    body.innerHTML = '<div class="page-line">This looks like a job page.</div>';
    setHint(hint, 'JAT is watching. Track it now if you want it saved immediately.');
  } else {
    body.innerHTML = '<div class="page-line muted">No job detected on this page.</div>';
    setHint(hint, 'You can still track it manually — handy for ATS pages JAT didn\'t recognize.');
  }
}

async function paintStatsAndRecent(st) {
  if (!st?.health?.ok || !st.paired) return;
  const [statsR, jobsR] = await Promise.all([
    send({ type: 'api-call', method: 'GET', path: '/stats' }),
    send({ type: 'api-call', method: 'GET', path: '/jobs?limit=4' }),
  ]);
  if (statsR?.ok) {
    $('#stats').hidden = false;
    $('#st-total').textContent = statsR.total ?? 0;
    $('#st-week').textContent = statsR.thisWeek ?? 0;
    const rv = $('#st-review');
    rv.textContent = statsR.needsReview ?? 0;
    if (statsR.needsReview) rv.classList.add('warn');
  }
  if (jobsR?.ok && jobsR.items?.length) {
    $('#recent').hidden = false;
    const list = $('#recent-list');
    list.replaceChildren();
    for (const j of jobsR.items) {
      const b = document.createElement('button');
      b.className = 'rec-item';
      b.innerHTML = `<span class="rec-dot" data-status="${esc(j.status)}"></span>
        <span class="rec-main"><span class="rec-title">${esc(j.title || 'Untitled')}</span>
        <span class="rec-co">${esc(j.company || '')} · ${esc(STATUS_LABEL[j.status] || j.status)}</span></span>
        <span class="rec-when">${esc(relTime(j.updatedAt))}</span>`;
      b.addEventListener('click', () => openDashboard('#/applications/' + j.id));
      list.appendChild(b);
    }
  }
}

async function paintAppUpdate() {
  try {
    const r = await send({ type: 'check-app-update', force: true });
    const snoozed = (await chrome.storage.local.get(SNOOZE_KEY))[SNOOZE_KEY];
    const show = r?.ok && r.appRunning && r.hasUpdate && r.current && r.latest && r.current !== r.latest && snoozed !== r.latest;
    if (!show) { $('#update-banner').hidden = true; return; }
    $('#update-current').textContent = 'v' + r.current;
    $('#update-latest').textContent = 'v' + r.latest;
    $('#update-banner').hidden = false;
    $('#update-now').addEventListener('click', async () => {
      const s = $('#update-status');
      $('#update-now').disabled = true; $('#update-later').disabled = true;
      setHint(s, 'finding installer…');
      const d = await send({ type: 'download-app-installer' });
      if (d?.ok) setHint(s, `downloading ${d.fileName} — run it when done`, 'ok');
      else { setHint(s, d?.error || 'download failed', 'bad'); $('#update-now').disabled = false; $('#update-later').disabled = false; }
    });
    $('#update-later').addEventListener('click', async () => {
      await chrome.storage.local.set({ [SNOOZE_KEY]: r.latest });
      $('#update-banner').hidden = true;
    });
  } catch { $('#update-banner').hidden = true; }
}

// ---- actions ----
$('#btn-setup').addEventListener('click', async () => {
  const mode = $('#btn-setup').dataset.mode;
  if (mode === 'launch') { await send({ type: 'launch-app' }); window.close(); return; }
  await send({ type: 'open-onboarding' });
  window.close();
});

$('#btn-pair').addEventListener('click', async () => {
  const s = $('#action-status');
  setHint(s, 'check the app window — click Allow…');
  const r = await send({ type: 'pair-app' });
  if (r?.ok) { setHint(s, 'connected ✓', 'ok'); boot(); }
  else setHint(s, r?.error || 'pairing failed', 'bad');
});

$('#btn-capture').addEventListener('click', async () => {
  const hint = $('#capture-hint');
  setHint(hint, 'capturing…');
  const r = await send({ type: 'capture-now' });
  if (r?.ok) setHint(hint, `tracked: ${r.title || 'this page'} ✓`, 'ok');
  else if (r?.queued) setHint(hint, 'captured — app offline, queued ⏳', 'warn');
  else setHint(hint, r?.error || 'capture failed', 'bad');
  setTimeout(() => { paintPage(); boot(); }, 700);
});

// ---- Teach Mode toggle (Teach & Correct T2) ----
// Writes chrome.storage.local['jat11.teachMode']; the in-page recorder reads/watches it.
const TEACH_KEY = 'jat11.teachMode';
function paintTeach(on) {
  const btn = $('#teach-toggle');
  btn.textContent = on ? 'On' : 'Off';
  btn.classList.toggle('on', !!on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}
chrome.storage.local.get(TEACH_KEY).then((s) => paintTeach(!!s[TEACH_KEY])).catch(() => {});
$('#teach-toggle').addEventListener('click', async () => {
  const cur = (await chrome.storage.local.get(TEACH_KEY))[TEACH_KEY];
  const next = !cur;
  await chrome.storage.local.set({ [TEACH_KEY]: next });
  paintTeach(next);
});

// ---- Watch & Teach (T4) — supervised run of the next queued job ----
// Sends the SW `watch-and-teach` message (the wiring T4 added); the SW opens the next
// queued job in a supervised run with the Step/Run + on-page Fix-this overlay.
$('#watch-teach-btn').addEventListener('click', async () => {
  const btn = $('#watch-teach-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Starting…';
  const status = $('#action-status');
  setHint(status, '');
  const r = await send({ type: 'watch-and-teach' });
  // dispatched === true → a supervised run actually started (active tab or queued job).
  // dispatched === false → nothing to teach: surface the reason instead of silently
  // flipping back to Start.
  if (r?.ok && r.dispatched) {
    btn.textContent = 'Watching ✓';
  } else {
    btn.textContent = label;
    const msg = r?.message || r?.reason || r?.error;
    const friendly = (msg === 'no-job' || !msg)
      ? 'Open a job posting first, then Watch & teach'
      : msg === 'app offline' ? 'Open the app first'
      : msg === 'not paired' ? 'Connect the app first'
      : msg;
    setHint(status, friendly, 'warn');
  }
  setTimeout(() => { btn.disabled = false; if (r?.ok && r.dispatched) btn.textContent = label; }, 1500);
});

$('#open-dashboard').addEventListener('click', () => openDashboard());
$('#download-app').addEventListener('click', async () => {
  const s = $('#action-status');
  const btn = $('#download-app');
  btn.disabled = true;
  setHint(s, 'finding latest installer…');
  const r = await send({ type: 'download-app-installer' });
  if (r?.ok) setHint(s, `downloading ${r.fileName} (${r.tag})`, 'ok');
  else setHint(s, r?.error || 'download failed', 'bad');
  btn.disabled = false;
});
document.querySelectorAll('.stat[data-go]').forEach((b) => b.addEventListener('click', () => openDashboard(b.dataset.go)));

// ---- boot ----
async function boot() {
  const st = await paintConnection();
  await paintStatsAndRecent(st);
}
paintConnection().then((st) => paintStatsAndRecent(st));
paintPage();
paintAppUpdate();
send({ type: 'check-ext-update' });
