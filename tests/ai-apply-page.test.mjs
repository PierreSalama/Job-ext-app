// AI Apply chunk 3 — the runner, the HTTP surface, and the page shell.
//
// The runner is driven with a SCRIPTED model so lifecycle behaviour (one run per profile, the kill
// switch, SSE emission, run history) is deterministic and costs nothing. The dashboard assertions
// are structural: they prove the view, the nav entry and the styles exist and are mirrored, which
// is what "page shell" actually means for this chunk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const runner = require(path.join(root, 'app', 'src', 'ai', 'apply-runner.js'));
const sandbox = require(path.join(root, 'app', 'src', 'ai', 'tools', 'sandbox.js'));
const db = require(path.join(root, 'app', 'src', 'db.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-aiapply-'));
db.open(dir);
process.on('exit', () => {
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
});

const act = (tool, args) => JSON.stringify({ thought: 't', tool, args });
const fin = (summary) => JSON.stringify({ thought: 'done', done: true, summary });
function scripted(replies, delayMs = 0) {
  let i = 0;
  return async () => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const r = replies[Math.min(i++, replies.length - 1)];
    return { text: r, provider: 'scripted', model: 'test' };
  };
}

test.beforeEach(() => runner._reset());

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------
test('a run streams every step over the emitter and records the outcome', async () => {
  const events = [];
  runner.setEmitter((type, data) => events.push({ type, data }));
  const view = await runner.start({
    profileId: 'p1', autonomy: 'auto', goal: 'do the thing',
    tools: sandbox.safe,
    deps: { generate: scripted([act('echo', { text: 'hello' }), fin('all done')]) },
  });
  assert.equal(view.autonomy, 'auto');
  await waitIdle('p1');

  const steps = events.filter((e) => e.type === 'ai-apply.step');
  assert.equal(steps.length, 2, 'echo + done must both be emitted');
  assert.equal(steps[0].data.step.tool, 'echo');
  assert.ok(steps[0].data.runId, 'every step event must carry the run id the UI attaches to');

  const finished = events.filter((e) => e.type === 'ai-apply.run').pop();
  assert.equal(finished.data.status, 'done');
});

async function waitIdle(profileId, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!runner.isRunning(profileId)) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('run did not finish in time');
}

test('a second Start for the same profile is refused, not silently queued', async () => {
  runner.setEmitter(() => {});
  await runner.start({
    profileId: 'p1', tools: sandbox.safe,
    deps: { generate: scripted([act('echo', { text: 'a' }), fin('ok')], 60) },
  });
  await assert.rejects(
    () => runner.start({ profileId: 'p1', tools: sandbox.safe, deps: { generate: scripted([fin('x')]) } }),
    (e) => e.code === 'RUN_IN_PROGRESS',
  );
  await waitIdle('p1');
});

test('two profiles run at the same time — this is what Dad needs in chunk 10', async () => {
  runner.setEmitter(() => {});
  // Both loop indefinitely so the overlap is real rather than a race the test happens to win.
  const forever = () => ({ generate: scripted([act('echo', { text: 'a' })], 25) });
  await runner.start({ profileId: 'pierre', tools: sandbox.safe, limits: { maxSteps: 500 }, deps: forever() });
  await runner.start({ profileId: 'dad', tools: sandbox.safe, limits: { maxSteps: 500 }, deps: forever() });

  assert.equal(runner.activeRuns().length, 2, 'both must be live at once');
  assert.equal(runner.isRunning('pierre'), true);
  assert.equal(runner.isRunning('dad'), true);

  // Stopping one must not touch the other — separate lanes, separate kill switches.
  runner.stop('pierre');
  await waitIdle('pierre');
  assert.equal(runner.isRunning('dad'), true, 'stopping Pierre must not stop Dad');

  runner.stop('dad');
  await waitIdle('dad');
});

test('Stop halts the run and reports stopping until it lands', async () => {
  runner.setEmitter(() => {});
  await runner.start({
    profileId: 'p1', tools: sandbox.safe,
    deps: { generate: scripted([act('echo', { text: 'again' })], 30) },   // never finishes on its own
    limits: { maxSteps: 500 },
  });
  const r = runner.stop('p1');
  assert.equal(r.ok, true);
  assert.equal(r.stopping, true);
  await waitIdle('p1');
  assert.equal(runner.isRunning('p1'), false);
});

