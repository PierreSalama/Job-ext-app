// LAN remote access — the host-guard contract (DNS-rebinding stays closed):
//   localhost/127.0.0.1 always pass · private-range hosts pass ONLY when server.remoteAccess
//   is on · public hostnames NEVER pass, remote or not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const server = require(path.join(here, '..', 'app', 'src', 'server.js'));
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));

const origGetSettings = db.getSettings;
function withRemote(enabled, fn) {
  db.getSettings = () => ({ server: { remoteAccess: enabled } });
  try { fn(); } finally { db.getSettings = origGetSettings; }
}

test('hostAllowed: loopback always passes, any remote setting', () => {
  for (const enabled of [false, true]) {
    withRemote(enabled, () => {
      assert.equal(server.hostAllowed('localhost:7744'), true);
      assert.equal(server.hostAllowed('127.0.0.1:7744'), true);
      assert.equal(server.hostAllowed('127.0.0.1'), true);
    });
  }
});

test('hostAllowed: private-range hosts pass ONLY with remoteAccess on', () => {
  const lanHosts = ['192.168.2.17:7744', '10.0.0.5:7744', '172.16.4.9:7744', '100.93.122.106:7744'];
  withRemote(false, () => { for (const h of lanHosts) assert.equal(server.hostAllowed(h), false, h + ' must be blocked when off'); });
  withRemote(true, () => { for (const h of lanHosts) assert.equal(server.hostAllowed(h), true, h + ' must pass when on'); });
});

test('hostAllowed: public hostnames NEVER pass (rebinding guard holds)', () => {
  const bad = ['evil.example.com:7744', 'jat.attacker.io', '8.8.8.8:7744', '172.32.0.1:7744', ''];
  for (const enabled of [false, true]) {
    withRemote(enabled, () => { for (const h of bad) assert.equal(server.hostAllowed(h), false, h + ' must always be blocked'); });
  }
});
