// JAT v10 — background service worker.
// Skeleton: records install time, responds to 'ping', 'app-health', and
// 'download-app-installer'. No tabs are opened automatically.

const APP_BASE = 'http://localhost:7744';

// GitHub repo hosting the desktop-app installers.
const GH_OWNER = 'PierreSalama';
const GH_REPO = 'Job-ext-app';

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const ts = new Date().toISOString();
  await chrome.storage.local.set({ installedAt: ts, lastReason: reason });
  console.log('[JAT v10] installed', { reason, ts });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'ping') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version, ts: Date.now() });
    return;
  }

  if (msg?.type === 'app-health') {
    (async () => {
      try {
        const r = await fetch(`${APP_BASE}/health`, { signal: AbortSignal.timeout(1200) });
        if (!r.ok) { sendResponse({ ok: false, reason: `HTTP ${r.status}` }); return; }
        const body = await r.json().catch(() => ({}));
        sendResponse({ ok: true, app: body });
      } catch (e) {
        sendResponse({ ok: false, reason: String(e?.message || e).slice(0, 120) });
      }
    })();
    return true;
  }

  if (msg?.type === 'download-app-installer') {
    (async () => {
      try {
        const result = await downloadAppInstaller();
        sendResponse({ ok: true, ...result });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
});

// ---------- Installer download ----------

async function detectOs() {
  try {
    const info = await chrome.runtime.getPlatformInfo();
    if (info.os === 'win') return 'windows';
    if (info.os === 'mac') return 'mac';
    return 'linux';
  } catch { return 'windows'; }
}

// Match the extension's major version to the desktop app's release line.
// Extension 10.x.y → look for the latest GitHub release tagged v10.*.*.
function extensionMajor() {
  const v = chrome.runtime.getManifest().version || '';
  const m = v.match(/^(\d+)/);
  return m ? m[1] : '';
}

function installerNameFor(os, major) {
  if (os === 'mac') return `JAT-v${major}.dmg`;
  if (os === 'linux') return `JAT-v${major}.AppImage`;
  return `JAT-v${major}-setup.exe`;
}

async function fetchMatchingRelease(major) {
  // Latest release on the repo. If its tag starts with v<major>, that's our
  // answer. Otherwise scan the recent releases list for the first match.
  const headers = { Accept: 'application/vnd.github+json' };
  const latest = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/latest`, { headers })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (latest && String(latest.tag_name || '').replace(/^v/, '').startsWith(`${major}.`)) {
    return latest;
  }
  const list = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases?per_page=30`, { headers })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []);
  return list.find((r) => String(r.tag_name || '').replace(/^v/, '').startsWith(`${major}.`)) || null;
}

async function downloadAppInstaller() {
  const major = extensionMajor();
  if (!major) throw new Error('could not parse extension version');
  const os = await detectOs();
  const fileName = installerNameFor(os, major);

  const release = await fetchMatchingRelease(major);
  if (!release) {
    throw new Error(`no v${major} release published yet at github.com/${GH_OWNER}/${GH_REPO}/releases`);
  }
  const tag = release.tag_name;
  // Prefer the asset listed on the release (handles renames). Fall back to the
  // conventional release/download URL if the asset isn't listed.
  const asset = (release.assets || []).find((a) => a.name === fileName);
  const url = asset ? asset.browser_download_url
                    : `https://github.com/${GH_OWNER}/${GH_REPO}/releases/download/${tag}/${fileName}`;

  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename: fileName, saveAs: false, conflictAction: 'overwrite' },
      (id) => {
        const err = chrome.runtime.lastError;
        if (err || !id) reject(new Error(err?.message || 'download failed'));
        else resolve(id);
      }
    );
  });

  return { downloadId, url, fileName, tag, os };
}