test('Stop with nothing running says so instead of pretending', () => {
  assert.equal(runner.stop('nobody').ok, false);
});

test('a finished run is queryable from history with its real cost', async () => {
  runner.setEmitter(() => {});
  await runner.start({
    profileId: 'hist', tools: sandbox.safe,
    deps: { generate: scripted([act('add', { a: 2, b: 5 }), fin('seven')]) },
  });
  await waitIdle('hist');
  const runs = db.aiRunList({ profileId: 'hist', limit: 5 });
  assert.ok(runs.length >= 1);
  const row = runs[0];
  assert.equal(row.status, 'done');
  assert.equal(row.steps, 2);
  assert.ok(row.prompt_chars > 0, 'cost must be recorded, it is the number that matters');
  const steps = db.aiRunSteps(row.id);
  assert.equal(steps[0].result, '7');
});

test('a refused tool reaches the UI marked refused, not as a plain error', async () => {
  const events = [];
  runner.setEmitter((t, d) => events.push({ t, d }));
  await runner.start({
    profileId: 'p1', tools: sandbox.all,
    deps: { generate: scripted([act('locked_drawer', { reason: 'x' }), fin('gave up')]) },
  });
  await waitIdle('p1');
  const step = events.find((e) => e.t === 'ai-apply.step' && e.d.step.tool === 'locked_drawer').d.step;
  assert.equal(step.refused, true);
  assert.equal(step.ok, false);
  assert.equal(step.result, null);
});

