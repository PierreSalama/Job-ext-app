// JAT v10 content script — LinkedIn only.
// Skeleton: logs presence to the page console. No DOM injection, no tabs
// opened, no messages sent to background unless explicitly added later.
// This is the smallest possible content script that proves manifest matching
// + execution are working before any feature is layered on.

(() => {
  if (window.__jat10_loaded) return;
  window.__jat10_loaded = true;
  console.log('[JAT v10] content script loaded on', location.href);
})();
