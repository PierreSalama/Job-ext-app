// Bridge between the MV3 extension and the desktop app's local server on
// :7733. Exposes a real-time WebSocket subscription for instant fan-out of
// mutations in either direction. No external deps — uses the standard
// browser WebSocket API.
//
// Lifecycle:
//   - probe /health on an interval (default 5s)
//   - when healthy, open ws://localhost:7733/ws
//   - on disconnect, exponential backoff to retry
//
// Event shapes match background.js broadcast names: job.created, job.updated,
// job.deleted, settings.updated, profile.updated, etc.

const DEFAULT_HOST = 'localhost:7733';

export class SyncClient {
  constructor({ host = DEFAULT_HOST, intervalSeconds = 5, onEvent, onStatus, log } = {}) {
    this.host = host;
    this.intervalMs = Math.max(1, intervalSeconds) * 1000;
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.log = log || ((..._a) => {});
    this.ws = null;
    this.healthy = false;
    this.connected = false;
    this.backoffMs = 1000;
    this.maxBackoffMs = 30000;
    this._healthTimer = null;
    this._reconnectTimer = null;
    this._stopped = false;
    // Tag every push with a short id so the server (and re-broadcast loop) can
    // recognize our own echoes if we ever decide to suppress them.
    this.clientId = 'ext-' + Math.random().toString(36).slice(2, 10);
    // Keep a recent set of dispatched event hashes so we can drop echoes that
    // come back via the ws fan-out and would otherwise re-apply our own change.
    this._recentlyPushed = new Map(); // hash -> ts
  }

  setIntervalSeconds(secs) {
    this.intervalMs = Math.max(1, secs) * 1000;
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = setInterval(() => this._probe(), this.intervalMs);
    }
  }

  start() {
    this._stopped = false;
    this._probe();
    this._healthTimer = setInterval(() => this._probe(), this.intervalMs);
  }

  stop() {
    this._stopped = true;
    if (this._healthTimer) clearInterval(this._healthTimer);
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._healthTimer = null;
    this._reconnectTimer = null;
    this._closeWs();
  }

  isHealthy() { return this.healthy; }
  isConnected() { return this.connected; }

  async _probe() {
    try {
      const r = await fetch(`http://${this.host}/health`, { method: 'GET', signal: AbortSignal.timeout(2000) });
      const ok = r.ok;
      this._setHealthy(ok);
      if (ok && !this.connected && !this._reconnectTimer) this._connect();
    } catch {
      this._setHealthy(false);
    }
  }

  _setHealthy(ok) {
    if (this.healthy === ok) return;
    this.healthy = ok;
    this.onStatus({ healthy: ok, connected: this.connected });
  }

  _connect() {
    try {
      this._closeWs();
      const ws = new WebSocket(`ws://${this.host}/ws`);
      this.ws = ws;
      ws.addEventListener('open', () => {
        this.connected = true;
        this.backoffMs = 1000;
        this.onStatus({ healthy: this.healthy, connected: true });
        this.log('sync', 'WebSocket connected');
      });
      ws.addEventListener('message', (e) => {
        let msg = null;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (!msg || msg.type !== 'event') return;
        // Drop our own recent echoes
        const h = this._hash(msg.name, msg.data);
        if (this._recentlyPushed.has(h)) return;
        try { this.onEvent(msg.name, msg.data); }
        catch (err) { this.log('sync', 'onEvent threw: ' + (err?.message || err)); }
      });
      ws.addEventListener('close', () => {
        this.connected = false;
        this.onStatus({ healthy: this.healthy, connected: false });
        this._scheduleReconnect();
      });
      ws.addEventListener('error', () => {
        // close fires after error; nothing extra to do
      });
    } catch (e) {
      this.log('sync', 'WebSocket connect failed: ' + (e?.message || e));
      this._scheduleReconnect();
    }
  }

  _closeWs() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    if (this._reconnectTimer) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      // Only attempt if still healthy — otherwise let the probe re-detect.
      if (this.healthy) this._connect();
    }, wait);
  }

  // Push a local mutation up to the desktop app.
  async pushChange(name, data) {
    if (!this.healthy) return { ok: false, reason: 'offline' };
    const h = this._hash(name, data);
    this._recentlyPushed.set(h, Date.now());
    // GC the dedup map (keep last 30s)
    if (this._recentlyPushed.size > 200) {
      const cutoff = Date.now() - 30000;
      for (const [k, t] of this._recentlyPushed) if (t < cutoff) this._recentlyPushed.delete(k);
    }
    try {
      const r = await fetch(`http://${this.host}/sync/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: this.clientId, name, data }),
        signal: AbortSignal.timeout(5000)
      });
      return await r.json().catch(() => ({ ok: r.ok }));
    } catch (e) {
      return { ok: false, reason: String(e?.message || e) };
    }
  }

  // Initial snapshot from the desktop app
  async fetchSnapshot() {
    if (!this.healthy) return null;
    try {
      const r = await fetch(`http://${this.host}/api/snapshot`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  _hash(name, data) {
    // Cheap stable-ish hash of name + key fields. Doesn't need to be perfect
    // — just enough to recognize our own push echoes within ~5s.
    const id = data?.job?.id || data?.id || data?.profile?.email || data?.settings?.theme || '';
    const updatedAt = data?.job?.updatedAt || data?.profile?.updatedAt || '';
    return `${name}|${id}|${updatedAt}`;
  }
}
