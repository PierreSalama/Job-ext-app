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
})();
