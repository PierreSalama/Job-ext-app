// JAT v10 popup.
// On open: pings the SW, probes the desktop app, checks if a newer app
// release is published. If the app is running but outdated, surfaces a
// non-intrusive update banner with a one-click "Update now" button that
// triggers the same download-app-installer pipeline as the footer button.

const $ = (sel) => document.querySelector(sel);
const send = (msg) => chrome.runtime.sendMessage(msg);

(async () => {
  // ---- SW health ----
  try {
    const r = await send({ type: 'ping' });
    if (r?.ok) {
      $('#sw-status').textContent = `ok · v${r.version}`;
      $('#sw-status').classList.add('ok');
    } else {
      $('#sw-status').textContent = 'no response';
      $('#sw-status').classList.add('bad');
    }
  } catch (e) {
    $('#sw-status').textContent = String(e?.message || e);
    $('#sw-status').classList.add('bad');
  }

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
    if (url) {
      const u = new URL(url);
      $('#active-tab').textContent = u.host + u.pathname;
    }
  } catch {}

  // ---- Update check ----
  // Show the banner only when the app is running AND a newer release exists.
  // If the app is offline, the user can still install/upgrade via the
  // "Download desktop app" button in the footer — no need to nag here.
  try {
    const r = await send({ type: 'check-app-update' });
    if (r?.ok && r.appRunning && r.hasUpdate) {
      const banner = $('#update-banner');
      $('#update-current').textContent = `v${r.current}`;
      $('#update-latest').textContent = `v${r.latest}`;
      banner.hidden = false;

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

      $('#update-later').addEventListener('click', () => {
        $('#update-banner').hidden = true;
      });
    }
  } catch {}

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
