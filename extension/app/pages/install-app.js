// "Install desktop app" wizard. Detects OS, looks for a prebuilt bundled
// installer that ships inside the extension's setup/ folder, and offers it
// as a one-click download. Falls back to the legacy "build from source"
// scripts as a manual route. Polls the local sync server every 2s to detect
// when the app comes online, then walks the user through pairing.
//
// Bundled installers live at chrome-extension://<id>/setup/JAT-v9-setup.exe
// (Windows), JAT-v9.pkg (macOS), JAT-v9.AppImage / JAT-v9.deb (Linux).
// Built by v9/app/build/build-*.{ps1,sh}.

// Note: no markdown import — pure HTML page, no rendered markdown.

let pollTimer = null;
// v8 fix: attach() is re-invoked on every render. Without these guards every
// rerender would spin up another setInterval and another fetch-and-rerender
// chain, freezing the page within a few seconds.
let _mounted = false;
let _osDetectionRequested = false;
let _bundledProbeInFlight = false;
let _bundledOsProbed = null; // os value for which we already probed during this mount

// OS detection. Synchronous fast path covers 99% of cases (works in
// every Chrome version). The async high-entropy hints API is used as a
// secondary correction inside attach() if synchronous detection was unsure.
function detectOS() {
  const platform = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
  const ua = (navigator.userAgent || '').toLowerCase();
  // Windows (most common)
  if (/win/.test(platform) || /windows/.test(ua)) return 'windows';
  if (/mac|darwin/.test(platform) || /mac os|macintosh/.test(ua)) return 'mac';
  if (/linux/.test(platform) || /linux/.test(ua)) return 'linux';
  // No clue — assume Windows (covers ~70% of users by share)
  return 'windows';
}

async function detectOSAsync() {
  // High-entropy client hints (Chrome 90+). Returns the canonical platform name.
  try {
    if (navigator.userAgentData?.getHighEntropyValues) {
      const v = await navigator.userAgentData.getHighEntropyValues(['platform']);
      const p = String(v.platform || '').toLowerCase();
      if (/windows/.test(p)) return 'windows';
      if (/mac/.test(p)) return 'mac';
      if (/linux/.test(p) || /android/.test(p) || /chrom/.test(p)) return 'linux';
    }
  } catch {}
  return detectOS();
}

const SCRIPT_PATHS = {
  windows: 'setup/install-jat-app-windows.ps1',
  mac: 'setup/install-jat-app-mac.sh',
  linux: 'setup/install-jat-app-linux.sh'
};

const RUN_COMMANDS = {
  windows: 'powershell -ExecutionPolicy Bypass -File install-jat-app-windows.ps1',
  mac: 'bash install-jat-app-mac.sh',
  linux: 'bash install-jat-app-linux.sh'
};

// Map an OS to the prebuilt-installer artifact(s) we ship in setup/.
// Linux has two — we prefer AppImage but expose both if present.
const BUNDLED_INSTALLERS = {
  windows: [{ file: 'setup/JAT-v9-setup.exe', label: 'Windows installer (.exe)', hint: 'Double-click after the download finishes.' }],
  mac:     [{ file: 'setup/JAT-v9.pkg',       label: 'macOS installer (.pkg)',   hint: 'Double-click after the download finishes.' }],
  linux:   [
    { file: 'setup/JAT-v9.AppImage', label: 'Linux AppImage', hint: 'After download: chmod +x JAT-v9.AppImage && ./JAT-v9.AppImage' },
    { file: 'setup/JAT-v9.deb',      label: 'Debian/Ubuntu .deb',  hint: 'After download: sudo dpkg -i JAT-v9.deb' }
  ]
};

// v8: GitHub Releases artifacts — looked up via settings.releasesBaseUrl.
// File naming matches what .github/workflows/release.yml produces.
const RELEASE_FILES = {
  windows: { name: 'JAT-v9-setup.exe', label: 'Windows installer (.exe)', hint: 'Double-click after the download finishes.' },
  mac:     { name: 'JAT-v9.dmg',       label: 'macOS disk image (.dmg)',  hint: 'Open the DMG and drag the app to Applications.' },
  linux:   { name: 'JAT-v9.AppImage',  label: 'Linux AppImage',           hint: 'chmod +x then ./JAT-v9.AppImage' }
};

