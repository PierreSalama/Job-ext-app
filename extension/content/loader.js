// JAT v10 — content script loader.
// Runs on every page (via manifest content_scripts matches: <all_urls>).
// Dynamically imports detector.js so the actual work can be ES modules
// (with static imports between signal files). Stays minimal in case the
// page is something the detector decides to ignore.

(async () => {
  if (window.__jat10_loaded) return;
  window.__jat10_loaded = true;
  try {
    await import(chrome.runtime.getURL('content/detector.js'));
  } catch (e) {
    console.warn('[JAT v10] detector load failed', e);
  }
})();
