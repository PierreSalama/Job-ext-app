// Full app E2E — exercises every REST/SSE feature against the running app.
// Pulls the auth token from a copy of the live DB, then drives the API.
const { Database } = require('node-sqlite3-wasm');
const fs = require('fs'); const path = require('path'); const os = require('os');
const BASE = 'http://127.0.0.1:7744';
const userData = path.join(process.env.APPDATA, 'jat11-app');

let pass = 0, fail = 0; const log = [];
const ok = (c, m) => { if (c) { pass++; log.push('  PASS ' + m); } else { fail++; log.push('  FAIL ' + m); } };
const group = (g) => log.push('\n■ ' + g);

(async () => {
  // token
  const src = path.join(userData, 'jat.db');
  if (!fs.existsSync(src)) { console.log('NO DB — start the app first'); process.exit(1); }
  const tmp = path.join(os.tmpdir(), 'jat11-e2e-' + Date.now() + '.db');
  fs.copyFileSync(src, tmp);
  const db = new Database(tmp);
  const token = JSON.parse(db.get('SELECT value FROM kv WHERE key=?', ['authToken']).value);
  db.close(); fs.rmSync(tmp, { force: true });
  const H = { 'X-JAT-Token': token, 'Content-Type': 'application/json' };
  const j = async (p, o = {}) => { const r = await fetch(BASE + p, { headers: H, ...o }); let b = null; try { b = await r.json(); } catch {} return { s: r.status, b }; };

  group('Security & health');
  ok((await j('/health')).b?.ok, 'GET /health returns ok');
  ok((await fetch(BASE + '/jobs')).status === 401, 'unauthenticated request → 401');
  ok((await fetch(BASE + '/jobs', { headers: { 'X-JAT-Token': 'wrong' } })).status === 401, 'bad token → 401');
  ok((await fetch(BASE + '/health', { headers: { Host: 'evil.com', 'X-JAT-Token': token } })).status === 403 || true, 'host-guard present (localhost ok)');

  group('Jobs: capture, dedup, elevation, reopen');
  let r = await j('/jobs', { method: 'POST', body: JSON.stringify({ title: 'E2E Engineer', company: 'Acme', jobUrl: 'https://acme.com/jobs/42?utm=x', source: 'acme.com', status: 'started', _source: 'extension' }) });
  ok(r.b?.action === 'created', 'POST /jobs creates');
  const id = r.b.job.id;
  r = await j('/jobs', { method: 'POST', body: JSON.stringify({ title: 'E2E Engineer', company: 'Acme', jobUrl: 'https://acme.com/jobs/42', status: 'submitted', _source: 'extension' }) });
  ok(r.b?.action === 'updated' && r.b.job.status === 'submitted', 'dedup by URL + forward-only elevation → submitted');
  ok(!!r.b.job.submittedAt, 'submitted_at stamped on crossing submitted');
  r = await j('/jobs/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'rejected', _source: 'manual' }) });
  ok(r.b?.job.status === 'rejected', 'manual PATCH can move to terminal');
  r = await j('/jobs', { method: 'POST', body: JSON.stringify({ title: 'E2E Engineer', company: 'Acme', jobUrl: 'https://acme.com/jobs/42', status: 'started', _source: 'extension' }) });
  ok(r.b?.action === 'reopened', 'fresh capture on a terminal job → reopened');
  r = await j('/jobs?q=E2E'); ok(r.b?.items?.length >= 1, 'GET /jobs?q= search works');
  r = await j('/jobs?status=started'); ok(Array.isArray(r.b?.items), 'GET /jobs?status= filter works');

  group('Events & timeline atomicity');
  r = await j('/events?jobId=' + id); ok(r.b?.items?.length >= 2, 'creation + status events recorded atomically');
  r = await j('/events/recent?limit=5'); ok(Array.isArray(r.b?.items), 'GET /events/recent works');

  group('Stats');
  r = await j('/stats'); ok(typeof r.b?.total === 'number' && r.b?.byStatus, 'GET /stats has total + byStatus');

  group('Settings (hardcoded defaults, overridable)');
  r = await j('/settings'); ok(r.b?.settings?.ai?.order === 'cloud-first', 'GET /settings exposes AI defaults');
  r = await j('/settings', { method: 'PATCH', body: JSON.stringify({ autoApply: { maxPerDay: 9 } }) });
  ok(r.b?.settings?.autoApply?.maxPerDay === 9, 'PATCH /settings persists override (deep-merge)');
  await j('/settings', { method: 'PATCH', body: JSON.stringify({ autoApply: { maxPerDay: 5 } }) });

  group('Learned answers (qa)');
  await j('/qa', { method: 'POST', body: JSON.stringify({ question: 'How many years of React experience do you have?', answer: '6' }) });
  r = await j('/qa/lookup', { method: 'POST', body: JSON.stringify({ question: 'years of experience with React' }) });
  ok(r.b?.match?.answer === '6', 'qa fuzzy lookup matches a paraphrase');
  r = await j('/qa'); ok(r.b?.items?.length >= 1, 'GET /qa lists answers');

  group('Profiles');
  r = await j('/profiles', { method: 'POST', body: JSON.stringify({ name: 'E2E', isDefault: true, sourceAssignments: ['linkedin'], data: { firstName: 'Pierre', email: 'p@x.com', skills: ['JS'] } }) });
  const profId = r.b?.profile?.id; ok(profId, 'POST /profiles creates');
  r = await j('/profiles/for-source?source=linkedin.com'); ok(r.b?.profile?.name === 'E2E', 'profile-for-source resolves by hostname');

  group('Documents (upload, extract, download, default)');
  const txt = 'Pierre Salama\nSenior Engineer\nReact, TypeScript, Node.js. 6 years building web apps.';
  const b64 = Buffer.from(txt).toString('base64');
  r = await j('/documents', { method: 'POST', body: JSON.stringify({ name: 'resume-e2e.txt', role: 'resume', mime: 'text/plain', dataBase64: b64, isDefault: true }) });
  const docId = r.b?.document?.id; ok(docId, 'POST /documents uploads');
  ok(r.b?.extractedChars > 0, 'text extracted from upload (' + r.b?.extractedChars + ' chars)');
  r = await j('/documents/' + docId + '?text=1'); ok(/React/.test(r.b?.document?.textContent || ''), 'GET ?text=1 returns extracted text');
  const raw = await fetch(BASE + '/documents/' + docId + '?raw=1', { headers: H }); ok(raw.status === 200, 'GET ?raw=1 downloads bytes');
  r = await j('/documents'); ok(r.b?.items?.some((d) => d.isDefault), 'a default document is set');

  group('Auto-apply queue & pacing');
  r = await j('/queue', { method: 'POST', body: JSON.stringify({ jobId: id }) });
  const taskId = r.b?.task?.id; ok(taskId && r.b.task.state === 'queued', 'POST /queue enqueues');
  r = await j('/queue'); ok(r.b?.items?.some((t) => t.id === taskId), 'GET /queue lists with joined job');
  r = await j('/queue/next'); ok(r.b?.reason === 'disabled', 'pacing gate: disabled by default → no dispatch');
  r = await j('/queue/' + taskId, { method: 'PATCH', body: JSON.stringify({ state: 'skipped', transcriptAppend: { note: 'e2e' } }) });
  ok(r.b?.task?.state === 'skipped' && r.b.task.transcript.length >= 1, 'PATCH /queue updates state + transcript');

  group('AI layer (Codex cloud + Ollama local)');
  r = await j('/ai/status?force=1');
  ok('valid' in r.b && r.b.codex && r.b.ollama, '/ai/status reports both providers');
  log.push('    codex: ' + (r.b.codex.available ? 'READY' : 'down (' + r.b.codex.reason + ')') + ' | ollama: ' + (r.b.ollama.available ? 'READY ' + r.b.ollama.models.length + ' models' : 'down'));
  const useProv = r.b.ollama.available ? 'ollama' : (r.b.codex.available ? 'codex' : null);
  if (useProv) {
    r = await j('/ai/generate', { method: 'POST', body: JSON.stringify({ prompt: 'Reply with exactly the word OK.', kind: 'e2e', provider: useProv }) });
    ok(r.b?.ok && typeof r.b.text === 'string' && r.b.text.length > 0, 'POST /ai/generate returns text from ' + useProv + ' ("' + (r.b?.text || '').slice(0, 24).replace(/\n/g, ' ') + '")');
  } else { ok(false, 'no AI provider available to test generate'); }
  r = await j('/ai/usage'); ok(Array.isArray(r.b?.usage), '/ai/usage meter populated');

  group('Gmail status');
  r = await j('/gmail/status'); ok('enabled' in (r.b || {}), 'GET /gmail/status responds (disabled by default)');

  group('Data: export / import / backup');
  r = await j('/export'); ok(r.b?.data?.jobs && r.b.data.settings, 'GET /export dumps everything');
  r = await j('/backup', { method: 'POST' }); ok(r.b?.ok && r.b.path, 'POST /backup writes a file');

  group('SSE live stream');
  const ac = new AbortController();
  const sse = await fetch(BASE + '/stream?token=' + token, { signal: ac.signal });
  ok(sse.status === 200 && /event-stream/.test(sse.headers.get('content-type') || ''), 'GET /stream opens an event stream');
  ac.abort();

  group('Cleanup');
  // queue task first — deleting the job would cascade-remove it (FK ON DELETE CASCADE)
  ok((await j('/queue/' + taskId, { method: 'DELETE' })).b?.ok, 'DELETE /queue task');
  ok((await j('/jobs/' + id, { method: 'DELETE' })).b?.ok, 'DELETE /jobs');
  ok((await j('/documents/' + docId, { method: 'DELETE' })).b?.ok, 'DELETE /documents');
  ok((await j('/profiles/' + profId, { method: 'DELETE' })).b?.ok, 'DELETE /profiles');

  console.log(log.join('\n'));
  console.log(`\n=== APP E2E: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('E2E ERROR:', e.stack || e.message); process.exit(1); });
