// Backup & Export page. Exports a JSON snapshot of every IDB store, settings,
// profile, and named profiles. Optional AES-GCM passphrase encryption via
// SubtleCrypto (PBKDF2-derived key). Also handles import (with confirmation)
// and the auto-backup schedule toggles.
import { db, openDB } from '../../lib/db.js';

const send = (type, data) => new Promise((res) => chrome.runtime.sendMessage({ type, data }, res));

function escape(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

const local = {
  busy: false,
  lastResult: null,
  importPreview: null,    // { plan: [{store, count}], filename }
  importPayload: null,    // parsed JSON ready to apply
  importEncrypted: false,
  importPasswordNeeded: false
};

async function listStoreNames() {
  const dbi = await openDB();
  return Array.from(dbi.objectStoreNames);
}

async function snapshotEverything() {
  const stores = await listStoreNames();
  const data = {};
  for (const s of stores) {
    try { data[s] = await db.getAll(s); } catch { data[s] = []; }
  }
  // Settings + profile + named profiles already live in IDB ('namedProfiles')
  // and chrome.storage. Pull from chrome.storage too.
  const cs = await chrome.storage.local.get(null);
  return {
    version: 6,
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    chromeStorage: cs || {},
    indexedDB: data
  };
}

async function deriveKey(passphrase, salt) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), { name: 'PBKDF2' }, false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptSnapshot(json, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const enc = new TextEncoder();
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(json));
  return {
    encrypted: true,
    algo: 'AES-GCM',
    kdf: 'PBKDF2-SHA256-200000',
    salt: btoa(String.fromCharCode(...salt)),
    iv: btoa(String.fromCharCode(...iv)),
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(cipher)))
  };
}

async function decryptSnapshot(envelope, passphrase) {
  const salt = Uint8Array.from(atob(envelope.salt), (c) => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(envelope.iv), (c) => c.charCodeAt(0));
  const ct = Uint8Array.from(atob(envelope.ciphertext), (c) => c.charCodeAt(0));
  const key = await deriveKey(passphrase, salt);
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(dec));
}

function downloadBlob(content, filename, mime = 'application/json') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function render(state) {
  const s = state.settings || {};
  return `
    <div class="page-h">
      <div><h1>💾 Backup &amp; export</h1><div class="sub">Snapshot every store, settings, and profile. Optional AES-GCM encryption.</div></div>
    </div>
    ${local.lastResult ? `<div class="card" style="margin-bottom:14px;border-color:var(--success)"><strong style="color:var(--success)">${escape(local.lastResult)}</strong></div>` : ''}
    <div class="grid-2">
      <div class="card">
        <h3 style="margin-top:0;font-size:14px">Export</h3>
        <p style="font-size:12px;color:var(--muted);margin:6px 0 12px">Downloads <code>jat8-backup-YYYY-MM-DD.json</code> with every IDB store and the contents of <code>chrome.storage.local</code>.</p>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:8px">
          <input type="checkbox" id="b-encrypt" /> Encrypt with passphrase (AES-GCM, PBKDF2 200k)
        </label>
        <input type="password" id="b-pass" placeholder="Passphrase (only used if encryption is on)" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);margin-bottom:10px" />
        <button class="btn primary" id="backup-export" ${local.busy ? 'disabled' : ''}>${local.busy ? 'Working…' : 'Export everything'}</button>
      </div>
      <div class="card">
        <h3 style="margin-top:0;font-size:14px">Import</h3>
        <p style="font-size:12px;color:var(--muted);margin:6px 0 12px">Restores a previously exported JSON file. Encrypted backups will prompt for the passphrase.</p>
        <input type="file" id="b-file" accept="application/json,.json" style="margin-bottom:10px" />
        ${local.importPasswordNeeded ? `
          <input type="password" id="b-imppass" placeholder="Passphrase for this backup" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);margin-bottom:10px" />
          <button class="btn" id="b-imp-decrypt">Decrypt &amp; preview</button>
        ` : ''}
        ${local.importPreview ? `
          <div style="margin-top:10px;padding:10px;background:rgba(99,102,241,0.06);border-radius:8px">
            <strong style="font-size:12px">Will restore from <code>${escape(local.importPreview.filename)}</code>:</strong>
            <ul style="font-size:11px;color:var(--muted);margin:6px 0 0;padding-left:18px;max-height:140px;overflow:auto">
              ${local.importPreview.plan.map((p) => `<li>${escape(p.store)} — ${p.count} row${p.count === 1 ? '' : 's'}</li>`).join('')}
            </ul>
            <div style="margin-top:10px;display:flex;gap:8px">
              <button class="btn primary" id="b-imp-confirm">Restore (overwrites existing data)</button>
              <button class="btn" id="b-imp-cancel">Cancel</button>
            </div>
          </div>
        ` : ''}
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0;font-size:14px">Auto backup</h3>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:8px">
        <input type="checkbox" id="b-auto" ${s.autoBackupEnabled ? 'checked' : ''} /> Schedule automatic exports
      </label>
      <label style="font-size:12px;color:var(--muted)">Interval (days)
        <input type="number" id="b-interval" min="1" max="90" value="${escape(s.autoBackupIntervalDays || 7)}" style="width:80px;padding:6px;margin-left:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text)" />
      </label>
      <div style="margin-top:10px"><button class="btn" id="b-auto-save">Save schedule</button></div>
      <p style="font-size:11px;color:var(--muted);margin-top:10px">Note: scheduled exports run in the background and trigger a download dialog when due.</p>
    </div>
  `;
}

