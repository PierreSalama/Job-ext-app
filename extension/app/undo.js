// Undo manager — keeps a stack of restorable snapshots for destructive actions.
// Each snapshot is { kind, label, payload, ts } where payload is whatever data
// is needed to recreate the deleted/changed entity. Restoration is delegated
// back to a `send()` style messaging function so we don't reach into the DB
// directly from the page.
//
// In-memory stack is the source of truth. We mirror the most recent N entries
// to chrome.storage.local so they survive page reloads.

const STORAGE_KEY = 'jat8.undoStack';
const MAX_STACK = 25;

let stack = [];
let _hydrated = false;

async function hydrate() {
  if (_hydrated) return;
  _hydrated = true;
  try {
    const v = await chrome.storage.local.get([STORAGE_KEY]);
    if (Array.isArray(v?.[STORAGE_KEY])) stack = v[STORAGE_KEY].slice(-MAX_STACK);
  } catch {}
}

async function persist() {
  try { await chrome.storage.local.set({ [STORAGE_KEY]: stack }); } catch {}
}

export async function pushUndo(snapshot) {
  await hydrate();
  const entry = {
    id: 'u-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    ts: new Date().toISOString(),
    ...snapshot
  };
  stack.push(entry);
  if (stack.length > MAX_STACK) stack = stack.slice(-MAX_STACK);
  persist();
  return entry;
}

export function peekUndo() {
  return stack.length ? stack[stack.length - 1] : null;
}

export async function popUndo() {
  await hydrate();
  const e = stack.pop();
  persist();
  return e || null;
}

export async function listUndo() {
  await hydrate();
  return stack.slice().reverse();
}

export async function clearUndo() {
  stack = [];
  persist();
}

// Apply an undo entry by routing back to background via the provided send().
// Snapshot kinds:
//   'job.delete'      payload = { job }                  → upsertJob(job)
//   'job.patch'       payload = { id, before }           → patch-job back
//   'document.delete' payload = { doc }                  → re-add-document
//   'note.delete'     payload = { note }                 → add-notes
//   'todo.delete'     payload = { todo }                 → add-todos
export async function applyUndo(entry, send) {
  if (!entry || !send) return { ok: false, error: 'no entry' };
  try {
    switch (entry.kind) {
      case 'job.delete': {
        const j = entry.payload?.job;
        if (!j) return { ok: false, error: 'no job snapshot' };
        // Strip server-side fields the upsert will rebuild
        const { timeline, updatedAt, ...rest } = j;
        const r = await send('capture', { ...rest, _source: 'undo' });
        return r || { ok: false };
      }
      case 'job.patch': {
        const { id, before } = entry.payload || {};
        if (!id || !before) return { ok: false, error: 'bad patch snapshot' };
        const r = await send('patch-job', { id, patch: before });
        return r || { ok: false };
      }
      case 'document.delete': {
        const d = entry.payload?.doc;
        if (!d) return { ok: false, error: 'no doc snapshot' };
        const r = await send('add-document', d);
        return r || { ok: false };
      }
      case 'note.delete': {
        const n = entry.payload?.note;
        if (!n) return { ok: false, error: 'no note snapshot' };
        const r = await send('add-notes', n);
        return r || { ok: false };
      }
      case 'todo.delete': {
        const t = entry.payload?.todo;
        if (!t) return { ok: false, error: 'no todo snapshot' };
        const r = await send('add-todos', t);
        return r || { ok: false };
      }
      default:
        return { ok: false, error: 'unknown kind: ' + entry.kind };
    }
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
