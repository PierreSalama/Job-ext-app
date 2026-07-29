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

// Open a CDP websocket. Returns { send(method, params) → Promise<result>, close() }.
function openCdp(wsUrl, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;
    const to = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP connect timeout')); }, timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(to);
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { try { ws.close(); } catch {} },
      });
    });
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || 'CDP error')); else res(msg.result);
      }
    });
    ws.addEventListener('error', () => { clearTimeout(to); reject(new Error('CDP websocket error')); });
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
