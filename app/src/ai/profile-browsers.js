'use strict';
// ============================================================================
//  JAT v11 — per-person browsers (AI Apply chunk 10)
//
//  "Make it so I can do it with my logins and or my dad's."
//
//  Each person gets their OWN Chrome profile directory and their own debug port, so Pierre's
//  browser and Dad's can run at the same time on the server laptop without seeing each other's
//  cookies. Once a person signs in there, the profile keeps the session — the agent inherits it on
//  every later run, which is exactly what made the overnight LinkedIn searches possible.
//
//  SIGNING IN IS A HUMAN ACTION, ALWAYS
//  This module opens the window and gets out of the way. It never types a password, never fills a
//  login form, and never touches a credential. It hands the person a browser and waits.
//
//  A SIGN-IN BROWSER IS NOT A RUN
//  It is deliberately separate from the agent's browser: a person poking around while an agent
//  drives the same window would produce steps neither of them intended. Opening one for a profile
//  that is mid-run is refused.
// ============================================================================

const crypto = require('crypto');
const cdp = require('../browser/cdp');

let log = { info() {}, warn() {}, error() {} };
try { log = require('../logger').scope('ai:profile-browsers'); } catch { /* usable outside the app */ }

// Sign-in windows sit on their own port range so they can never collide with a run's browser.
const SIGNIN_PORT_BASE = 9400;
const SIGNIN_PORT_SPAN = 60;
function signinPortFor(profileId) {
  const h = crypto.createHash('sha1').update(`signin:${String(profileId || 'default')}`).digest();
  return SIGNIN_PORT_BASE + (h.readUInt16BE(0) % SIGNIN_PORT_SPAN);
}

// The places a person actually needs to be signed in for the agent to be useful.
const SIGNIN_TARGETS = [
  'https://www.linkedin.com/feed/',
  'https://www.indeed.com/',
];

const open = new Map();   // profileId -> { handle, startedAt }

function isOpen(profileId) { return open.has(String(profileId || '')); }

function status(profileId) {
  const key = String(profileId || '');
  return {
    profileId: key,
    browserOpen: open.has(key),
    signedInBefore: cdp.profileIsInitialised(key),
    profileDir: cdp.profileDir(key),
    port: signinPortFor(key),
  };
}

// Opens a real, visible Chrome on that person's profile and leaves it open. Returns immediately —
// the person may take as long as they like.
async function openSignin(profileId, { url = SIGNIN_TARGETS[0], isRunning = () => false } = {}) {
  const key = String(profileId || '');
  if (open.has(key)) return { ok: true, already: true, ...status(key) };
  if (isRunning(key)) {
    const e = new Error('a run is using this profile\'s browser — stop it before signing in');
    e.code = 'PROFILE_BUSY';
    throw e;
  }

  const handle = await cdp.launchChrome({
    profileId: key,
    port: signinPortFor(key),
    headless: false,                 // the whole point is that a person can see and use it
  });
  open.set(key, { handle, startedAt: new Date().toISOString() });

  // Best effort: land them on the sign-in page. A failure here is not a failure of the window.
  try {
    const page = await cdp.attachPage({ port: signinPortFor(key) });
    await page.navigate(url, { waitMs: 25000 });
    page.close();
  } catch (e) {
    log.info(`sign-in window opened but could not navigate: ${e.message}`);
  }

  log.info(`sign-in browser open for profile ${key || '(default)'}`);
  return { ok: true, already: false, ...status(key) };
}

// Closing FLUSHES the profile to disk, which is what makes the session survive. Chrome writes its
// cookie store on exit, so killing the process without this can lose the very login just made.
async function closeSignin(profileId) {
  const key = String(profileId || '');
  const rec = open.get(key);
  if (!rec) return { ok: false, reason: 'no sign-in browser is open for this profile' };
  open.delete(key);
  await cdp.killChrome(rec.handle);
  log.info(`sign-in browser closed for profile ${key || '(default)'}`);
  return { ok: true, ...status(key) };
}

async function closeAll() {
  for (const key of [...open.keys()]) {
    try { await closeSignin(key); } catch (e) { log.warn(`could not close ${key}: ${e.message}`); }
  }
}

module.exports = {
  openSignin, closeSignin, closeAll, status, isOpen, signinPortFor, SIGNIN_TARGETS,
};
