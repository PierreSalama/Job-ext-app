// MV3 content script entry. Uses dynamic import() so universal.js + adapters
// can be ES modules (with static `import` between them) while running in the
// extension's isolated world (where chrome.* APIs work).
(async () => {
  if (window.__jat5_loaded) return;
  window.__jat5_loaded = true;
  try {
    await import(chrome.runtime.getURL('content/universal.js'));
  } catch (e) {
    console.error('[JAT5:loader] Failed to import universal.js', e);
  }
  // v9.0.1: side-features — loaded as ES modules into the isolated world so
  // chrome.* APIs work. resume-tailor-prompt.js exposes window.__jat_tailor_show;
  // auto-apply.js listens for 'start-auto-apply' messages.
  try { await import(chrome.runtime.getURL('content/resume-tailor-prompt.js')); }
  catch (e) { console.warn('[JAT:tailor-prompt] load failed', e); }
  try { await import(chrome.runtime.getURL('content/auto-apply.js')); }
  catch (e) { console.warn('[JAT:auto-apply] load failed', e); }
})();
