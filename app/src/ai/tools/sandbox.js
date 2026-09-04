'use strict';
// ============================================================================
//  JAT v11 — sandbox tools (AI Apply chunk 2)
//
//  Deliberately fake. They exist to prove the loop mechanism end to end — dispatch, structured
//  args, multi-step reasoning and REFUSAL — against a real model, before any tool can touch a
//  browser or the ledger. Nothing here has a side effect outside the process.
//
//  `locked_drawer` is the important one: it is refused by its guard every single time. Chunk 8
//  fills the same guard slot with the real rules (no passwords, no self-ID, no duplicate slug), so
//  proving the refusal path now means the safety mechanism is load-bearing from the start rather
//  than bolted on once there is something dangerous to protect.
// ============================================================================

// A value the model cannot know without calling the tool, so a correct final answer PROVES the
// loop actually executed a step rather than hallucinating its way to a plausible summary.
const SECRETS = {
  'front desk': 'MARIGOLD-71',
  vault: 'ELDERFLOWER-22',
  archive: 'SAFFRON-08',
};

const echo = {
  name: 'echo',
  description: 'Return the text you pass in, unchanged. Use it to test the connection.',
  args: ['text'],
  run: ({ text }) => String(text == null ? '' : text),
};

const add = {
  name: 'add',
  description: 'Add two numbers and return the sum.',
  args: ['a', 'b'],
  run: ({ a, b }) => {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('add needs two numbers');
    return String(x + y);
  },
};

const lookupCode = {
  name: 'lookup_code',
  description: `Look up the access code for a room. Rooms: ${Object.keys(SECRETS).join(', ')}.`,
  args: ['room'],
  run: ({ room }) => {
    const key = String(room || '').trim().toLowerCase();
    const val = SECRETS[key];
    if (!val) throw new Error(`no such room "${room}". Try: ${Object.keys(SECRETS).join(', ')}`);
    return val;
  },
};

const lockedDrawer = {
  name: 'locked_drawer',
  description: 'Open the locked drawer. (You will not be permitted to do this.)',
  args: ['reason'],
  guard: () => 'the locked drawer is off limits — this action is never permitted',
  run: () => { throw new Error('unreachable: the guard refuses first'); },
};

const explode = {
  name: 'explode',
  description: 'Always throws. Used to prove a tool error is recoverable, not fatal.',
  args: [],
  run: () => { throw new Error('tool blew up on purpose'); },
};

module.exports = {
  SECRETS,
  echo, add, lookupCode, lockedDrawer, explode,
  all: [echo, add, lookupCode, lockedDrawer, explode],
  safe: [echo, add, lookupCode],
};
