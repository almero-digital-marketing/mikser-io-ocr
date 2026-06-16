// Success/error envelope around the user's extraction schema.
//
// The problem it solves: generateObject with a strict schema FORCES
// the model to produce a value for every required field. When the
// source is unreadable, blank, the wrong document, or corrupted, the
// model has no way to say "I can't" — so it fabricates values to
// satisfy the schema, and the garbage lands on entity.meta looking
// like a real extraction. There is no signal that anything went wrong.
//
// The fix: wrap the user's schema in an envelope that gives the model
// a first-class failure branch. `data` is only required when
// `success` is true; on failure the model sets success=false, fills
// `error`, and leaves data null — no fabrication needed.
//
// A flat object (not a discriminated union) is used deliberately:
// it's the shape with the broadest support across generateObject's
// per-provider structured-output modes (OpenAI strict JSON schema,
// Anthropic / Google tool calling). The prompt instruction below
// lives in the same file as the schema so the field names it
// references can never drift from the schema that defines them.

import { z } from 'zod'

// Appended to the extraction prompt. References the envelope's field
// names — keep in sync with buildEnvelope by keeping them co-located.
export const FAILURE_INSTRUCTION =
    'If you cannot reliably extract the requested data because the source is ' +
    'unreadable, blank, the wrong kind of document, or corrupted, set `success` ' +
    'to false and give a brief reason in `error`, and leave `data` null. Do not ' +
    'invent, guess, or approximate values to satisfy the schema — a confident ' +
    'wrong extraction is worse than an honest failure.'

// Wrap a resolved (zod) user schema in the envelope. `data` is
// nullable so the model can omit it on the failure branch.
export function buildEnvelope(schema) {
    return z.object({
        success: z.boolean(),
        error:   z.string().nullable(),
        data:    schema.nullable(),
    })
}

// Interpret an envelope result from generateObject. Returns
// { ok: true, data } on a usable extraction, or { ok: false, reason }
// otherwise. Defensive: a model that claims success but returns no
// data is treated as a failure — we never write a null/partial
// extraction onto the entity.
export function readEnvelope(object) {
    if (object && object.success === true && object.data != null) {
        return { ok: true, data: object.data }
    }
    return {
        ok: false,
        reason: (object && object.error) || 'model reported it could not process the source',
    }
}
