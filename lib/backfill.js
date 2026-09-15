// An additive schema edit must not re-read the document.
//
// `schema_hash` is over the whole schema, so any edit missed every existing
// row. Reported: one field added to a forty-field schema over 8-page 4 MB
// PDFs re-read all twelve documents — 4m44s and a full bill — to obtain one
// number each. At a thousand documents that is about six and a half hours.
// Nothing was stale and nothing had failed; the stored answers were correct
// for all the fields they shared.
//
// The fix is not a tolerant hash. Hashing "the shape that constrains the
// answer" would make an optional addition match the old row and return the
// old answer — and then the new field is simply absent, forever, with
// nothing saying so. That trades a bill for silent incompleteness.
//
// So zod decides instead of a heuristic: take the answer stored under a
// PREVIOUS schema and validate it against the CURRENT one.
//
//   - It passes  → the stored answer is a valid answer to the new question.
//                  Reuse it, no model call at all. This is every `.optional()`
//                  addition, which is most of them.
//   - It fails   → something really is missing. Ask for ONLY the fields that
//                  are missing, and merge. For a `source: false` step that is
//                  nearly free; for one that sends a document it still sends
//                  it, but asks for one field instead of forty.
//
// Both paths end with the merged answer validated against the full schema
// before it is stored, so a backfill cannot leave a row that does not answer
// the question it is filed under.

// Does a stored answer satisfy the schema as it is now?
export function satisfies(schema, answer) {
    if (!answer || typeof answer !== 'object') return false
    return Boolean(schema?.safeParse?.(answer)?.success)
}

// The first stored answer that is still a valid answer to the current
// question. Priors arrive newest first.
export function reusablePrior(schema, priors) {
    for (const prior of priors ?? []) {
        if (satisfies(schema, prior)) return prior
    }
    return null
}

// Which fields the stored answer does not already provide.
//
// Asked per field, through the schema's own validator for that field, so
// "missing" means what zod means — absent, null where null is not allowed,
// or the wrong type — rather than a guess about object keys.
//
// Returns [] when nothing is missing, and null when this cannot be worked
// out: a schema that is not an object has no fields to pick, and a caller
// must do the whole extraction rather than a partial one.
export function missingFields(schema, prior) {
    const shape = schema?.shape
    if (!shape || typeof schema.pick !== 'function') return null
    if (!prior || typeof prior !== 'object') return null

    const missing = []
    for (const key of Object.keys(shape)) {
        const field = shape[key]
        const value = prior[key]
        // `undefined` for an optional field is legitimately satisfied, which
        // is why this asks the field's own schema rather than testing for
        // presence.
        if (!field?.safeParse || !field.safeParse(value).success) missing.push(key)
    }
    return missing
}

// A schema for just the missing fields, to ask the smallest question that
// closes the gap. Null when a partial ask is not possible.
export function partialSchema(schema, missing) {
    if (!missing?.length || typeof schema?.pick !== 'function') return null
    try {
        return schema.pick(Object.fromEntries(missing.map(key => [key, true])))
    } catch {
        return null
    }
}

/**
 * Work out how to answer the current question given what is already stored.
 *
 * Returns one of:
 *   { reuse }                  — a stored answer still satisfies the schema
 *   { backfill, prior, fields } — ask `backfill` for `fields`, merge onto `prior`
 *   null                        — nothing stored helps; do the full extraction
 */
export function planFromPriors(schema, priors) {
    const reuse = reusablePrior(schema, priors)
    if (reuse) return { reuse }

    for (const prior of priors ?? []) {
        const missing = missingFields(schema, prior)
        // No fields missing yet not satisfying the whole schema means the
        // failure is at the object level — a refinement, a strict() rejecting
        // an extra key — and a partial ask would not fix it.
        if (!missing || !missing.length) continue
        // Everything missing is the same as nothing stored, and asking for
        // every field IS the full extraction, without the merge risk.
        if (missing.length === Object.keys(schema.shape).length) continue
        const backfill = partialSchema(schema, missing)
        if (backfill) return { backfill, prior, fields: missing }
    }
    return null
}
