// JAT v10 desktop renderer. Polls its own /health endpoint so the user can see
// the server is up before the extension is even installed.

(async () => {
  const el = document.getElementById('health-status');
  try {
    const r = await fetch('http://localhost:7744/health');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    el.textContent = `ok · v${body.version}`;
    el.classList.add('ok');
  } catch (e) {
    el.textContent = String(e?.message || e);
    el.classList.add('bad');
  }
})();
