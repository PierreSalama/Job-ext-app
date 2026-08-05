// A node flagged isDefault becomes the machine the Auto-Apply page opens on, so Pierre sees the
// always-on server rather than his PC (which is usually stood down by the one-at-a-time coordinator).
// Two invariants matter: an explicit user choice must still win, and an unreachable default must
// never strand the page — the existing fallback drops back to This PC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appJs = fs.readFileSync(path.join(here, '..', 'extension', 'app', 'app.js'), 'utf8');
const mirror = fs.readFileSync(path.join(here, '..', 'app', 'src', 'app', 'app.js'), 'utf8');

test('the two dashboard copies stay byte-identical', () => {
  assert.equal(appJs, mirror);
});

test('a node flagged isDefault is selected on load', () => {
  assert.match(appJs, /n\.isDefault && n\.id/, 'must look for an isDefault node');
  assert.match(appJs, /state\.aaNodeId = def\.id/, 'must adopt that node');
});

test('an explicit user choice always wins over the default', () => {
  assert.match(appJs, /if \(!localStorage\.getItem\('jat\.aaNode'\)\)/,
    'the default may only apply when the user has not chosen a node');
});

test('an unreachable node still falls back to This PC', () => {
  // Guards the earlier fix: a dead server must never leave the page blank.
  assert.match(appJs, /localStorage\.setItem\('jat\.aaNode', 'self'\)/, 'fallback to self must remain');
});