export function attach($main, state) {
  const rerender = () => state.__rerender && state.__rerender();

  document.getElementById('backup-export')?.addEventListener('click', async () => {
    local.busy = true; local.lastResult = null; rerender();
    try {
      const snap = await snapshotEverything();
      const json = JSON.stringify(snap, null, 2);
      let payload = json;
      const wantEncrypt = document.getElementById('b-encrypt')?.checked;
      const pass = document.getElementById('b-pass')?.value || '';
      if (wantEncrypt) {
        if (!pass) throw new Error('Passphrase required for encrypted export');
        const env = await encryptSnapshot(json, pass);
        payload = JSON.stringify(env, null, 2);
      }
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(payload, `jat8-backup-${stamp}.json`);
      local.lastResult = `Exported ${Object.keys(snap.indexedDB).length} stores${wantEncrypt ? ' (encrypted)' : ''}.`;
    } catch (e) {
      local.lastResult = `Export failed: ${e.message || e}`;
    } finally {
      local.busy = false; rerender();
    }
  });

  document.getElementById('b-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (parsed && parsed.encrypted && parsed.ciphertext) {
        local.importEncrypted = true;
        local.importPasswordNeeded = true;
        local.importPayload = parsed;
        local.importPreview = null;
        local._filename = file.name;
      } else {
        local.importEncrypted = false;
        local.importPasswordNeeded = false;
        local.importPayload = parsed;
        local.importPreview = makePlan(parsed, file.name);
      }
    } catch (err) {
      local.lastResult = `Import parse failed: ${err.message || err}`;
    }
    rerender();
  });

  document.getElementById('b-imp-decrypt')?.addEventListener('click', async () => {
    const pass = document.getElementById('b-imppass')?.value || '';
    if (!pass) return;
    try {
      const decoded = await decryptSnapshot(local.importPayload, pass);
      local.importPayload = decoded;
      local.importPasswordNeeded = false;
      local.importPreview = makePlan(decoded, local._filename || 'backup.json');
    } catch (e) {
      local.lastResult = `Decrypt failed: ${e.message || e}`;
    }
    rerender();
  });

  document.getElementById('b-imp-cancel')?.addEventListener('click', () => {
    local.importPayload = null; local.importPreview = null; local.importPasswordNeeded = false;
    rerender();
  });

  document.getElementById('b-imp-confirm')?.addEventListener('click', async () => {
    if (!local.importPayload) return;
    if (!confirm('This will overwrite existing data in every restored store. Continue?')) return;
    local.busy = true; rerender();
    try {
      await applySnapshot(local.importPayload);
      local.lastResult = 'Restore complete. Reload the page to see all changes.';
      local.importPayload = null; local.importPreview = null;
    } catch (e) {
      local.lastResult = `Restore failed: ${e.message || e}`;
    } finally {
      local.busy = false; rerender();
    }
  });

  document.getElementById('b-auto-save')?.addEventListener('click', async () => {
    const enabled = document.getElementById('b-auto')?.checked;
    const days = parseInt(document.getElementById('b-interval')?.value || '7', 10);
    await send('patch-settings', { autoBackupEnabled: !!enabled, autoBackupIntervalDays: Math.max(1, Math.min(90, days)) });
    local.lastResult = 'Schedule saved.';
    rerender();
  });
}

function makePlan(parsed, filename) {
  const idb = parsed?.indexedDB || {};
  const plan = Object.entries(idb).map(([store, rows]) => ({ store, count: Array.isArray(rows) ? rows.length : 0 }));
  // Show chrome.storage as a meta entry
  if (parsed?.chromeStorage) plan.push({ store: 'chrome.storage.local', count: Object.keys(parsed.chromeStorage).length });
  return { plan: plan.sort((a, b) => a.store.localeCompare(b.store)), filename };
}

async function applySnapshot(parsed) {
  const idb = parsed?.indexedDB || {};
  const stores = await listStoreNames();
  for (const [name, rows] of Object.entries(idb)) {
    if (!stores.includes(name)) continue;
    if (!Array.isArray(rows)) continue;
    try { await db.clear(name); } catch {}
    for (const row of rows) {
      try { await db.put(name, row); } catch {}
    }
  }
  if (parsed?.chromeStorage && typeof parsed.chromeStorage === 'object') {
    try { await chrome.storage.local.set(parsed.chromeStorage); } catch {}
  }
}
