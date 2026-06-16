// Schema + match resolution helpers — pure functions, no engine state.
// Extracted so the unit tests can exercise the dual-mode dispatch
// (name vs direct import) without standing up the full lifecycle.

import { minimatch } from 'minimatch'

// Resolve a `match` value to a zod schema. Two forms supported:
//
//   - String  → name lookup via runtime.options.schemas.lookup(name).
//               Requires mikser-io-schemas() to be in plugins[] AND
//               a matching `schemas/<name>.js` file to be loaded.
//   - Object  → assumed zod-shaped. Identified by the safeParse duck-type.
//
// Anything else throws — a missing schema is a config error, not a
// silent skip, because the symptom (extraction never runs) would be
// hard to diagnose otherwise.
export function resolveSchema(spec, { schemasSurface, patternForError } = {}) {
    if (spec == null) {
        throw new Error(`ocr: match value for "${patternForError ?? '(unknown)'}" is null`)
    }
    if (typeof spec === 'string') {
        if (typeof schemasSurface?.lookup !== 'function') {
            throw new Error(
                `ocr: match value "${spec}" is a schema name but runtime.options.schemas is not exposed. ` +
                `Add schemas() from mikser-io-schemas to plugins[] (it must come BEFORE ocr() in the array), ` +
                `or pass the zod object directly instead of its name.`
            )
        }
        const schema = schemasSurface.lookup(spec)
        if (!schema) {
            throw new Error(
                `ocr: schema "${spec}" not registered. ` +
                `Drop a file at schemas/${spec}.js exporting a zod schema as default, ` +
                `or pass the zod object directly instead of its name.`
            )
        }
        return schema
    }
    if (typeof spec.safeParse === 'function') return spec
    throw new Error(
        `ocr: match value for "${patternForError ?? '(unknown)'}" must be a schema name (string) or a zod schema object; got ${typeof spec}`
    )
}

// Normalize a `match` value into { schemaSpec, prompt }. Three forms:
//
//   - string             → schema name; no per-match prompt
//   - zod schema object  → schema directly; no per-match prompt
//   - { schema, prompt } → explicit per-match schema + prompt override
//
// schemaSpec is handed to resolveSchema (which accepts string | zod);
// prompt, when present, overrides the plugin-level prompt for entities
// matched by this pattern. The wrapper form is identified structurally:
// it's an object with a `schema` field and NO top-level safeParse (a
// zod schema exposes safeParse and never a top-level `schema` property,
// so the two shapes can't be confused).
export function normalizeMatchValue(spec) {
    if (
        spec != null &&
        typeof spec === 'object' &&
        typeof spec.safeParse !== 'function' &&
        spec.schema !== undefined
    ) {
        return { schemaSpec: spec.schema, prompt: spec.prompt }
    }
    return { schemaSpec: spec, prompt: undefined }
}

// First glob in `match` whose pattern fires against entity.id wins.
// Returns { pattern, spec } — the raw match value, which the caller
// runs through normalizeMatchValue + resolveSchema. Matches
// mikser-io-layouts' autoLayouts shape: first-wins, predictable.
//
// Patterns are minimatch-style globs against the entity id. `dot: true`
// so paths with leading dots match; `matchBase: false` because we want
// path-prefix matching, not basename-only.
export function pickMatch(entity, match) {
    if (!entity?.id || !match) return null
    for (const [pattern, spec] of Object.entries(match)) {
        if (minimatch(entity.id, pattern, { dot: true })) {
            return { pattern, spec }
        }
    }
    return null
}
