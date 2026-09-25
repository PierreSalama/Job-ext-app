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
// The cheap tier, for calls whose output is a SHAPE rather than prose.
const HAIKU_ALIAS = 'haiku';

// Anything that names Sonnet is fine — the alias, or a full id like claude-sonnet-4-6 /
// claude-sonnet-5. Everything else is not, including an empty value (which means "CLI default").
function isSonnet(model) {
  return /(^|[-_/])sonnet([-_.]|$)|sonnet-?\d/i.test(String(model || ''));
}

// STRUCTURED WORK CAN GO CHEAP. PROSE CANNOT.
//
// Pierre, 2026-09-07: "always use cheaper, easier models to keep the cost low while also still
// giving us the result we want." Those two halves pull against each other, and the line between
// them is not the task name — it is whether the output is a SHAPE or a VOICE.
//
// A call that carries a `schema` is asking for a fixed structure: pick a tool, classify a field,
// return {answer, confidence}. The shape is validated on arrival, so a weaker model that gets it
// wrong is caught rather than believed, and Haiku is comfortably good enough for it.
//
// A call with NO schema is free prose: a resume bullet, a cover letter, an answer to "why do you
// want to work here". That is the text a recruiter reads and decides on, and it is exactly where a
// cheaper model produces the flat, over-connected writing the voice gate exists to reject. Saving
// quota there costs interviews, which is the only thing this system is for. So it stays Sonnet.
//
// OPUS IS STILL UNREACHABLE by any path, which was the point of the original module.
function tierFor({ schema } = {}) {
  return schema ? HAIKU_ALIAS : SONNET_ALIAS;
}

function isHaiku(model) {
  return /(^|[-_/])haiku([-_.]|$)|haiku-?\d/i.test(String(model || ''));
}

// The one function callers use. Returns the model to pass to the CLI, plus whether a request was
// overridden, so the caller can log it instead of silently swapping models under the user.
//
// `opts.schema` selects the tier when nothing was explicitly requested. An explicit Sonnet or Haiku
// request is always honoured — the email pipeline pins Sonnet that way and is unaffected by tiering.
function enforce(requested, opts = {}) {
  const asked = String(requested || '').trim();
  const tier = tierFor(opts);
  if (!asked) {
    return {
      model: tier,
      overridden: false,
      reason: tier === HAIKU_ALIAS
        ? 'no model requested, structured output — cheap tier'
        : 'no model requested — pinned to Sonnet (prose)',
    };
  }
  if (isSonnet(asked) || isHaiku(asked)) return { model: asked, overridden: false, reason: '' };
  return {
    model: tier,
    overridden: true,
    reason: `"${asked}" is neither Sonnet nor Haiku — forced to ${tier}`,
  };
}

module.exports = { enforce, isSonnet, isHaiku, tierFor, SONNET_ALIAS, HAIKU_ALIAS };
