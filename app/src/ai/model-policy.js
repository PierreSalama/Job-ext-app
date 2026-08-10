// SONNET-ONLY. Pierre's instruction, 2026-08-10, stated twice and spelled out: the email pipeline
// runs on the Claude Code CLI against his subscription, using "Sonnet and only Sonnet".
//
// This is a policy module rather than a default because a default is something you forget you set.
// Every path that can reach the CLI goes through `enforce()`, so the only way to run a different
// model is to change this file — not to pass a stray argument, not to inherit a stale setting, not
// to fall through to "the CLI's own default", which is whatever Claude Code happens to prefer today
// and is exactly how an Opus-priced sweep over 1,400 emails would happen by accident.
//
// The CLI accepts a bare alias ("sonnet") and resolves it to the current Sonnet build itself. That
// is deliberately what we send: pinning a dated ID here would rot, and the alias can never resolve
// to a non-Sonnet model.

const SONNET_ALIAS = 'sonnet';

// Anything that names Sonnet is fine — the alias, or a full id like claude-sonnet-4-6 /
// claude-sonnet-5. Everything else is not, including an empty value (which means "CLI default").
function isSonnet(model) {
  return /(^|[-_/])sonnet([-_.]|$)|sonnet-?\d/i.test(String(model || ''));
}

// The one function callers use. Returns the model to pass to the CLI, plus whether a request was
// overridden, so the caller can log it instead of silently swapping models under the user.
function enforce(requested) {
  const asked = String(requested || '').trim();
  if (!asked) return { model: SONNET_ALIAS, overridden: false, reason: 'no model requested — pinned to Sonnet' };
  if (isSonnet(asked)) return { model: asked, overridden: false, reason: '' };
  return {
    model: SONNET_ALIAS,
    overridden: true,
    reason: `"${asked}" is not a Sonnet model — forced to ${SONNET_ALIAS} (email pipeline is Sonnet-only)`,
  };
}

module.exports = { enforce, isSonnet, SONNET_ALIAS };
