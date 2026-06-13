// JAT v11 — onboarding wizard.
// Walks an extension-only user through: download the app → run the installer →
// auto-detect when it's running → auto-pair → done. A poller drives the
// transitions so the page advances itself no matter how the user installs.

const $ = (s) => document.querySelector(s);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }));

let stage = 'welcome';
let phase = 1;              // stepper phase 1..3
let downloadId = null;
let dlListener = null;
let pairing = false;
let done = false;

const STAGES = ['welcome', 'download', 'wait', 'done'];
function setStage(s) {
  stage = s;
  for (const x of STAGES) $('#stage-' + x).hidden = (x !== s);
}
function setPhase(p, allDone = false) {
  phase = p;
  document.querySelectorAll('.step').forEach((el) => {
    const n = Number(el.dataset.step);
    el.classList.toggle('active', !allDone && n === p);
    el.classList.toggle('done', allDone || n < p);
  });
}
function footer(online, paired) {
  const dot = $('#ft-dot'); const txt = $('#ft-text');
  if (paired && online) { dot.className = 'dot ok'; txt.textContent = 'Connected · app running'; }
  else if (online) { dot.className = 'dot ok'; txt.textContent = 'App detected · connecting…'; }
  else { dot.className = 'dot'; txt.textContent = 'Desktop app not running yet'; }
}
function dlStatus(msg, cls = '') { const el = $('#dl-status'); el.className = 'dl-status ' + cls; el.textContent = msg; }
function waitText(msg) { $('#waiter-text').textContent = msg; }

// ---------- the poller (drives auto-advance) ----------
async function poll() {
  if (done) return;
  const [health, tok] = await Promise.all([send({ type: 'app-health' }), send({ type: 'get-token' })]);
  const online = !!health?.ok;
  const paired = !!tok?.token;
  footer(online, paired);

  if (online && paired) { finish(); return; }

  if (online && !paired) {
    // App is up but not yet paired → move to connect + auto-pair.
    if (stage !== 'wait') setStage('wait');
    setPhase(3);
    $('#spinner').classList.remove('ok');
    if (downloadId) $('#wait-run').hidden = true;
    await tryPair();
    return;
  }

  // App not online yet.
  if (stage === 'wait') {
    setPhase(2);
    waitText(downloadId
      ? 'Installer downloaded. Run it (button below) and click through it — this page connects automatically.'
      : 'Looking for the desktop app… run the installer if you haven\'t yet.');
  }
}

async function tryPair() {
  if (pairing) return;
  pairing = true;
  waitText('Desktop app found! Click "Allow" in the app window to connect…');
  const r = await send({ type: 'pair-app' });   // blocks until Allow / Deny / timeout
  pairing = false;
  if (r?.ok) finish();
  else waitText('Connection wasn\'t approved yet — click "Allow" in the app window. Retrying…');
}

function finish() {
  if (done) return;
  done = true;
  setStage('done');
  setPhase(3, true);
  footer(true, true);
}

// ---------- download flow ----------
async function startDownload() {
  $('#btn-download').disabled = true;
  $('#dl-fallback').hidden = true;
  dlStatus('Finding the latest installer…');
  const info = await send({ type: 'get-installer-url' });
  if (!info?.ok) {
    dlStatus(info?.error || 'Could not reach the download.', 'bad');
    showFallback(info?.releasesUrl);
    $('#btn-download').disabled = false;
    // Still advance to waiting — once they install by any means, we connect.
    setTimeout(() => { if (!done) { setStage('wait'); setPhase(2); } }, 400);
    return;
  }
  $('#dl-progress').hidden = false;
  setBar(0.04);
  dlStatus('Downloading ' + info.fileName + '…');
  chrome.downloads.download(
    { url: info.url, filename: info.fileName, saveAs: false, conflictAction: 'overwrite' },
    (id) => {
      if (chrome.runtime.lastError || !id) {
        dlStatus(chrome.runtime.lastError?.message || 'Download failed.', 'bad');
        showFallback(info.releasesUrl);
        $('#btn-download').disabled = false;
        return;
      }
      downloadId = id;
      trackDownload(id);
    },
  );
}

