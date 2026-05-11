// v8: Crash-recovery autosave. Watches inputs/textareas marked with
// data-autosave="<kind>:<id>" and persists their values to the drafts store
// every N ms. On page load, restores any saved drafts.
const send = (type, data) => new Promise((res) => chrome.runtime.sendMessage({ type, data }, res));

let _interval = 1500;
let _enabled = true;
let _pending = new Map();
let _timer = null;

export function configureAutosave({ enabled, intervalMs }) {
  _enabled = enabled !== false;
  if (intervalMs && intervalMs >= 500) _interval = intervalMs;
}

function flush() {
  if (_pending.size === 0) return;
  const batch = [..._pending.entries()];
  _pending.clear();
  for (const [key, value] of batch) {
    try {
      const [kind, id] = key.split('::', 2);
      send('save-draft', { id: key, kind, ownerId: id, value, updatedAt: new Date().toISOString() });
    } catch {}
  }
}

export function attachAutosave(root = document) {
  if (!_enabled) return;
  const els = root.querySelectorAll('[data-autosave]');
  for (const el of els) {
    const key = el.dataset.autosave;
    if (!key || el._autosaveBound) continue;
    el._autosaveBound = true;
    el.addEventListener('input', () => {
      _pending.set(key, el.value || '');
      if (_timer) clearTimeout(_timer);
      _timer = setTimeout(flush, _interval);
    });
  }
}

export async function restoreDrafts(root = document) {
  if (!_enabled) return;
  try {
    const r = await send('list-drafts', {});
    if (!r?.ok) return;
    const map = new Map(r.items.map((d) => [d.id, d]));
    const els = root.querySelectorAll('[data-autosave]');
    for (const el of els) {
      const key = el.dataset.autosave;
      const saved = map.get(key);
      if (saved && saved.value && !el.value) {
        el.value = saved.value;
        el.dispatchEvent(new Event('change'));
      }
    }
  } catch {}
}

// Manually clear a draft (e.g. after save)
export async function clearDraft(key) {
  try { await send('delete-draft', { id: key }); } catch {}
}

// Flush on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
}
