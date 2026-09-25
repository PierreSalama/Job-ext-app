// Minimal CDP driver. Node 24 ships a global WebSocket, so this needs no dependencies at all.
//
// Usage (run ON the laptop, CDP is loopback-only by design):
//   node cdp.mjs targets
//   node cdp.mjs open  <url>
//   node cdp.mjs eval  <targetId|first> <expression>
//   node cdp.mjs title <url>          open, wait for load, print the title, close
//   node cdp.mjs shot  <url> <file>   open, screenshot the PAGE (works while the box is locked)
const PORT = process.env.CDP_PORT || 9223;
const BASE = `http://127.0.0.1:${PORT}`;

const j = async (p) => (await fetch(BASE + p)).json();

function send(ws, id, method, params = {}, sessionId) {
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
}

// One request/response round trip against a target's own websocket.
function withTarget(wsUrl, fn) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let next = 1;
    const call = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = next++;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('cdp timeout')); }, 60000);
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('ws error ' + e.message)); });
    ws.addEventListener('open', async () => {
      try { const out = await fn(call); clearTimeout(timer); ws.close(); resolve(out); }
      catch (e) { clearTimeout(timer); try { ws.close(); } catch {} reject(e); }
    });
  });
}

const [cmd, a, b] = process.argv.slice(2);

if (cmd === 'targets') {
  const list = await j('/json/list');
  for (const t of list) {
    console.log(`${t.type.padEnd(15)} ${String(t.title).slice(0, 40).padEnd(42)} ${String(t.url).slice(0, 70)}`);
  }
  console.log(`\n${list.length} target(s)`);
} else if (cmd === 'open') {
  const t = await (await fetch(`${BASE}/json/new?${encodeURIComponent(a)}`, { method: 'PUT' })).json();
  console.log('opened', t.id, t.url);
} else if (cmd === 'title' || cmd === 'shot') {
  const t = await (await fetch(`${BASE}/json/new?${encodeURIComponent(a)}`, { method: 'PUT' })).json();
  try {
    const out = await withTarget(t.webSocketDebuggerUrl, async (call) => {
      await call('Page.enable');
      await call('Runtime.enable');
      // give the navigation a moment; about:blank -> real page
      await new Promise((r) => setTimeout(r, 4000));
      const title = await call('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
      const url = await call('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
      const res = { title: title.result.value, url: url.result.value };
      if (cmd === 'shot') {
        const png = await call('Page.captureScreenshot', { format: 'png' });
        const fs = await import('node:fs');
        fs.writeFileSync(b, Buffer.from(png.data, 'base64'));
        res.file = b;
        res.bytes = fs.statSync(b).size;
      }
      return res;
    });
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await fetch(`${BASE}/json/close/${t.id}`).catch(() => {});
  }
} else if (cmd === 'eval') {
  const list = await j('/json/list');
  const t = a === 'first' ? list.find((x) => x.type === 'page') : list.find((x) => x.id === a);
  if (!t) { console.error('no such target'); process.exit(1); }
  const out = await withTarget(t.webSocketDebuggerUrl, async (call) => {
    await call('Runtime.enable');
    const r = await call('Runtime.evaluate', { expression: b, returnByValue: true, awaitPromise: true });
    return r.result;
  });
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('commands: targets | open <url> | title <url> | shot <url> <file> | eval <targetId|first> <expr>');
}
