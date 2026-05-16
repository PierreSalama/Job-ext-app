// JAT v10 popup.
// On open: pings the SW, probes the desktop app, forces a fresh app-update
// check (no stale cache), and surfaces the gold update banner only when the
// running app is genuinely behind the latest published release.
// "Later" persists per-version — once snoozed for v10.0.X, the banner stays
// hidden until a newer version is published.

const $ = (sel) => document.querySelector(sel);
const send = (msg) => chrome.runtime.sendMessage(msg);
const SNOOZE_KEY = 'jat10.updateSnoozeVersion';

(async () => {
  // ---- SW health ----
  try {
    const r = await send({ type: 'ping' });
    if (r?.ok) { $('#sw-status').textContent = `ok · v${r.version}`; $('#sw-status').classList.add('ok'); }
    else       { $('#sw-status').textContent = 'no response'; $('#sw-status').classList.add('bad'); }
  } catch (e) { $('#sw-status').textContent = String(e?.message || e); $('#sw-status').classList.add('bad'); }

  // ---- Desktop app health ----
  let appVersion = null;
  try {
    const r = await send({ type: 'app-health' });
    if (r?.ok) {
      appVersion = r.app?.version || null;
      $('#app-status').textContent = `connected · v${appVersion || '?'}`;
      $('#app-status').classList.add('ok');
    } else {
      $('#app-status').textContent = 'offline';
      $('#app-status').classList.add('bad');
    }
  } catch {
    $('#app-status').textContent = 'offline';
    $('#app-status').classList.add('bad');
  }

  // ---- Install timestamp ----
  try {
    const s = await chrome.storage.local.get('installedAt');
    if (s.installedAt) $('#installed-at').textContent = new Date(s.installedAt).toLocaleString();
  } catch {}

  // ---- Active tab ----
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    if (url) { const u = new URL(url); $('#active-tab').textContent = u.host + u.pathname; }
  } catch {}

  // ---- Update check (force=true so we never trust stale cache) ----
  try {
    const r = await send({ type: 'check-app-update', force: true });
    const snoozed = (await chrome.storage.local.get(SNOOZE_KEY))[SNOOZE_KEY];
    const shouldShow = (
      r?.ok && r.appRunning && r.hasUpdate
      && r.current && r.latest               // never show with null versions
      && r.current !== r.latest              // sanity guard
      && snoozed !== r.latest                // not snoozed for THIS latest
    );
    // Visible log so Pierre can right-click popup → Inspect to verify
    console.log('[JAT popup] update check', {
      r, snoozed, shouldShow,
      reasons: {
        ok: r?.ok, appRunning: r?.appRunning, hasUpdate: r?.hasUpdate,
        currentTruthy: !!r?.current, latestTruthy: !!r?.latest,
        notEqual: r?.current !== r?.latest,
        notSnoozed: snoozed !== r?.latest,
      },
    });
    if (shouldShow) {
      $('#update-current').textContent = `v${r.current}`;
      $('#update-latest').textContent = `v${r.latest}`;
      $('#update-banner').hidden = false;

      $('#update-now').addEventListener('click', async () => {
        const btn = $('#update-now');
        const later = $('#update-later');
        const status = $('#update-status');
        btn.disabled = true; later.disabled = true;
        status.className = 'status';
        status.textContent = 'finding installer…';
        try {
          const d = await send({ type: 'download-app-installer' });
          if (d?.ok) {
            status.textContent = `downloading ${d.fileName}`;
            status.classList.add('ok');
          } else {
            status.textContent = d?.error || 'download failed';
            status.classList.add('bad');
            btn.disabled = false; later.disabled = false;
          }
        } catch (e) {
          status.textContent = String(e?.message || e);
          status.classList.add('bad');
          btn.disabled = false; later.disabled = false;
        }
      });

      $('#update-later').addEventListener('click', async () => {
        // Persist the snooze so this version stops nagging until a newer one
        // is published.
        try { await chrome.storage.local.set({ [SNOOZE_KEY]: r.latest }); } catch {}
        $('#update-banner').hidden = true;
      });
    } else {
      // Be defensive: if for any reason the banner is visible, force-hide it.
      $('#update-banner').hidden = true;
    }
  } catch {
    $('#update-banner').hidden = true;
  }

  // ---- Footer buttons ----
  $('#open-dashboard').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html') });
    window.close();
  });

  $('#download-app').addEventListener('click', async () => {
    const btn = $('#download-app');
    const status = $('#download-status');
    status.className = 'status';
    status.textContent = 'finding latest installer…';
    btn.disabled = true;
    try {
      const r = await send({ type: 'download-app-installer' });
      if (r?.ok) {
        status.textContent = `downloading ${r.fileName} (${r.tag})`;
        status.classList.add('ok');
      } else {
        status.textContent = r?.error || 'download failed';
        status.classList.add('bad');
      }
    } catch (e) {
      status.textContent = String(e?.message || e);
      status.classList.add('bad');
    } finally {
      btn.disabled = false;
    }
  });
})();
