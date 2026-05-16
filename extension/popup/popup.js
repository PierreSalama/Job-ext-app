// JAT v10 popup. Read-only readouts + a "Download desktop app" button that
// opens the GitHub Releases page in a new tab.

const $ = (sel) => document.querySelector(sel);

(async () => {
  // SW health (sync ping)
  try {
    const r = await chrome.runtime.sendMessage({ type: 'ping' });
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

  // Desktop app health (proxied through SW to avoid CORS surprises later)
  try {
    const r = await chrome.runtime.sendMessage({ type: 'app-health' });
    if (r?.ok) {
      const v = r.app?.version || '?';
      $('#app-status').textContent = `connected · v${v}`;
      $('#app-status').classList.add('ok');
    } else {
      $('#app-status').textContent = 'offline';
      $('#app-status').classList.add('bad');
    }
  } catch (e) {
    $('#app-status').textContent = 'offline';
    $('#app-status').classList.add('bad');
  }

  // Install timestamp
  try {
    const s = await chrome.storage.local.get('installedAt');
    if (s.installedAt) $('#installed-at').textContent = new Date(s.installedAt).toLocaleString();
  } catch {}

  // Active tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    if (url) {
      const u = new URL(url);
      $('#active-tab').textContent = u.host + u.pathname;
    }
  } catch {}

  // Download button — fetches the v<major> installer for the user's OS from
  // GitHub Releases and starts it via chrome.downloads.download.
  $('#download-app').addEventListener('click', async () => {
    const btn = $('#download-app');
    const status = $('#download-status');
    status.className = 'status';
    status.textContent = 'finding latest installer…';
    btn.disabled = true;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'download-app-installer' });
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
