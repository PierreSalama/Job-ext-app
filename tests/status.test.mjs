// Status FSM invariants — the contract both the extension pipeline and the
// app's SQLite layer rely on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUSES, elevatedStatus, isTerminal, statusLabel } from '../extension/lib/status.js';

test('orders are strictly increasing within the happy path', () => {
  const path = ['started', 'submitted', 'contacted', 'interview_1', 'interview_2', 'interview_final', 'offer', 'hired'];
  const orders = path.map((id) => STATUSES.find((s) => s.id === id).order);
  for (let i = 1; i < orders.length; i++) assert.ok(orders[i] > orders[i - 1]);
});

test('elevation only moves forward', () => {
  assert.equal(elevatedStatus('started', 'submitted'), 'submitted');
  assert.equal(elevatedStatus('submitted', 'started'), 'submitted');
  assert.equal(elevatedStatus('interview_2', 'contacted'), 'interview_2');
  assert.equal(elevatedStatus('offer', 'interview_1'), 'offer');
});

test('terminal statuses are frozen', () => {
  for (const id of ['hired', 'rejected', 'withdrawn', 'ghosted']) {
    assert.ok(isTerminal(id), `${id} should be terminal`);
    assert.equal(elevatedStatus(id, 'offer'), id);
    assert.equal(elevatedStatus(id, 'submitted'), id);
  }
});

test('unknown statuses never elevate', () => {
  assert.equal(elevatedStatus('submitted', 'banana'), 'submitted');
  assert.equal(elevatedStatus('banana', 'submitted'), 'submitted');
});

test('every status has a label', () => {
  for (const s of STATUSES) assert.ok(statusLabel(s.id).length > 0);
});