// ---------------------------------------------------------------------------
// the page shell itself
// ---------------------------------------------------------------------------
const appJs = fs.readFileSync(path.join(root, 'extension', 'app', 'app.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'extension', 'app', 'app.html'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'extension', 'app', 'app.css'), 'utf8');
const serverJs = fs.readFileSync(path.join(root, 'app', 'src', 'server.js'), 'utf8');

test('the nav entry and the route exist and agree', () => {
  assert.match(appHtml, /data-route="\/ai-apply"/);
  assert.match(appJs, /route\('\/ai-apply'/);
});

test('the page has Start, Stop, autonomy, toolset and a transcript', () => {
  for (const hook of ['data-start', 'data-stop', 'data-autonomy', 'data-toolset', 'data-transcript', 'data-probe']) {
    assert.ok(appJs.includes(hook), `missing control: ${hook}`);
  }
});

// ---- chunk 4 wiring ---------------------------------------------------------
test('each profile gets its own stable debug port, so two runs cannot share a window', () => {
  const a = runner._portFor('pierre');
  const b = runner._portFor('dad');
  assert.notEqual(a, b, 'two people must never land on the same port');
  assert.equal(runner._portFor('pierre'), a, 'the port must be stable across restarts');
  for (const p of [a, b]) assert.ok(p >= 9230 && p < 9290, `port ${p} out of range`);
});

test('the browser belt is created but Chrome is NOT launched until a tool needs it', async () => {
  runner.setEmitter(() => {});
  // A run that finishes without browsing must never have started Chrome.
  await runner.start({
    profileId: 'nobrowse', toolset: 'browser', headless: true, goal: 'Open https://example.com',
    deps: { generate: scripted([fin('nothing to browse')]) },
  });
  await waitIdle('nobrowse');
  const runs = db.aiRunList({ profileId: 'nobrowse', limit: 1 });
  assert.equal(runs[0].status, 'done');
});

test('the toolset choice reaches the run', async () => {
  runner.setEmitter(() => {});
  const view = await runner.start({
    profileId: 'ts', toolset: 'browser', headless: true, goal: 'Open https://example.com',
    deps: { generate: scripted([fin('done')]) },
  });
  assert.equal(view.toolset, 'browser');
  await waitIdle('ts');
});

test('an unknown toolset falls back to the sandbox rather than half-starting a browser', async () => {
  runner.setEmitter(() => {});
  const view = await runner.start({
    profileId: 'bogus', toolset: 'wat',
    deps: { generate: scripted([fin('done')]) },
  });
  assert.equal(view.toolset, 'sandbox');
  await waitIdle('bogus');
});

test('the server accepts and sanitises the toolset', () => {
  assert.match(serverJs, /\['browser', 'apply'\]\.includes\(body\.toolset\)/,
    'an arbitrary string from the client must never reach the runner');
});

test('the apply toolset gives the agent BOTH the browser and the ledger', async () => {
  runner.setEmitter(() => {});
  const seen = [];
  const view = await runner.start({
    profileId: 'combo', toolset: 'apply', headless: true, goal: 'Apply at https://example.com/job',
    deps: {
      generate: async ({ system }) => { seen.push(system); return { text: fin('ok'), provider: 's', model: 't' }; },
    },
  });
  assert.equal(view.toolset, 'apply');
  await waitIdle('combo');
  const sys = seen[0] || '';
  for (const t of ['navigate', 'read_page', 'attach_file', 'check_duplicate', 'log_application',
    'recall_answer', 'write_resume', 'write_cover_letter', 'voice_check']) {
    assert.ok(sys.includes(`- ${t}(`), `the agent was never told about ${t}`);
  }
});

test('every server endpoint the page calls actually exists', () => {
  for (const ep of ['/ai-apply/status', '/ai-apply/start', '/ai-apply/stop', '/ai-apply/runs']) {
    assert.ok(serverJs.includes(`'${ep}'`) || serverJs.includes(`'${ep}/'`), `server is missing ${ep}`);
  }
});

test('the runner is wired to the SSE broadcaster exactly once', () => {
  const wires = serverJs.match(/applyRunner\.setEmitter\(/g) || [];
  assert.equal(wires.length, 1, 'one wiring point, or events double-fire');
});

test('the page listens for both AI Apply events', () => {
  assert.match(appJs, /'ai-apply\.step'/);
  assert.match(appJs, /'ai-apply\.run'/);
});

test('the transcript hook is released when leaving the page', () => {
  assert.match(appJs, /path !== '\/ai-apply'\) aiApplyOnEvent = null/,
    'a live run would otherwise append into a detached view forever');
});

test('AI Apply is NOT in the blanket softRefresh list', () => {
  // A run emits a step every few seconds; a full re-render per step would fight the user's scroll.
  const m = appJs.match(/for \(const ev of \[([^\]]*)\]\) \{\s*es\.addEventListener\(ev, \(\) => softRefresh\(\)\);/);
  assert.ok(m, 'could not find the softRefresh event list');
  assert.ok(!m[1].includes('ai-apply'), 'ai-apply must handle its own events');
});

test('styles exist for every state the view can render', () => {
  for (const sel of ['.ai-transcript', '.ai-step', '.ai-prov', '.ai-warn']) {
    assert.ok(appCss.includes(sel), `missing style: ${sel}`);
  }
  for (const st of ['proven', 'ready', 'quota', 'down', 'off']) {
    assert.ok(appCss.includes(`data-state="${st}"`), `provider state "${st}" has no style`);
  }
  for (const v of ['refused', 'error', 'ok']) {
    assert.ok(appCss.includes(`data-verdict="${v}"`), `step verdict "${v}" has no style`);
  }
});

test('the styles use theme variables, never hardcoded colours', () => {
  const block = appCss.slice(appCss.indexOf('/* ---------- AI Apply'));
  const hex = block.match(/#[0-9a-f]{3,8}\b/gi) || [];
  assert.deepEqual(hex, [], `AI Apply CSS must theme cleanly, found: ${hex.join(', ')}`);
});

test('the dashboard copies are still byte-identical after these edits', () => {
  for (const f of ['app.js', 'app.css', 'app.html']) {
    const a = fs.readFileSync(path.join(root, 'extension', 'app', f));
    const b = fs.readFileSync(path.join(root, 'app', 'src', 'app', f));
    assert.ok(a.equals(b), `${f} drifted — run \`npm run mirror\` in app/`);
  }
});

test('there is exactly ONE way to read a run with its transcript', () => {
  // I claimed no endpoint exposed a run's steps, built one on `?id=`, and then found
  // GET /ai-apply/runs/<runId> had been there the whole time returning the same shape. I had
  // searched for the exact-match route and missed the startsWith one directly below it. Two ways to
  // do the same thing is worse than one, so the duplicate is gone and this keeps it gone.
  const src = fs.readFileSync(path.join(root, 'app/src/server.js'), 'utf8');
  assert.match(src, /pathname\.startsWith\('\/ai-apply\/runs\/'\)/, 'the path form is the one');
  const list = src.slice(src.indexOf("pathname === '/ai-apply/runs'"));
  const body = list.slice(0, list.indexOf('\n  }'));
  assert.equal(/searchParams\.get\('id'\)/.test(body), false, 'the list endpoint must not grow a second form');
});
