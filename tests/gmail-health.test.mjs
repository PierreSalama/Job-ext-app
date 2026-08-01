// Gmail sync must never fail silently.
//
// The bug this guards: syncNow() returned early on "disabled" / "not authorized" WITHOUT
// writing anything, and its catch block set only the in-memory lastResult — so the DB's
// `gmailLastResult` advanced ONLY on success. A rejected refresh token therefore looked
// exactly like a sync that had never run. It failed 1,828 consecutive times across 31
// days (2026-06-30 → 2026-07-31) while the dashboard showed the last GOOD sync, and a
// real interview invitation was missed as a result.
//
// Every test here asserts the DB-visible state after a failure, because that is the
// surface the user (and the watchdog) actually reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));
const gmail = require(path.join(here, '..', 'app', 'src', 'gmail.js'));

let dir;
const realFetch = globalThis.fetch;

test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-gh-'));
  db.open(dir);
});
test.after(() => {
  globalThis.fetch = realFetch;
  try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

function reset({ enabled = true, creds = true, refresh = true } = {}) {
  db.patchSettings({
    gmail: {
      enabled,
      clientId: creds ? 'cid.apps.googleusercontent.com' : '',
      clientSecret: creds ? 'secret' : '',
    },
  });
  db.kvSet('gmailTokens', refresh ? { refresh_token: 'rt', access_token: 'at', expires_at: 0 } : null);
  db.kvSet('gmailHealth', null);
  db.kvSet('gmailLastResult', null);
}

// ---------- the exact production failure ----------

test('a 400 refresh rejection is persisted, not swallowed', async () => {
  reset();
  globalThis.fetch = async () => ({
    ok: false, status: 400,
    json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
  });

  const r = await gmail.syncNow();
  assert.equal(r.ok, false);
  assert.equal(r.needsAuth, true, 'a 400 on refresh means the user must re-consent');

  const stored = db.kvGet('gmailLastResult');
  assert.ok(stored, 'gmailLastResult MUST be written on failure — this is the whole bug');
  assert.ok(stored.error, 'the stored result carries the error');
  assert.match(stored.error, /invalid_grant/, "Google's reason is preserved, not just the status code");
  assert.match(stored.error, /expired or revoked/, 'the human-readable description survives too');

  const h = db.kvGet('gmailHealth');
  assert.equal(h.needsAuth, true);
  assert.equal(h.consecutiveFailures, 1);
  assert.ok(h.lastFailureAt, 'the failure is timestamped');
});

test('consecutive failures accumulate rather than overwrite', async () => {
  reset();
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });

  for (let i = 0; i < 5; i++) await gmail.syncNow();
  assert.equal(db.kvGet('gmailHealth').consecutiveFailures, 5, '5 ticks = 5 counted failures');
  assert.equal(db.kvGet('gmailLastResult').consecutiveFailures, 5, 'the count is visible in the result too');
});

test('invalid_client is reported as a credentials problem, and is distinguishable from invalid_grant', async () => {
  reset();
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_client' }) });
  await gmail.syncNow();
  assert.match(db.kvGet('gmailHealth').lastError, /invalid_client/,
    're-auth will not fix a bad clientId/secret, so the two must not be conflated');
});

test('a refresh failure with an unreadable body still records something actionable', async () => {
  reset();
  globalThis.fetch = async () => ({
    ok: false, status: 400,
    json: async () => { throw new Error('not json'); },
    text: async () => '<html>proxy error</html>',
  });
  await gmail.syncNow();
  const h = db.kvGet('gmailHealth');
  assert.match(h.lastError, /HTTP 400/, 'falls back to the status code');
  assert.match(h.lastError, /proxy error/, 'and keeps whatever body text there was');
});

// ---------- the other silent early-returns ----------

test('"sync disabled" is recorded instead of returning silently', async () => {
  reset({ enabled: false });
  const r = await gmail.syncNow();
  assert.equal(r.ok, false);
  const stored = db.kvGet('gmailLastResult');
  assert.ok(stored?.error, 'disabled must still leave a trace');
  assert.match(stored.error, /turned off/i);
  assert.equal(db.kvGet('gmailHealth').needsAuth, false, 'disabled is NOT an auth problem');
});

test('missing credentials are recorded as needing auth', async () => {
  reset({ creds: false });
  const r = await gmail.syncNow();
  assert.equal(r.needsAuth, true);
  assert.match(db.kvGet('gmailLastResult').error, /not connected|Not authorized/i);
});