function setBar(frac) { $('#dl-bar').style.width = Math.max(0, Math.min(1, frac)) * 100 + '%'; }

function trackDownload(id) {
  if (dlListener) chrome.downloads.onChanged.removeListener(dlListener);
  dlListener = (delta) => {
    if (delta.id !== id) return;
    if (delta.danger?.current && delta.danger.current !== 'safe' && delta.danger.current !== 'accepted') {
      dlStatus('Chrome flagged this download — click "Keep" if it asks.', '');
      try { chrome.downloads.acceptDanger(id, () => {}); } catch {}
    }
    if (delta.state?.current === 'complete') downloadComplete(id);
    if (delta.state?.current === 'interrupted') {
      dlStatus('Download interrupted. Try again, or use the link below.', 'bad');
      showFallback();
      $('#btn-download').disabled = false;
    }
  };
  chrome.downloads.onChanged.addListener(dlListener);

  const prog = setInterval(() => {
    chrome.downloads.search({ id }, (items) => {
      const it = items && items[0];
      if (!it) return;
      if (it.totalBytes > 0 && it.state === 'in_progress') setBar(it.bytesReceived / it.totalBytes);
      if (it.state === 'complete') { clearInterval(prog); downloadComplete(id); }
      if (it.state === 'interrupted') clearInterval(prog);
    });
  }, 400);
}

let completedOnce = false;
function downloadComplete(id) {
  if (completedOnce) return;
  completedOnce = true;
  setBar(1);
  dlStatus('Downloaded ✓ — now run the installer.', 'ok');
  $('#dl-run').hidden = false;
  $('#wait-run').hidden = false;
  // Show the connecting screen so the user sees we're now waiting for the app.
  setTimeout(() => { if (!done) { setStage('wait'); setPhase(2); waitText('Installer ready — click ▶ Run installer, then click through it.'); } }, 900);
}

function runInstaller() {
  if (!downloadId) return;
  try { chrome.downloads.open(downloadId); }
  catch { try { chrome.downloads.show(downloadId); } catch {} }
  // open() can be blocked for executables in some Chrome configs — give the
  // user the folder as a guaranteed fallback shortly after.
  setTimeout(() => {
    if (chrome.runtime.lastError) { try { chrome.downloads.show(downloadId); } catch {} }
  }, 60);
  if (!done) { setStage('wait'); setPhase(2); waitText('Installer launched — click through it (Next → Install → Finish). Connecting automatically…'); }
}

function showFallback(url) {
  $('#dl-fallback').hidden = false;
  const link = $('#fallback-link');
  if (url) link.href = url;
}

// ---------- wiring ----------
$('#go-download').addEventListener('click', () => { setStage('download'); setPhase(1); });
$('#already-have').addEventListener('click', () => { setStage('wait'); setPhase(2); });
$('#dl-back').addEventListener('click', () => { setStage('welcome'); setPhase(1); });
$('#btn-download').addEventListener('click', startDownload);
$('#btn-run').addEventListener('click', runInstaller);
$('#btn-show').addEventListener('click', () => { if (downloadId != null) chrome.downloads.show(downloadId); });
$('#wait-run').addEventListener('click', runInstaller);
$('#wait-launch').addEventListener('click', () => send({ type: 'launch-app' }));
$('#open-dash').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html') }));
$('#go-linkedin').addEventListener('click', () => chrome.tabs.create({ url: 'https://www.linkedin.com/jobs/' }));

// If the user closed the app after a prior pairing, offer a launch button.
send({ type: 'popup-state' }).then((st) => {
  if (st?.appInstalledButClosed) $('#wait-launch').hidden = false;
});

// ---------- boot ----------
setStage('welcome');
setPhase(1);
poll();
setInterval(poll, 1500);
