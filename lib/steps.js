// A match is a SEQUENCE of questions about one entity, not a single reading.
//
// Real pipelines ask more than once. Reported shape:
//
//   1. read the report        model, needs the PDF
//   2. derive the findings    CODE, no model
//   3. explain each finding   model, needs only what step 1 extracted
//
// Step 2 being code is the point, not an omission: asking the model for the
// findings was tried and was not stable — same report, same prompt, five
// findings one run and two the next, with identical measurements. So this is
// not a chat transcript. It is a chain of questions with ordinary code
// between them, each reading what the ones before it left on `entity.meta`,
// and a step that is not a model call stays a plugin in the pipeline.
//
// Only the first question was first-class before. The later ones got
// hand-rolled: no retry, no concurrency, and answers living only in
// `entity.meta`, so the catalog wipe on any config change destroyed them —
// ninety seconds of sequential model calls re-paid whenever anybody edited a
// comment in config/.
//
// THE NAME IS THE IDENTITY. A step's name goes into its ledger key, so
// reordering the array must not silently invalidate paid-for answers, and an
// unnamed step in a sequence is refused rather than numbered. Single-value
// matches — the form that existed before sequences — keep the empty name, so
// the rows they already wrote are still theirs.

export const LEGACY_STEP = ''

/**
 * Normalize a match value into an ordered list of steps.
 *
 * Accepts every form that worked before — a schema name, a zod schema, a
 * { schema, prompt } wrapper — plus an array of steps.
 *
 * Returns [{ name, schemaSpec, prompt, source }].
 */
export function normalizeSteps(spec, { patternForError } = {}) {
    if (Array.isArray(spec)) {
        if (!spec.length) {
            throw new Error(
                `ocr: match value for "${patternForError ?? '(unknown)'}" is an empty array — ` +
                'a sequence needs at least one step.')
        }
        const seen = new Set()
        return spec.map((step, index) => {
            const normalized = normalizeStep(step, { patternForError, index })
            if (!normalized.name) {
                throw new Error(
                    `ocr: step ${index} of "${patternForError ?? '(unknown)'}" has no \`name\`. ` +
                    'A step is identified by its name in the extraction ledger, so numbering it by ' +
                    'position would silently discard its answers the first time the array is reordered.')
            }
            if (seen.has(normalized.name)) {
                throw new Error(
                    `ocr: "${patternForError ?? '(unknown)'}" has two steps named "${normalized.name}". ` +
                    'Names are ledger keys, so the second would overwrite the first.')
            }
            seen.add(normalized.name)
            return normalized
        })
    }
    return [normalizeStep(spec, { patternForError, legacy: true })]
}

function normalizeStep(step, { patternForError, legacy = false } = {}) {
    // A wrapper is an object carrying `schema` and no top-level safeParse —
    // a zod schema exposes safeParse and never a top-level `schema`, so the
    // two shapes cannot be confused.
    const isWrapper = step != null
        && typeof step === 'object'
        && typeof step.safeParse !== 'function'
        && step.schema !== undefined

    if (isWrapper) {
        return {
            name: legacy ? LEGACY_STEP : (step.name ?? ''),
            schemaSpec: step.schema,
            prompt: step.prompt,
            // An explicit cache identity for the question, replacing the
            // prompt text in the fingerprint.
            //
            // A prompt change has to invalidate by default: a prompt is free
            // text and its effect is unbounded, so a stored answer cannot be
            // checked against it the way it can against a schema. But the
            // author knows which edits are material, and re-reading everything
            // after rewording a sentence of guidance is a real cost — twice,
            // for the consumer who asked for this. `key` hands them that
            // judgement: reword freely, bump the key when the question
            // actually changed.
            key: step.key,
            // Attaching the document again to ask about a hundred bytes of
            // JSON already on meta pays for the whole PDF a second time.
            source: step.source !== false,
        }
    }
    return { name: LEGACY_STEP, schemaSpec: step, prompt: undefined, source: true, key: undefined }
}

// What identifies this question in the ledger: the author's explicit `key`
// when they gave one, otherwise the resolved prompt text.
//
// Separate from resolvePrompt because the two answer different questions —
// what to SEND the model, and what to FILE the answer under. Conflating them
// is how a `key` ends up ignored while the README promises it works.
export function cacheKeyFor(step, resolvedPrompt) {
    return step?.key ?? resolvedPrompt
}

/**
 * Resolve a step's prompt for one entity.
 *
 * A string prompt is the same question for every document a pattern matches.
 * A derived question is derived from something, so a prompt may be a
 * function of the entity — which is also how a step declares it is not ready
 * yet: returning null/undefined skips it, and the next cycle picks it up,
 * exactly as an unsatisfied schema already does.
 *
 * Returns { prompt } | { skip: reason } | { failed: message }.
 */
export function resolvePrompt(step, entity, fallback) {
    const raw = step.prompt ?? fallback
    if (typeof raw !== 'function') return { prompt: raw }
    let value
    try {
        value = raw(entity)
    } catch (err) {
        // A prompt function reading `entity.meta.findings.join(...)` before
        // findings exists throws, and that is the ordinary way to express
        // "not ready" by accident. Not fatal — the next cycle may well have
        // it — but not silent either, because the same throw is what a typo
        // in the prompt looks like.
        return { failed: err?.message ?? String(err) }
    }
    if (value === null || value === undefined) {
        return { skip: 'its prompt returned nothing, so its inputs are not ready yet' }
    }
    return { prompt: String(value) }
}
