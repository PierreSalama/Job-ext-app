'use strict';
// ============================================================================
//  Session bridge (source side)
//  Read a Firefox profile's LinkedIn cookies so ANOTHER machine can assume the
//  same logged-in LinkedIn session — no password, no new-device login prompt.
//
//  Why: we want to run Dad's auto-apply on the server laptop using DAD's account,
//  sourced from his own Firefox on his own machine. Both machines sit on the same
//  household network (same public IP), so LinkedIn sees the transplanted session as
//  a continuation of the existing one rather than a new-device login.
//
//  This file is the READ/EXTRACT half only. It is pure and side-effect-free apart
//  from copying the cookie DB to a temp file (Firefox keeps cookies.sqlite open, so
//  we snapshot it read-only). Transport + injection live elsewhere (A1b / A1c).
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

let _Database = null;
function Database() {
  if (!_Database) ({ Database: _Database } = require('node-sqlite3-wasm'));
  return _Database;
}

// LinkedIn cookies worth transplanting. li_at is the auth token; JSESSIONID carries
// the CSRF/session id; the rest keep the session coherent (device, routing, locale).
const LINKEDIN_COOKIES = new Set([
  'li_at', 'JSESSIONID', 'bcookie', 'bscookie', 'li_rm', 'lidc', 'liap',
  'li_mc', 'li_gc', 'lang', 'timezone', 'li_alerts', 'li_theme', 'li_theme_set',
  'UserMatchHistory', 'AnalyticsSyncHistory', '_guid', 'li_sugr', 'aam_uuid', 'lms_ads', 'lms_analytics',
]);
// A session is only usable if BOTH of these are present.
const REQUIRED = ['li_at', 'JSESSIONID'];

function isLinkedInHost(host) {
  const h = String(host || '').replace(/^\./, '').toLowerCase();
  return h === 'linkedin.com' || h.endsWith('.linkedin.com');
}

// Firefox moz_cookies.sameSite: 0=None, 1=Lax, 2=Strict  →  CDP Network.setCookie strings.
function mapSameSite(v) {
  const n = Number(v);
  return n === 2 ? 'Strict' : n === 1 ? 'Lax' : 'None';
}

// Default Firefox profiles root on Windows. Accepts an override for tests / non-standard installs.
function defaultProfilesRoot() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'Mozilla', 'Firefox', 'Profiles');
}

// Firefox profile dirs that actually contain a cookies.sqlite, ordered best-first:
// the default-release profile, then whichever cookies DB was written most recently.
function findFirefoxProfiles(profilesRoot) {
  const base = profilesRoot || defaultProfilesRoot();
  let entries = [];
  try { entries = fs.readdirSync(base).map((d) => path.join(base, d)); } catch { return []; }
  const withCookies = entries.filter((d) => {
    try { return fs.statSync(path.join(d, 'cookies.sqlite')).isFile(); } catch { return false; }
  });
  const mtime = (d) => { try { return fs.statSync(path.join(d, 'cookies.sqlite')).mtimeMs; } catch { return 0; } };
  return withCookies.sort((a, b) => {
    const ar = /default-release/i.test(a) ? 0 : 1;
    const br = /default-release/i.test(b) ? 0 : 1;
    if (ar !== br) return ar - br;
    return mtime(b) - mtime(a);
  });
}

// Snapshot cookies.sqlite (+ WAL/SHM) to a temp copy and read moz_cookies. Firefox holds
// the live file open, so we never touch the original — we copy then read the copy.
function readCookieRows(dbPath) {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmp = path.join(os.tmpdir(), `jat-cookies-${tag}.sqlite`);
  const copies = [tmp];
  fs.copyFileSync(dbPath, tmp);
  for (const suf of ['-wal', '-shm']) {
    try { fs.copyFileSync(dbPath + suf, tmp + suf); copies.push(tmp + suf); } catch { /* no WAL/SHM — fine */ }
  }
  const db = new (Database())(tmp);
  try {
    return db.all('SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies');
  } finally {
    try { db.close(); } catch {}
    for (const f of copies) { try { fs.unlinkSync(f); } catch {} }
  }
}

