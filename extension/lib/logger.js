// Unified logger — used by background.js, app/app.js, and indirectly by
// content scripts (which post 'log' messages to background which call
// writeLog). All entries land in IndexedDB `logs` store; broadcast
// 'log.new' so the app page's Logs view updates in realtime.

import { db, broadcast } from './db.js';

const MAX_LOGS = 25_000; // generous cap; we rotate older entries on every write batch

let writeQueue = Promise.resolve();
let pendingRotate = 0;

export async function writeLog(level, ctx, message, data) {
  const entry = {
    id: cryptoUuid(),
    timestamp: new Date().toISOString(),
    level: String(level || 'info'),
    ctx: String(ctx || 'app'),
    message: String(message ?? ''),
    data: serializeData(data)
  };

  // Queue writes so concurrent log calls don't overlap
  writeQueue = writeQueue.then(async () => {
    try {
      await db.put('logs', entry);
    } catch (e) {
      console.error('[JAT:logger] IDB write failed', e);
    }
    // Periodically rotate (every 200 writes)
    pendingRotate++;
    if (pendingRotate >= 200) {
      pendingRotate = 0;
      try {
        const all = await db.getAll('logs');
        if (all.length > MAX_LOGS) {
          all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
          const drop = all.slice(0, all.length - MAX_LOGS);
          for (const d of drop) await db.delete('logs', d.id);
        }
      } catch {}
    }
  });

  // Mirror to console so the in-page DevTools shows it too
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'debug' ? console.debug : console.log;
  fn(`[JAT:${ctx}]`, message, data || '');

  // Broadcast for live UI update (don't await — fire and forget)
  broadcast('log.new', { entry }).catch(() => {});

  return entry;
}

function cryptoUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function serializeData(data) {
  if (data == null) return null;
  if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') return data;
  try {
    // Strip enormous fields and DOM nodes
    const seen = new WeakSet();
    return JSON.parse(JSON.stringify(data, (k, v) => {
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
        if (v instanceof Element || v instanceof Node) return `[Element ${v.nodeName || ''}]`;
        if (v instanceof Blob) return `[Blob ${v.size}b ${v.type || ''}]`;
      }
      if (typeof v === 'string' && v.length > 2000) return v.slice(0, 2000) + `…(+${v.length - 2000})`;
      return v;
    }));
  } catch {
    return String(data);
  }
}

export const log = {
  debug: (ctx, msg, data) => writeLog('debug', ctx, msg, data),
  info: (ctx, msg, data) => writeLog('info', ctx, msg, data),
  warn: (ctx, msg, data) => writeLog('warn', ctx, msg, data),
  error: (ctx, msg, data) => writeLog('error', ctx, msg, data)
};
