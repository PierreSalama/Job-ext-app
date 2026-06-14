// JAT v11 — secrets at rest.
// Encrypts high-value secrets (API keys, OAuth tokens, IMAP app passwords) using the
// OS keychain via Electron's safeStorage (Windows DPAPI / macOS Keychain / libsecret).
// No master password, no native deps — fits the wasm-SQLite design.
//
// Degrades safely: when safeStorage is unavailable (unit tests, a non-Electron context,
// or a Linux box with no keyring), seal()/open() are transparent no-ops, so the app and
// the test suite keep working on plaintext. Sealed values are tagged with a version
// prefix so we always know whether a stored value needs decrypting.

const log = (() => { try { return require('./logger').scope('secretstore'); } catch { return { warn() {}, info() {} }; } })();

let safeStorage = null;
try {
  // Outside an Electron runtime require('electron') resolves to a path string, so
  // `.safeStorage` is simply undefined here — no throw, and available() returns false.
  ({ safeStorage } = require('electron'));
} catch { /* not running under Electron */ }

const PREFIX = 'enc:v1:';

function available() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()); }
  catch { return false; }
}

function isSealed(stored) {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}

// Plaintext → tagged ciphertext when a keychain is available; otherwise unchanged.
// Empty strings and already-sealed values pass through untouched.
function seal(plain) {
  const s = plain == null ? '' : String(plain);
  if (!s || isSealed(s)) return s;
  if (!available()) return s;
  try { return PREFIX + safeStorage.encryptString(s).toString('base64'); }
  catch { return s; }
}

// Tagged ciphertext → plaintext. Untagged (legacy plaintext) values pass through.
// A sealed value we can't decrypt (keychain changed / different OS user) returns ''
// so the app treats the secret as missing and prompts re-entry instead of crashing.
function open(stored) {
  const s = stored == null ? '' : String(stored);
  if (!isSealed(s)) return s;
  if (!available()) { log.warn('a secret is sealed but the keychain is unavailable — treating as unset (re-enter to restore)'); return ''; }
  try { return safeStorage.decryptString(Buffer.from(s.slice(PREFIX.length), 'base64')); }
  catch (e) { log.warn('secret decryption failed (keychain changed?) — treating as unset', e && e.message); return ''; }
}

module.exports = { available, isSealed, seal, open, PREFIX };
