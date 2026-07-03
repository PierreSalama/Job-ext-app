// Unit tests for the opt-in "only auto-apply while I'm idle" gate. Pure decision in
// extension/lib/idle-gate.js — no Chrome needed. The rule: pause when the user is active
// (recent input) OR any tab is playing audio/video; resume only when idle/away AND silent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeIdleGate, clampIdleThreshold } from '../extension/lib/idle-gate.js';

test('active input → busy, regardless of audio', () => {
  const g = computeIdleGate('active', 0);
  assert.equal(g.busy, true);
  assert.equal(g.activeInput, true);
  assert.equal(g.mediaPlaying, false);
  assert.match(g.reason, /using the computer/i);
});

test('idle + nothing playing → NOT busy (this is when we auto-apply)', () => {
  const g = computeIdleGate('idle', 0);
  assert.equal(g.busy, false);
  assert.equal(g.reason, '');
});

test('locked + nothing playing → NOT busy (user is away, safe to apply)', () => {
  const g = computeIdleGate('locked', 0);
  assert.equal(g.busy, false);
});

test('idle but a tab is playing audio (YouTube) → busy, reason=media', () => {
  const g = computeIdleGate('idle', 1);
  assert.equal(g.busy, true);
  assert.equal(g.activeInput, false);
  assert.equal(g.mediaPlaying, true);
  assert.match(g.reason, /media is playing/i);
});

test('locked but audio still playing → busy (they left a video running)', () => {
  const g = computeIdleGate('locked', 3);
  assert.equal(g.busy, true);
  assert.equal(g.mediaPlaying, true);
});

test('active input takes precedence over media in the reason', () => {
  const g = computeIdleGate('active', 2);
  assert.equal(g.busy, true);
  assert.match(g.reason, /using the computer/i);
});

test('unknown/garbage idle state with no audio is treated as not-active → not busy', () => {
  const g = computeIdleGate(undefined, 0);
  assert.equal(g.activeInput, false);
  assert.equal(g.busy, false);
  assert.equal(g.idleState, 'unknown');
});

test('clampIdleThreshold enforces the chrome.idle 15s floor and a 1h ceiling', () => {
  assert.equal(clampIdleThreshold(60), 60);
  assert.equal(clampIdleThreshold(5), 15, 'below floor clamps up to 15');
  assert.equal(clampIdleThreshold(0), 15);
  assert.equal(clampIdleThreshold(-100), 15);
  assert.equal(clampIdleThreshold(99999), 3600, 'above ceiling clamps to 3600');
  assert.equal(clampIdleThreshold('45'), 45, 'numeric strings accepted');
  assert.equal(clampIdleThreshold(undefined), 60, 'default 60 when unparseable');
  assert.equal(clampIdleThreshold(NaN), 60);
});
