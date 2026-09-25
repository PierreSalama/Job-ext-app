'use strict';
// ============================================================================
//  MAKE A JSON SCHEMA ACCEPTABLE TO OPENAI STRUCTURED OUTPUTS.
//
//  Measured live 2026-09-08. Codex is first in the provider chain, at Pierre's instruction, and
//  EVERY structured call to it was failing:
//
//      codex exited 1: Invalid schema for response_format 'codex_output_schema':
//      In context=(), 'additionalProperties' is required to be supplied and to be false
//
//  Not a quota problem, not a login problem — the schemas JAT already used were simply not in the
//  shape OpenAI's strict mode demands. So the first provider burned 9 to 31 seconds failing on every
//  call before the chain fell through, and when Claude then failed to parse and the peer was
//  unreachable, an agent run hung at step 0 with a browser open.
//
//  Strict mode has two requirements beyond ordinary JSON Schema, and both are easy to miss because
//  a schema without them is perfectly valid JSON Schema:
//
//    1. every object must carry `additionalProperties: false`
//    2. every object's `required` must list EVERY key in `properties` — optionality is expressed by
//       allowing null in the type, not by omitting the key
//
//  This transforms a schema to satisfy both, without the callers having to know. It is deliberately
//  a pure function over a copy: the original schema objects are shared across calls, and mutating
//  them in place would leak this provider's rules into Claude's and Ollama's requests too.
// ============================================================================

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Walks the schema and returns a NEW one that satisfies OpenAI strict mode.
function toStrictSchema(node) {
  if (Array.isArray(node)) return node.map(toStrictSchema);
  if (!isPlainObject(node)) return node;

  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = toStrictSchema(v);

  // Only object nodes need the treatment. A node counts as an object if it says so, or if it
  // carries `properties` — plenty of hand-written schemas omit the explicit type.
  const looksObject = out.type === 'object'
    || (out.type === undefined && isPlainObject(out.properties));
  if (!looksObject) return out;

  out.additionalProperties = false;

  if (isPlainObject(out.properties)) {
    const keys = Object.keys(out.properties);
    // Strict mode requires every property to be listed. A property that was genuinely optional
    // keeps its meaning by ALSO accepting null, so nothing the caller expected becomes mandatory
    // in practice — it just has to be present in the response.
    const previouslyRequired = new Set(Array.isArray(out.required) ? out.required : []);
    for (const k of keys) {
      if (previouslyRequired.has(k)) continue;
      const p = out.properties[k];
      if (!isPlainObject(p)) continue;
      if (p.type !== undefined) {
        const types = Array.isArray(p.type) ? p.type.slice() : [p.type];
        if (!types.includes('null')) { types.push('null'); p.type = types; }
      }
    }
    out.required = keys;
  }
  return out;
}

module.exports = { toStrictSchema };