// Normalize a moz_cookies row into a CDP-ready cookie object.
function toCdpCookie(r) {
  return {
    name: String(r.name),
    value: String(r.value),
    domain: String(r.host),            // Firefox stores the leading-dot host as-is (e.g. ".www.linkedin.com")
    path: r.path || '/',
    secure: !!Number(r.isSecure),
    httpOnly: !!Number(r.isHttpOnly),
    sameSite: mapSameSite(r.sameSite),
    ...(r.expiry ? { expires: Number(r.expiry) } : {}),   // epoch SECONDS (CDP wants seconds)
  };
}

// Public: extract normalized LinkedIn session cookies from a Firefox profile.
//   opts.dbPath        — read this exact cookies.sqlite (tests / explicit)
//   opts.profilesRoot  — override the Firefox Profiles dir
// Returns { ok, source, count, cookies, capturedAt } or { ok:false, error, cookies:[] }.
function extractLinkedInSession(opts = {}) {
  const dbPaths = opts.dbPath
    ? [opts.dbPath]
    : findFirefoxProfiles(opts.profilesRoot).map((p) => path.join(p, 'cookies.sqlite'));

  if (!dbPaths.length) return { ok: false, error: 'no Firefox profile with cookies found', cookies: [] };

  let sawLinkedInButIncomplete = false;
  for (const dbPath of dbPaths) {
    let rows;
    try { rows = readCookieRows(dbPath); } catch { continue; }
    const cookies = [];
    for (const r of rows) {
      if (!isLinkedInHost(r.host)) continue;
      if (!LINKEDIN_COOKIES.has(r.name)) continue;
      cookies.push(toCdpCookie(r));
    }
    if (!cookies.length) continue;
    const names = new Set(cookies.map((c) => c.name));
    if (REQUIRED.every((n) => names.has(n))) {
      return { ok: true, source: dbPath, count: cookies.length, cookies, capturedAt: new Date().toISOString() };
    }
    sawLinkedInButIncomplete = true;   // had LinkedIn cookies but not li_at + JSESSIONID; keep trying other profiles
  }
  return {
    ok: false,
    error: sawLinkedInButIncomplete
      ? 'LinkedIn cookies found but the session is incomplete (missing li_at and/or JSESSIONID) — is Dad logged in?'
      : 'no LinkedIn cookies found in any Firefox profile — is Dad logged in to LinkedIn in Firefox?',
    cookies: [],
  };
}

// ---- transport (pull side) -------------------------------------------------
// Pull a LinkedIn session bundle from another node's GET /session/linkedin. Used by the
// server laptop's dad-instance to fetch Dad's session from his own machine over Tailscale.
// Pure: http(s) + token header, no db. Returns the parsed bundle or { ok:false, error }.
function fetchRemoteLinkedInSession({ baseUrl, token, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL('/session/linkedin', baseUrl); } catch { return resolve({ ok: false, error: 'bad baseUrl' }); }
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request(u, { method: 'GET', headers: { 'X-JAT-Token': token || '' }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 2 * 1024 * 1024) req.destroy(); });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(data); } catch { return resolve({ ok: false, error: `bad response (HTTP ${res.statusCode})` }); }
        if (res.statusCode !== 200 || !body || body.ok !== true) {
          return resolve({ ok: false, error: (body && body.error) || `HTTP ${res.statusCode}`, status: res.statusCode });
        }
        // Validate the shape so we never hand junk to the injector.
        if (!Array.isArray(body.cookies) || !body.cookies.some((c) => c && c.name === 'li_at')) {
          return resolve({ ok: false, error: 'response missing li_at' });
        }
        resolve({ ok: true, count: body.count || body.cookies.length, cookies: body.cookies, capturedAt: body.capturedAt || null });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

module.exports = {
  extractLinkedInSession,
  fetchRemoteLinkedInSession,
  findFirefoxProfiles,
  defaultProfilesRoot,
  isLinkedInHost,
  mapSameSite,
  toCdpCookie,
  readCookieRows,
  LINKEDIN_COOKIES,
  REQUIRED,
};