// Probe GitHub Releases for the OS-specific installer. Returns { url, label, hint } or null.
// CORS blocks direct fetch from the extension page, so we ask the background
// service worker (which can call api.github.com freely) to check the release.
async function probeRelease(os, releasesBaseUrl) {
  if (!releasesBaseUrl) return null;
  const f = RELEASE_FILES[os];
  if (!f) return null;
  const url = `${releasesBaseUrl.replace(/\/+$/, '')}/${f.name}`;
  try {
    const r = await new Promise((res) => chrome.runtime.sendMessage(
      { type: 'probe-release-asset', data: { releasesBaseUrl, fileName: f.name } },
      res
    ));
    if (r?.ok && r.exists) return { ...f, url };
  } catch {}
  // If the probe fails for any reason, fall back to optimistic: assume the
  // URL exists. chrome.downloads.download will surface a clear error if not.
  return { ...f, url };
}

// Per-render cache of which bundled installers actually exist (HEAD-checked).
let _bundledCache = null; // { os: [{file,label,hint,url}, ...] }

async function probeBundled(os) {
  if (_bundledCache && _bundledCache._os === os) return _bundledCache.items;
  const candidates = BUNDLED_INSTALLERS[os] || [];
  const found = [];
  for (const c of candidates) {
    const url = chrome.runtime.getURL(c.file);
    try {
      const r = await fetch(url, { method: 'HEAD' });
      if (r.ok) found.push({ ...c, url });
    } catch { /* not present */ }
  }
  _bundledCache = { _os: os, items: found };
  return found;
}

