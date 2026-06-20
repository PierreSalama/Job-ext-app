// JAT v11 — forensic-trace redaction helpers.
// The auto-apply executor writes a detailed step-trace to the task transcript.
// These pure helpers guarantee no sensitive value (password/SIN/SSN/card) ever
// reaches the transcript and that emails/phones are masked + everything is short.

import test from 'node:test';
import assert from 'node:assert/strict';
import { redactValue, redactLabel, maskEmail, maskPhone, SENSITIVE_LABEL_RX } from '../extension/content/lib/redact.js';

test('sensitive labels are dropped entirely (never logged)', () => {
  assert.equal(redactValue('hunter2', 'Password'), '[redacted]');
  assert.equal(redactValue('123-456-789', 'Social Insurance Number (SIN)'), '[redacted]');
  assert.equal(redactValue('078-05-1120', 'SSN'), '[redacted]');
  assert.equal(redactValue('4111111111111111', 'Credit Card Number'), '[redacted]');
  assert.equal(redactValue('1990-01-01', 'Date of Birth'), '[redacted]');
  assert.ok(SENSITIVE_LABEL_RX.test('Account Number'));
  assert.ok(!SENSITIVE_LABEL_RX.test('First name'));
});

test('emails are masked to the last 4 of the local part', () => {
  assert.equal(maskEmail('ulysis.ibarra@tacel.ca'), '***arra@tacel.ca');
  assert.equal(maskEmail('bob@x.io'), '***bob@x.io');     // short local part kept whole
  assert.equal(redactValue('jane.doe@example.com', 'Email'), '***.doe@example.com');
});

test('phones are masked to the last 4 digits', () => {
  assert.equal(maskPhone('+1 (416) 555-1234'), '***1234');
  assert.equal(maskPhone('4165551234'), '***1234');
  assert.equal(redactValue('416-555-0199', 'Phone'), '***0199');
  // a short number (<7 digits) is not treated as a phone
  assert.equal(maskPhone('12345'), '12345');
});

test('plain values are previewed and truncated to ~40 chars', () => {
  assert.equal(redactValue('Toronto', 'City'), 'Toronto');
  const long = 'a'.repeat(80);
  const out = redactValue(long, 'Cover letter');
  assert.ok(out.length <= 41, `expected <=41 chars, got ${out.length}`);
  assert.ok(out.endsWith('…'));
});

test('empty / site-masked values are labelled, not blank', () => {
  assert.equal(redactValue('', 'City'), '<empty>');
  assert.equal(redactValue(null, 'City'), '<empty>');
  assert.equal(redactValue('••••••', 'City'), '[masked-by-site]');
  assert.equal(redactValue('****', 'City'), '[masked-by-site]');
});

test('redactLabel masks PII echoed in labels and truncates to 80 chars', () => {
  assert.equal(redactLabel('  Confirm   email  bob.smith@corp.com '), 'Confirm email ***mith@corp.com');
  assert.equal(redactLabel('x'.repeat(120)).length, 80);
});

test('helpers never throw on hostile input', () => {
  const weird = { toString() { throw new Error('boom'); } };
  assert.equal(redactValue(weird, 'City'), '[unprintable]');
  assert.equal(redactLabel(weird), '[label?]');
});
