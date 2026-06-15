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

// First glob in `match` whose pattern fires against entity.id wins.
// Returns the schema spec from the map (which may be a string or
// a zod object) — caller passes it through resolveSchema. Matches
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