export function render(state) {
  const os = state.installAppOS || detectOS();
  const status = state.appHealth || { ok: false, reason: 'Probing…' };
  const step = state.installAppStep || 1;
  const scriptUrl = chrome.runtime.getURL(SCRIPT_PATHS[os]);
  const cmd = RUN_COMMANDS[os];
  const bundled = state.bundledInstallers || [];
  const hasBundled = bundled.length > 0;
  const paired = !!status.ok;

  return `
    <div class="page-h">
      <div>
        <h1>🖥️ Install desktop app</h1>
        <div class="sub">Optional but powerful. The desktop app runs locally and syncs over <code>localhost:7733</code> in real time.</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <span class="pill ${status.ok ? 'offer' : 'rejected'}">${status.ok ? '✓ App detected' : '⚠ App not running'}</span>
        ${paired ? `<button class="btn primary" id="launch-app" title="Open the desktop app via the jat9:// URL handler">🚀 Launch app</button>` : ''}
        <button class="btn" id="reinstall-app-btn" title="Downloads the latest installer to re-install over the existing app">🔁 Reinstall app</button>
      </div>
    </div>

    ${!paired ? `
      <div class="card" style="margin-bottom:14px;background:linear-gradient(135deg,rgba(99,102,241,0.10),rgba(236,72,153,0.06));border:2px solid var(--primary)">
        <h2 style="margin:0 0 6px;font-size:18px">🚀 One-click install</h2>
        <p style="color:var(--muted);font-size:13px;margin:0 0 14px">
          Detected OS: <strong>${escape(os.toUpperCase())}</strong>. Click below — we download the prebuilt installer for your OS and you double-click to install. No source code or Node.js required.
        </p>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <button class="btn primary" id="one-click-install" style="font-size:15px;padding:12px 20px">⚡ Install with one click</button>
          <small style="color:var(--muted)">Native installer · ${os === 'windows' ? '.exe' : os === 'mac' ? '.dmg' : '.AppImage'}</small>
        </div>
        ${state.settings?.releasesBaseUrl ? `
          <details style="margin-top:10px;font-size:12px;color:var(--muted)">
            <summary style="cursor:pointer">Where does the installer come from?</summary>
            <p style="margin:6px 0 0">
              From your GitHub Releases page: <code>${escape(state.settings.releasesBaseUrl)}</code>.<br>
              Change this in Settings → Advanced if you self-host.
            </p>
          </details>
        ` : `
          <div class="card" style="margin-top:12px;background:rgba(245,158,11,0.10);border:1px solid var(--warn,#f59e0b);font-size:12px">
            <strong style="color:var(--warn,#f59e0b)">⚠ Releases URL not configured.</strong>
            <p style="margin:6px 0 0;color:var(--muted)">
              To enable true one-click installs, host the installers on GitHub Releases and paste the URL in
              <a href="#/settings" style="color:var(--primary)">Settings → Advanced</a>. See <code>RELEASING.md</code> in the repo for the 4-step setup.
              <br><br>
              Until that's set, the button falls back to the script-based install (requires Node.js).
            </p>
          </div>
        `}
      </div>

      <!-- v9.0.0: clean-slate reinstall path for users with a broken old install -->
      <div class="card" style="margin-top:14px;border:1px solid var(--border);background:transparent">
        <details>
          <summary style="cursor:pointer;font-size:13px;font-weight:600">🧹 App won't open? Reset to a clean state</summary>
          <p style="margin:8px 0 4px;font-size:12px;color:var(--muted);line-height:1.6">
            If an older version of the desktop app is installed and crashes on launch, download the clean-uninstall script
            for your OS, run it once, then click the install button above. It will:
          </p>
          <ul style="margin:4px 0 8px 18px;font-size:12px;color:var(--muted);line-height:1.6">
            <li>Stop any running JAT processes</li>
            <li>Run the NSIS uninstaller (Windows) or remove the app bundle (Mac/Linux)</li>
            <li>Wipe leftover settings + database from <code>userData</code></li>
            <li>Free port <code>7733</code></li>
            <li>Remove desktop / Start menu shortcuts</li>
          </ul>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <a class="btn small" href="${escape(chrome.runtime.getURL('setup/clean-uninstall-jat.ps1'))}" download="clean-uninstall-jat.ps1">⬇ Windows (.ps1)</a>
            <a class="btn small" href="${escape(chrome.runtime.getURL('setup/clean-uninstall-jat-mac.sh'))}" download="clean-uninstall-jat-mac.sh">⬇ macOS (.sh)</a>
            <a class="btn small" href="${escape(chrome.runtime.getURL('setup/clean-uninstall-jat-linux.sh'))}" download="clean-uninstall-jat-linux.sh">⬇ Linux (.sh)</a>
            <button class="btn small" id="copy-uninstall-cmd">Copy run command</button>
          </div>
          <p style="margin:8px 0 0;font-size:11px;color:var(--muted)">Then run <code>powershell -ExecutionPolicy Bypass -File clean-uninstall-jat.ps1</code> from your Downloads folder.</p>
        </details>
      </div>
    ` : ''}

    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        ${[1,2,3,4].map((s) => `
          <div style="flex:1;min-width:140px;padding:10px;border-radius:8px;border:2px solid ${s === step ? 'var(--primary)' : 'var(--border)'};background:${s === step ? 'rgba(99,102,241,0.08)' : 'transparent'};text-align:center">
            <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em">Step ${s}</div>
            <div style="font-size:13px;font-weight:600;margin-top:4px">${['Choose OS', 'Download installer', 'Run it', 'Pair'][s - 1]}</div>
          </div>
        `).join('')}
      </div>

      ${step === 1 ? `
        <h3 style="margin-top:0;font-size:14px">Pick your operating system</h3>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px">
          ${[
            ['windows', '🪟', 'Windows', 'Tested on Windows 10/11'],
            ['mac', '🍎', 'macOS', 'Intel & Apple Silicon'],
            ['linux', '🐧', 'Linux', 'Ubuntu / Fedora / Arch']
          ].map(([id, ico, label, desc]) => `
            <div data-pick-os="${id}" style="padding:14px;border:2px solid ${os === id ? 'var(--primary)' : 'var(--border)'};border-radius:10px;cursor:pointer;text-align:center;background:${os === id ? 'rgba(99,102,241,0.08)' : 'transparent'}">
              <div style="font-size:32px">${ico}</div>
              <strong style="display:block;margin-top:6px">${label}</strong>
              <small style="color:var(--muted);font-size:11px">${desc}</small>
            </div>
          `).join('')}
        </div>
        <button class="btn primary" id="install-next">Next →</button>
      ` : ''}

      ${step === 2 ? `
        <h3 style="margin-top:0;font-size:14px">Get the installer</h3>

        ${hasBundled ? `
          <div style="padding:14px;border:2px solid var(--primary);border-radius:10px;margin-bottom:14px;background:rgba(99,102,241,0.08)">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span style="font-size:20px">📦</span>
              <strong style="font-size:14px">Bundled installer ready</strong>
              <span class="pill offer" style="margin-left:auto">Recommended</span>
            </div>
            <p style="color:var(--muted);font-size:13px;margin:6px 0 10px">A prebuilt installer ships inside this extension. One click downloads it, then you double-click to install. No build tools, no terminal.</p>
            <div style="display:flex;flex-direction:column;gap:8px">
              ${bundled.map((b, i) => `
                <div style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg)">
                  <div style="flex:1">
                    <strong style="display:block;font-size:13px">${escape(b.label)}</strong>
                    <small style="color:var(--muted);font-size:11px">${escape(b.hint)}</small>
                  </div>
                  <button class="btn primary" data-bundled-index="${i}">⬇ Run bundled installer</button>
                </div>
              `).join('')}
            </div>
            <p style="color:var(--muted);font-size:12px;margin:10px 0 0">Then run the file from your Downloads folder.</p>
          </div>
        ` : `
          <div style="padding:14px;border:2px solid var(--primary);border-radius:10px;margin-bottom:14px;background:rgba(99,102,241,0.06)">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span style="font-size:20px">⚡</span>
              <strong style="font-size:14px">Quick install via script</strong>
            </div>
            <p style="color:var(--muted);font-size:13px;margin:6px 0 10px">
              No prebuilt installer is bundled (it's only present after running the build pipeline).
              Use the install script instead: it downloads dependencies and starts the app for you.
              You'll need <a href="https://nodejs.org/" target="_blank" rel="noreferrer" style="color:var(--primary)">Node.js 18+</a>
              ${os === 'windows' ? ` and <a href="https://visualstudio.microsoft.com/visual-cpp-build-tools/" target="_blank" rel="noreferrer" style="color:var(--primary)">VS Build Tools</a>` : ''}
              installed first.
            </p>
            <div style="display:flex;flex-direction:column;gap:8px">
              <div style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg)">
                <div style="flex:1">
                  <strong style="display:block;font-size:13px">${escape(SCRIPT_PATHS[os].split('/').pop())}</strong>
                  <small style="color:var(--muted);font-size:11px">Auto-detects your <code>v9/app</code> folder, runs npm install, starts the app.</small>
                </div>
                <a class="btn primary" href="${escape(scriptUrl)}" download="${escape(SCRIPT_PATHS[os].split('/').pop())}">⬇ Download script</a>
              </div>
            </div>
            <p style="color:var(--muted);font-size:12px;margin:10px 0 0">After download, see step 3 for the run command.</p>
          </div>
        `}

        <details ${hasBundled ? '' : 'open'} style="margin-top:6px">
          <summary style="cursor:pointer;color:var(--primary);font-size:13px">Manual install via npm (advanced / fallback)</summary>
          <div style="padding:10px;font-size:13px;color:var(--muted);border-left:2px solid var(--border);margin:8px 0 0 6px">
            <p>Download the source-build script, then run the command shown in step 3. It will check prerequisites (Node.js, build tools), pull the desktop app source, run <code>npm install</code> + auto-rebuild native modules, and start the app.</p>
            <div style="margin:10px 0">
              <a class="btn" href="${scriptUrl}" download="${SCRIPT_PATHS[os].split('/').pop()}">⬇ Download script for ${os}</a>
              <button class="btn" id="install-view-script" style="margin-left:6px">View source</button>
            </div>
          </div>
        </details>

        <div style="display:flex;gap:6px;margin-top:14px">
          <button class="btn" id="install-back">← Back</button>
          <button class="btn primary" id="install-next">Next →</button>
        </div>
      ` : ''}

      ${step === 3 ? `
        <h3 style="margin-top:0;font-size:14px">Run the installer</h3>
        ${hasBundled ? `
          <p style="color:var(--muted);font-size:13px">Open your <strong>Downloads</strong> folder and double-click <code>${escape(bundled[0].file.split('/').pop())}</code>. Walk through the prompts. The app will launch automatically when finished.</p>
        ` : `
          <p style="color:var(--muted);font-size:13px">Open a terminal in the folder where you saved the script, then run:</p>
          <div style="position:relative;background:var(--bg);padding:14px;border:1px solid var(--border);border-radius:8px;margin:10px 0;font-family:ui-monospace,Consolas,monospace;font-size:13px">
            ${escape(cmd)}
            <button class="btn small" id="copy-cmd" style="position:absolute;top:8px;right:8px">Copy</button>
          </div>
          <p style="color:var(--muted);font-size:13px">The first run takes 1–3 minutes (npm install + native rebuild). The app window pops up automatically when ready.</p>
        `}
        <details style="margin-top:10px">
          <summary style="cursor:pointer;color:var(--primary);font-size:13px">Manual install (clone & npm)</summary>
          <div style="padding:10px;font-size:13px;color:var(--muted)">
            <p>Clone or copy the <code>v9/app/</code> directory anywhere, then:</p>
            <pre style="background:var(--bg);padding:10px;border-radius:6px;font-size:12px">cd v9/app