test('a thrown error mid-sync is persisted (the old catch only set the in-memory copy)', async () => {
  reset();
  globalThis.fetch = async () => { throw new Error('ENETDOWN'); };
  const r = await gmail.syncNow();
  assert.equal(r.ok, false);
  assert.match(db.kvGet('gmailLastResult').error, /ENETDOWN/, 'network death is visible in the DB');
});

// ---------- staleness: the catch-all ----------

test('staleness flags a sync that has not succeeded recently', () => {
  reset();
  const old = new Date(Date.now() - 9 * 3600 * 1000).toISOString();
  db.kvSet('gmailHealth', { lastSuccessAt: old, lastFailureAt: null, lastError: null, consecutiveFailures: 0, needsAuth: false, lastNotifiedAt: null });
  const s = gmail.staleness();
  assert.equal(s.stale, true, `9h > ${gmail.STALE_AFTER_HOURS}h threshold`);
  assert.ok(s.hours >= 8.9 && s.hours <= 9.1);
});

test('a recent success is NOT stale', () => {
  reset();
  db.kvSet('gmailHealth', { lastSuccessAt: new Date().toISOString(), lastFailureAt: null, lastError: null, consecutiveFailures: 0, needsAuth: false, lastNotifiedAt: null });
  assert.equal(gmail.staleness().stale, false);
});

test('staleness catches a DEAD SCHEDULER — no failures counted, yet mail stopped flowing', () => {
  reset();
  // The 31-day blind spot's worst variant: if the interval is never armed there are zero
  // failures to count, so any failure-counting alarm stays quiet forever. Age-since-success
  // is what catches it.
  db.kvSet('gmailHealth', {
    lastSuccessAt: new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString(),
    lastFailureAt: null, lastError: null, consecutiveFailures: 0, needsAuth: false, lastNotifiedAt: null,
  });
  const s = gmail.staleness();
  assert.equal(s.stale, true, 'stale purely on age, with no error recorded anywhere');
  assert.ok(s.hours > 700);
});

test('a disabled sync is never reported as stale (it is off on purpose)', () => {
  reset({ enabled: false });
  db.kvSet('gmailHealth', {
    lastSuccessAt: new Date(Date.now() - 99 * 3600 * 1000).toISOString(),
    lastFailureAt: null, lastError: null, consecutiveFailures: 0, needsAuth: false, lastNotifiedAt: null,
  });
  assert.equal(gmail.staleness().stale, false, 'off-by-choice must not nag');
});

test('never-synced-but-failing counts as stale', () => {
  reset();
  db.kvSet('gmailHealth', { lastSuccessAt: null, lastFailureAt: new Date().toISOString(), lastError: 'boom', consecutiveFailures: 3, needsAuth: true, lastNotifiedAt: null });
  assert.equal(gmail.staleness().stale, true);
});

// ---------- recovery + status surface ----------

test('a successful sync clears the failure state', async () => {
  reset();
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
  await gmail.syncNow();
  assert.equal(db.kvGet('gmailHealth').consecutiveFailures, 1);

  // Now: refresh succeeds, and the message list comes back empty.
  globalThis.fetch = async (url) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return { ok: true, json: async () => ({ access_token: 'fresh', expires_in: 3600 }) };
    }
    return { ok: true, json: async () => ({ messages: [] }) };
  };
  const r = await gmail.syncNow();
  assert.equal(r.ok, true, 'sync recovers once Google accepts the token again');

  const h = db.kvGet('gmailHealth');
  assert.equal(h.consecutiveFailures, 0, 'counter resets');
  assert.equal(h.needsAuth, false, 'the re-auth prompt clears itself');
  assert.equal(h.lastError, null);
  assert.ok(h.lastSuccessAt);
  assert.equal(gmail.staleness().stale, false);
});

test('status() exposes health and staleness for the UI', async () => {
  reset();
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
  await gmail.syncNow();

  const st = gmail.status();
  assert.equal(st.enabled, true);
  assert.equal(st.configured, true);
  assert.equal(st.authorized, true, 'a refresh token exists — it is just no longer accepted');
  assert.equal(st.health.needsAuth, true, 'so "authorized" alone is misleading; health is the truth');
  assert.equal(st.stale, true);
  assert.ok(st.lastResult.error);
});

test('markNotified records the time so the warning does not repeat every tick', () => {
  reset();
  db.kvSet('gmailHealth', { ...gmail.health(), consecutiveFailures: 2 });
  assert.equal(gmail.health().lastNotifiedAt, null);
  gmail.markNotified();
  assert.ok(gmail.health().lastNotifiedAt, 'timestamped');
  assert.equal(gmail.health().consecutiveFailures, 2, 'and it does not clobber the rest of the record');
});
