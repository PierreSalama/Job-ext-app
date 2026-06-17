// JAT v11 — content loader. Permanent, tiny, runs in EVERY frame.
//
// v10's fatal flaw: all watchers lived inside the detector, which only booted
// if the FIRST page load looked like a job page — so LinkedIn feed → job
// navigation was never seen. v11 keeps this loader resident on every page:
//  • listens for SW messages (reboot on SPA nav, capture-now, run-task)
//  • cheap plausibility sentinel that lazy-imports the engine when job-ish
//    signals appear (URL, apply text, file inputs, forms mounting later)
//  • respects the per-host suppress list ("Not a job — don't ask again here")
//
// The heavy engine (detector.js + signals) loads at most once per frame.

(() => {
  if (window.__jat11_loaded) return;
  window.__jat11_loaded = true;

  const IS_TOP = window === window.top;
  let enginePromise = null;
  let suppressed = false;
  let lastHref = location.href;

  const JOBBY_URL_RX = /\/(jobs?|careers?|viewjob|apply|application|postings?|openings?|positions?|vacanc|requisition|smartapply|easy-apply)/i;
  const JOBBY_TEXT_RX = /\b(easy apply|apply now|postuler|job description|submit application|upload (your )?resume|cover letter)\b/i;

  chrome.storage.local.get('jat11.suppressHosts').then((s) => {
    const list = s['jat11.suppressHosts'] || [];
    suppressed = list.includes(location.hostname);
  }).catch(() => {});

  function ensureEngine() {
    if (!enginePromise) {
      enginePromise = import(chrome.runtime.getURL('content/detector.js'))
        .then((mod) => { mod.init(); return mod; })
        .catch((e) => { console.warn('[JAT v11] engine load failed', e); enginePromise = null; return null; });
    }
    return enginePromise;
  }

  function plausible() {
    if (JOBBY_URL_RX.test(location.href)) return true;
    if (document.querySelector('input[type="file"]')) return true;
    const title = document.title || '';
    if (/\b(job|apply|career|hiring|position|opening)\b/i.test(title)) return true;
    const text = (document.body?.innerText || '').slice(0, 3000);
    return JOBBY_TEXT_RX.test(text);
  }

  async function maybeBoot(reason) {
    if (suppressed) return;
    if (!plausible()) return;
    const engine = await ensureEngine();
    engine?.reboot(reason);
  }

  // ---- SW messages ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'jat11.reboot') {
      // Resolve the engine before responding so the reboot actually runs, and
      // keep the message port open (return true) for the async sendResponse.
      if (suppressed) { sendResponse({ ok: true, suppressed: true }); return true; }
      ensureEngine()
        .then((engine) => engine?.reboot('webNavigation'))
        .finally(() => { try { sendResponse({ ok: true }); } catch {} });
      return true;
    }
    if (msg?.type === 'jat11.capture-now') {
      // Explicit user action overrides suppression.
      ensureEngine().then(async (engine) => {
        if (!engine) return sendResponse({ ok: false, error: 'engine failed to load' });
        sendResponse(await engine.captureNow({ manual: !!msg.manual }));
      });
      return true;
    }
    if (msg?.type === 'jat11.page-state') {
      // Lightweight: report what the engine currently sees without forcing a load.
      if (!enginePromise) { sendResponse({ loaded: false, plausible: plausible(), suppressed }); return; }
      enginePromise.then((engine) => sendResponse(engine ? engine.getPageState() : { loaded: false }));
      return true;
    }
    if (msg?.type === 'jat11.run-task') {
      if (!IS_TOP) { sendResponse({ ok: false, error: 'not top frame' }); return; }
      ensureEngine().then(async (engine) => {
        if (!engine) return sendResponse({ ok: false, error: 'engine failed to load' });
        sendResponse(await engine.runTask(msg.task, msg.context));
      });
      return true;
    }
    // "Watch & Teach" — start a SUPERVISED apply (Step/Run overlay + on-page Fix-this
    // picker). Same executor path as run-task, but flagged supervised so the visible,
    // gateable step loop runs (never the silent auto-replay fast path). [T4]
    if (msg?.type === 'jat11.supervised-run') {
      if (!IS_TOP) { sendResponse({ ok: false, error: 'not top frame' }); return; }
      ensureEngine().then(async (engine) => {
        if (!engine) return sendResponse({ ok: false, error: 'engine failed to load' });
        const task = { ...(msg.task || {}), mode: 'supervised' };
        const context = { ...(msg.context || {}), supervised: true };
        sendResponse(await engine.runTask(task, context));
      });
      return true;
    }
    if (msg?.type === 'jat11.discover-search') {
      if (!IS_TOP) { sendResponse({ ok: false, error: 'not top frame' }); return; }
      ensureEngine().then(async (engine) => {
        if (!engine || !engine.runDiscover) return sendResponse({ ok: false, error: 'engine failed to load', jobs: [] });
        sendResponse(await engine.runDiscover({ source: msg.source, max: msg.max, easyApplyOnly: msg.easyApplyOnly !== false }));
      });
      return true;
    }
    if (msg?.type === 'jat11.sync-applied') {
      if (!IS_TOP) { sendResponse({ ok: false, error: 'not top frame' }); return; }
      import(chrome.runtime.getURL('content/applied-sync.js'))
        .then((m) => m.run({ source: msg.source, max: msg.max }))
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e), jobs: [] }));
      return true;
    }
  });

  // ---- URL watcher (belt-and-braces beside webNavigation) ----
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    maybeBoot('url-change');
  }, 1500);

  // ---- late-mounting forms sentinel (cheap, debounced) ----
  let debounce = null;
  let checks = 0;
  const sentinel = new MutationObserver(() => {
    if (enginePromise || suppressed) { sentinel.disconnect(); return; }
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (checks++ > 40) { sentinel.disconnect(); return; }
      maybeBoot('mutation');
    }, 1000);
  });
  try {
    sentinel.observe(document.documentElement, { childList: true, subtree: true });
  } catch {}

  // initial
  maybeBoot('load');
})();