npm install
npm start</pre>
            <p>The <code>postinstall</code> hook runs <code>electron-rebuild</code> automatically to compile <code>better-sqlite3</code> against Electron's Node version.</p>
          </div>
        </details>
        <div style="margin-top:14px;display:flex;gap:6px">
          <button class="btn" id="install-back">← Back</button>
          <button class="btn primary" id="install-next">I ran it →</button>
        </div>
      ` : ''}

      ${step === 4 ? `
        <h3 style="margin-top:0;font-size:14px">Pair with the desktop app</h3>
        <div style="padding:14px;border:1px solid var(--border);border-radius:8px;margin-bottom:14px;background:${status.ok ? 'rgba(16,185,129,0.06)' : 'rgba(245,158,11,0.06)'};border-color:${status.ok ? 'var(--success)' : 'var(--warn)'}">
          <div style="font-size:14px;font-weight:600;margin-bottom:4px">
            ${status.ok ? `✓ Desktop app is online (v${escape(status.version || '?')})` : '⏳ Waiting for the desktop app at localhost:7733…'}
          </div>
          <div style="font-size:12px;color:var(--muted)">
            ${status.ok
              ? `Click "Pair now" to exchange a sync token. From then on every change syncs instantly.`
              : `Make sure the app is running. The wizard re-checks every 2 seconds. ${status.reason ? `Last error: ${escape(status.reason)}` : ''}`}
          </div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn" id="install-back">← Back</button>
          <button class="btn primary" id="install-pair" ${status.ok ? '' : 'disabled'}>${state.pairing ? 'Pairing…' : 'Pair now'}</button>
          <button class="btn" id="install-recheck">Re-check now</button>
        </div>
      ` : ''}
    </div>

    <div class="card">
      <h3 style="margin-top:0;font-size:14px">What you unlock with the desktop app</h3>
      <div class="grid-2">
        ${[
          ['🔄 Real-time sync', 'WebSocket pushes changes between extension and app instantly — no refresh, no manual sync.'],
          ['👁️ Folder watching', 'Drop a resume into a watched folder and it appears in the Documents page within seconds.'],
          ['🤖 Background AI', 'Long AI calls keep running even when the extension service worker hibernates.'],
          ['🔍 Full-text search', 'SQLite FTS over every job description, message, note, cover letter.'],
          ['📅 Native calendar', 'Hooks into your OS calendar (Google, Outlook, Apple) to surface interviews directly.'],
          ['🌐 Headless source scrapers', 'Sync your full LinkedIn / Indeed / Glassdoor profile and applied-job history without keeping tabs open.']
        ].map(([t, d]) => `
          <div style="padding:12px;border:1px solid var(--border);border-radius:8px">
            <strong style="display:block;font-size:13px;margin-bottom:4px">${t}</strong>
            <small style="color:var(--muted);font-size:12px;line-height:1.5">${d}</small>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function escape(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

export function attach($main, ctx) {
  const { state, send, render: rerender, toast } = ctx;

  function startPolling() {
    if (pollTimer) return; // v8 fix: never stack timers
    pollTimer = setInterval(async () => {
      try {
        const r = await send('probe-app-health');
        if (!r?.health) return;
        const prevOk = state.appHealth?.ok;
        state.appHealth = r.health;
        let stepChanged = false;
        if (r.health.ok && (state.installAppStep || 1) < 4) {
          state.installAppStep = 4; stepChanged = true;
        }
        // v9.0.0: rerender ONLY when ok flips or step changes. The 'reason'
        // text flaps between transient strings (ECONNREFUSED / timeout etc.)
        // when the app is offline; rerendering on every flap was the
        // user-visible "page refreshes itself" bug.
        if (prevOk !== r.health.ok || stepChanged) rerender();
      } catch {}
    }, 2000);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } _mounted = false; _osDetectionRequested = false; _bundledProbeInFlight = false; _bundledOsProbed = null; }

  // Probe for bundled installers for the current OS, then re-render.
  // Guarded against re-entrancy and against re-probing the same OS.
  async function refreshBundled(force = false) {
    if (_bundledProbeInFlight) return;
    const os = state.installAppOS || detectOS();
    if (!force && _bundledOsProbed === os) return; // already done for this OS
    _bundledProbeInFlight = true;
    try {
      const items = await probeBundled(os);
      _bundledOsProbed = os;
      // Only rerender if the result changed
      const prev = JSON.stringify(state.bundledInstallers || []);
      const next = JSON.stringify(items);
      state.bundledInstallers = items;
      if (prev !== next) rerender();
    } finally { _bundledProbeInFlight = false; }
  }

  // Run one-time setup only on first attach for this mount.
  if (!_mounted) {
    _mounted = true;
    // Async OS detection — only fire once per mount
    if (!state.installAppOS && !_osDetectionRequested) {
      _osDetectionRequested = true;
      detectOSAsync().then((os) => {
        if (!state.installAppOS && os !== detectOS()) {
          state.installAppOS = os;
          _bundledCache = null;
          _bundledOsProbed = null;
          refreshBundled(true);
        }
      });
    }
    refreshBundled();
    startPolling();
    send('probe-app-health').then((r) => {
      if (r?.health) {
        const changed = (state.appHealth?.ok !== r.health.ok);
        state.appHealth = r.health;
        if (changed) rerender();
      }
    });
  }

  $main.querySelectorAll('[data-pick-os]').forEach((el) => el.addEventListener('click', () => {
    state.installAppOS = el.dataset.pickOs;
    _bundledCache = null; // OS changed — re-probe
    _bundledOsProbed = null;
    refreshBundled(true);
    rerender();
  }));

  // Bundled-installer "Run" buttons: download via chrome.downloads.
  $main.querySelectorAll('[data-bundled-index]').forEach((el) => el.addEventListener('click', async () => {
    const idx = Number(el.dataset.bundledIndex);
    const item = (state.bundledInstallers || [])[idx];
    if (!item) return;
    el.disabled = true;
    const orig = el.textContent;
    el.textContent = '⬇ Downloading…';
    try {
      await new Promise((resolve, reject) => {
        chrome.downloads.download(
          { url: item.url, saveAs: false, conflictAction: 'overwrite' },
          (id) => {
            const err = chrome.runtime.lastError;
            if (err || !id) reject(new Error(err?.message || 'download failed'));
            else resolve(id);
          }
        );
      });
      toast('✓ Installer downloaded. Open your Downloads folder and run it.', 'success');
      // Auto-advance to step 3 (run instructions)
      state.installAppStep = 3;
      rerender();
    } catch (e) {
      toast(`Download failed: ${e.message || e}`, 'danger');
      el.disabled = false;
      el.textContent = orig;
    }
  }));

  // v8: One-click install — preference order:
  //   1. GitHub Release installer (true one-click — just download & double-click)
  //   2. Locally bundled installer (.exe / .dmg / .AppImage in setup/)
  //   3. Script + bundled source (fallback for dev builds)
  $main.querySelector('#one-click-install')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const os2 = state.installAppOS || detectOS();
    const scriptName = SCRIPT_PATHS[os2].split('/').pop();
    const url = chrome.runtime.getURL(SCRIPT_PATHS[os2]);
    btn.disabled = true; btn.textContent = '⬇ Checking releases…';
    try {
      // Path 1: GitHub Release
      const releasesBaseUrl = state.settings?.releasesBaseUrl;
      const release = await probeRelease(os2, releasesBaseUrl);
      if (release) {
        btn.textContent = '⬇ Downloading installer…';
        await new Promise((res, rej) => {
          chrome.downloads.download({ url: release.url, filename: release.name, saveAs: false, conflictAction: 'overwrite' }, (id) => {
            const err = chrome.runtime.lastError;
            if (err || !id) rej(new Error(err?.message || 'download failed')); else res(id);
          });
        });
        toast(`✓ ${release.label} downloading. ${release.hint}`, 'success', 8000);
        state.installAppStep = 3;
        rerender();
        return;
      }
      // Path 2: bundled installer (setup/JAT-v9-setup.exe etc.)
      btn.textContent = '⬇ Checking bundle…';
      const installers = await probeBundled(os2);
      if (installers.length > 0) {
        btn.textContent = '⬇ Downloading installer…';
        await new Promise((res, rej) => {
          chrome.downloads.download({ url: installers[0].url, saveAs: false, conflictAction: 'overwrite' }, (id) => {
            const err = chrome.runtime.lastError;
            if (err || !id) rej(new Error(err?.message || 'download failed')); else res(id);
          });
        });
        toast(`✓ ${installers[0].label} downloading. ${installers[0].hint}`, 'success', 8000);
        state.installAppStep = 3;
        rerender();
        return;
      }
      // Fallback path: download the script + the bundled app source files into
      // a single folder so the script can find everything without internet.
      btn.textContent = '⬇ Downloading app bundle…';
      try {
        // Download bundled source files (ships inside the extension at setup/jat-app-bundle/).
        // Static manifest — we ship known files.
        const bundleFiles = [
          'setup/jat-app-bundle/package.json',
          'setup/jat-app-bundle/src/main.js',
          'setup/jat-app-bundle/src/db.js',
          'setup/jat-app-bundle/src/server.js',
          'setup/jat-app-bundle/src/preload.js',
          'setup/jat-app-bundle/src/index.html'
        ];
        for (const f of bundleFiles) {
          const fileUrl = chrome.runtime.getURL(f);
          try {
            // HEAD-check so we only attempt files that actually exist.
            const head = await fetch(fileUrl, { method: 'HEAD' });
            if (!head.ok) continue;
            const relPath = f.replace('setup/jat-app-bundle/', '');
            await new Promise((res) => {
              chrome.downloads.download(
                { url: fileUrl, filename: `jat-app-bundle/${relPath}`, saveAs: false, conflictAction: 'overwrite' },
                () => res()
              );
            });
          } catch {}
        }
      } catch {}
      btn.textContent = '⬇ Downloading installer…';
      await new Promise((res, rej) => {
        chrome.downloads.download({ url, filename: scriptName, saveAs: false, conflictAction: 'overwrite' }, (id) => {
          const err = chrome.runtime.lastError;
          if (err || !id) rej(new Error(err?.message || 'download failed')); else res(id);
        });
      });
      try { await navigator.clipboard.writeText(RUN_COMMANDS[os2]); } catch {}
      state.installAppStep = 3;
      rerender();
      toast(`✓ Bundle + script downloaded. Run command copied to clipboard — paste into terminal.`, 'success', 8000);
    } catch (err) {
      toast(`Download failed: ${err.message || err}`, 'danger');
    } finally {
      btn.disabled = false; btn.textContent = '⚡ Install with one click';
    }
  });

  // v9.0.0: copy the clean-uninstall run command
  $main.querySelector('#copy-uninstall-cmd')?.addEventListener('click', async (e) => {
    const os3 = state.installAppOS || detectOS();
    const cmd = os3 === 'windows'
      ? 'powershell -ExecutionPolicy Bypass -File clean-uninstall-jat.ps1'
      : os3 === 'mac' ? 'bash clean-uninstall-jat-mac.sh'
      : 'bash clean-uninstall-jat-linux.sh';
    try { await navigator.clipboard.writeText(cmd); e.currentTarget.textContent = '✓ Copied'; setTimeout(() => { e.currentTarget.textContent = 'Copy run command'; }, 2000); }
    catch { toast('Copy failed.', 'danger'); }
  });

  // v9.0.0: one-click reinstall — downloads latest installer over the existing one.
  $main.querySelector('#reinstall-app-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const os2 = state.installAppOS || detectOS();
    const release = state.settings?.releasesBaseUrl ? await probeRelease(os2, state.settings.releasesBaseUrl) : null;
    if (!release) {
      toast('Could not find installer on GitHub Releases. Check your internet.', 'danger');
      return;
    }
    btn.disabled = true; const orig = btn.textContent; btn.textContent = '⬇ Downloading…';
    try {
      await new Promise((res, rej) => {
        chrome.downloads.download({ url: release.url, filename: release.name, saveAs: false, conflictAction: 'overwrite' }, (id) => {
          const err = chrome.runtime.lastError;
          if (err || !id) rej(new Error(err?.message || 'download failed')); else res(id);
        });
      });
      toast(`✓ ${release.label} downloaded. Open your Downloads folder and double-click it to reinstall.`, 'success', 10000);
    } catch (err) {
      toast(`Download failed: ${err.message || err}`, 'danger');
    } finally { btn.disabled = false; btn.textContent = orig; }
  });

  $main.querySelector('#launch-app')?.addEventListener('click', () => {
    send('launch-app');
    toast('Launching desktop app…', 'success');
  });
  $main.querySelector('#install-next')?.addEventListener('click', () => {
    state.installAppStep = Math.min(4, (state.installAppStep || 1) + 1);
    rerender();
  });
  $main.querySelector('#install-back')?.addEventListener('click', () => {
    state.installAppStep = Math.max(1, (state.installAppStep || 1) - 1);
    rerender();
  });
  $main.querySelector('#install-view-script')?.addEventListener('click', () => {
    const url = chrome.runtime.getURL(SCRIPT_PATHS[state.installAppOS || detectOS()]);
    chrome.tabs?.create?.({ url }) || window.open(url, '_blank');
  });
  $main.querySelector('#copy-cmd')?.addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(RUN_COMMANDS[state.installAppOS || detectOS()]);
      e.target.textContent = '✓ Copied';
      setTimeout(() => e.target.textContent = 'Copy', 1500);
    } catch { toast('Copy failed.', 'danger'); }
  });
  $main.querySelector('#install-recheck')?.addEventListener('click', async () => {
    const r = await send('probe-app-health');
    state.appHealth = r?.health || { ok: false, reason: 'Probe failed' };
    rerender();
  });
  $main.querySelector('#install-pair')?.addEventListener('click', async () => {
    if (!state.appHealth?.ok) return;
    state.pairing = true; rerender();
    const r = await send('pair-with-app');
    state.pairing = false;
    if (r?.ok) {
      toast('✓ Paired! Real-time sync active.', 'success');
      stopPolling();
      location.hash = '#/';
    } else {
      toast(`Pair failed: ${r?.error || 'unknown'}`, 'danger');
    }
    rerender();
  });

  // Clean up timers + mount flag when navigating away. Guard so it's only
  // bound once across re-attaches; otherwise the listener stacks too.
  if (!window.__installAppHashHookBound) {
    window.__installAppHashHookBound = true;
    window.addEventListener('hashchange', () => {
      if (!location.hash.startsWith('#/install-app')) {
        stopPolling();
        window.__installAppHashHookBound = false;
      }
    });
  }
}
