'use strict';
// ============================================================================
//  Session bridge (inject side)
//  Inject Dad's pulled LinkedIn cookies into a running Chrome's cookie store via CDP,
//  BEFORE it navigates — so the browser the extension drives is already logged in as Dad,
//  with no password and no new-device prompt.
//
//  Minimal CDP client over Node's built-in fetch + WebSocket (Node 22+) — no external deps.
//  Uses the browser-level Storage.setCookies, so no page/target juggling is needed.
// ============================================================================

// Normalize an extracted/pulled cookie into a CDP Network.CookieParam.
function toCdpCookieParam(c) {
  const p = {
    name: String(c.name),
    value: String(c.value),
    domain: String(c.domain),
    path: c.path || '/',
    secure: c.secure !== false,
    httpOnly: !!c.httpOnly,
  };
  if (c.sameSite === 'None' || c.sameSite === 'Lax' || c.sameSite === 'Strict') p.sameSite = c.sameSite;
  // Chrome silently drops SameSite=None cookies that are not Secure — force it (LinkedIn is https).
  if (p.sameSite === 'None') p.secure = true;
  if (c.expires) p.expires = Number(c.expires);
  return p;
}

async function cdpHttp(host, port, pathname) {
  const res = await fetch(`http://${host}:${port}${pathname}`);
  if (!res.ok) throw new Error(`CDP HTTP ${res.status} for ${pathname}`);
  return res.json();
}

// Minimal WebSocket frame codec (RFC 6455). Client→server frames MUST be masked; the CDP server
// sends unmasked text frames. Kept tiny — we only need text + close.
function encodeTextFrame(payloadBuf) {
  const len = payloadBuf.length;
  const mask = require('crypto').randomBytes(4);
  let header;
  if (len < 126) { header = Buffer.from([0x81, 0x80 | len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payloadBuf[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  let maskKey = null;
  if (masked) { if (buf.length < off + 4) return null; maskKey = buf.slice(off, off + 4); off += 4; }
  if (buf.length < off + len) return null;
  let payload = buf.slice(off, off + len);
  if (masked) { const p = Buffer.alloc(len); for (let i = 0; i < len; i++) p[i] = payload[i] ^ maskKey[i & 3]; payload = p; }
  return { opcode, payload, rest: buf.slice(off + len) };
}

// Open a CDP websocket over a raw TCP socket — no global WebSocket needed (Electron's main
// process doesn't expose one). Returns { send(method, params) → Promise<result>, close() }.
function openCdp(wsUrl, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(wsUrl); } catch { return reject(new Error('bad ws url')); }
    const net = require('net');
    const crypto = require('crypto');
    const host = u.hostname;
    const port = Number(u.port) || 80;
    const pathq = u.pathname + (u.search || '');
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(port, host);
    const pending = new Map();
    let nextId = 1;
    let handshaken = false;
    let buf = Buffer.alloc(0);
    const to = setTimeout(() => { try { sock.destroy(); } catch {} reject(new Error('CDP connect timeout')); }, timeoutMs);

    const api = {
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { res, rej });
          try { sock.write(encodeTextFrame(Buffer.from(JSON.stringify({ id, method, params }), 'utf8'))); }
          catch (e) { pending.delete(id); rej(e); }
        });
      },
      close() { try { sock.destroy(); } catch {} },
    };

    sock.on('connect', () => {
      sock.write(
        `GET ${pathq} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!handshaken) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const statusLine = buf.slice(0, idx).toString().split('\r\n')[0];
        if (!/\b101\b/.test(statusLine)) { clearTimeout(to); sock.destroy(); return reject(new Error('ws handshake failed: ' + statusLine)); }
        handshaken = true;
        buf = buf.slice(idx + 4);
        clearTimeout(to);
        resolve(api);
      }
      while (handshaken) {
        const frame = decodeFrame(buf);
        if (!frame) break;
        buf = frame.rest;
        if (frame.opcode === 1) {
          let msg; try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { continue; }
          if (msg.id && pending.has(msg.id)) {
            const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
            if (msg.error) rej(new Error(msg.error.message || 'CDP error')); else res(msg.result);
          }
        } else if (frame.opcode === 8) { try { sock.destroy(); } catch {} }
      }
    });
    sock.on('error', (e) => { clearTimeout(to); reject(new Error('CDP socket: ' + e.message)); });
  });
}

function isLinkedInDomain(domain) {
  const h = String(domain || '').replace(/^\./, '').toLowerCase();
  return h === 'linkedin.com' || h.endsWith('.linkedin.com');
}

// Inject cookies into the Chrome exposing --remote-debugging-port=<port>. When verify is on,
// re-reads the store and confirms li_at actually landed (so a caller knows the session is live).
async function injectLinkedInCookies({ host = '127.0.0.1', port, cookies, verify = true } = {}) {
  if (!port) return { ok: false, error: 'no CDP port' };
  if (!Array.isArray(cookies) || !cookies.length) return { ok: false, error: 'no cookies' };
  let ver;
  try { ver = await cdpHttp(host, port, '/json/version'); } catch (e) { return { ok: false, error: `CDP unreachable: ${e.message}` }; }
  if (!ver.webSocketDebuggerUrl) return { ok: false, error: 'no webSocketDebuggerUrl' };
  let cdp;
  try { cdp = await openCdp(ver.webSocketDebuggerUrl); } catch (e) { return { ok: false, error: e.message }; }
  try {
    const params = cookies.map(toCdpCookieParam);
    await cdp.send('Storage.setCookies', { cookies: params });
    if (!verify) return { ok: true, injected: params.length };
    const got = await cdp.send('Storage.getCookies', {});
    const li = (got.cookies || []).filter((c) => isLinkedInDomain(c.domain));
    const hasLiAt = li.some((c) => c.name === 'li_at' && c.value);
    return { ok: !!hasLiAt, injected: params.length, linkedInCookies: li.map((c) => c.name), hasLiAt };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally { cdp.close(); }
}

module.exports = { injectLinkedInCookies, toCdpCookieParam, openCdp, cdpHttp, isLinkedInDomain };
