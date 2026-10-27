// What a restart should look for: matched documents that have no answer.
//
// The requeue (lib/requeue.js) only knows about failures it saw. Everything
// that failed before it existed — the 176 reports the spend cap left blank,
// under 11.8.0, which wrote nothing down — and anything whose row was lost
// would wait for a file change or a catalog wipe. And a restart is the thing
// somebody does when the provider is back: it was the first thing tried on
// 27.10, and it asked about 2 documents out of 178.
//
// So the first pass after startup walks the catalog for documents this ocr()
// call matches and asks, for each, the questions the pass itself would ask
// before paying for a call: does meta already satisfy the step, and does the
// ledger already hold the answer. A document that gets "no" to both, for a
// step that is ready to be asked, is queued.
//
// What it deliberately does not queue:
//
//   - a document the model DECLINED, at this version of the file. That is
//     its answer, and asking again on every restart would pay for the same
//     refusal at every deploy (see `declined` in lib/requeue.js);
//   - a step whose prompt says it is not ready — it is waiting on something
//     other than the model;
//   - a document whose answer is in the ledger but not on meta. Queueing it
//     would cost no model call, but a later plugin that reshapes those fields
//     would make it look unanswered on every restart, and re-render it each
//     time for nothing.

import { normalizeSteps, resolvePrompt, cacheKeyFor } from './steps.js'
import { resolveSchema } from './resolve.js'
import { sourceFingerprint, sourceFor, questionFingerprint, recallAnswer } from './ledger.js'

/**
 * The first step of `hit` that the model would have to be asked, for an
 * entity as it stands in the catalog — or null when nothing is owed.
 */
export async function unansweredStep(entity, hit, { schemasSurface, options = {} } = {}) {
    let steps
    try {
        steps = normalizeSteps(hit.spec, { patternForError: hit.pattern })
    } catch {
        // A config error. The pass reports it for every entity it reaches,
        // so the sweep does not say it again.
        return null
    }
    const caching = options.cache !== false
    const document = caching ? await sourceFingerprint(entity) : null
    let meta = { ...(entity.meta ?? {}) }

    for (const step of steps) {
        const label = step.name ? `${hit.pattern}#${step.name}` : hit.pattern
        let schema
        try {
            schema = resolveSchema(step.schemaSpec, { schemasSurface, patternForError: label })
        } catch {
            return null
        }
        if (schema.safeParse(meta).success) continue

        const asked = resolvePrompt(step, { ...entity, meta }, options.prompt)
        if (asked.skip || asked.failed) return null

        if (caching) {
            const identity = questionFingerprint({
                schema, model: options.model,
                prompt: cacheKeyFor(step, asked.prompt, { ...entity, meta }),
                step: step.name })
            // Found under the prompt alone, it is answered: the pass files it
            // under the key without asking.
            const asPrompt = step.key !== undefined
                ? questionFingerprint({ schema, model: options.model, prompt: asked.prompt, step: step.name })
                : null
            const { answer: remembered } = await recallAnswer(entity, identity, asPrompt, sourceFor(step, document))
            if (remembered) {
                // A later step reads what this one left, so it is judged
                // against meta as the pass would have it.
                meta = { ...meta, ...remembered }
                continue
            }
        }
        return label
    }
    return null
}

// The literal start of a glob: everything before its first special character.
// Every id the pattern can match starts with it.
export function literalPrefix(pattern) {
    const at = String(pattern).search(/[*?[\]{}()!+@\\]/)
    return at < 0 ? String(pattern) : String(pattern).slice(0, at)
}

/**
 * Catalog queries covering every id the patterns can match, or [null] for
 * "walk everything".
 *
 * A range on `id` rather than an unfiltered walk, because the catalog pushes
 * `id` comparisons into SQL and parses only the rows in range. Unfiltered,
 * the sweep would JSON.parse every entity on the site at every startup to
 * find a few hundred reports. A pattern that starts with a wildcard has no
 * prefix to narrow by, and then the whole catalog is the honest answer.
 */
export function idRanges(patterns) {
    const prefixes = [...new Set((patterns ?? []).map(literalPrefix))].sort()
    if (!prefixes.length || prefixes.includes('')) return [null]
    // Sorted, so a prefix that another one extends comes first and its range
    // already covers the longer one.
    const kept = prefixes.filter((prefix, index) =>
        !prefixes.slice(0, index).some(shorter => prefix.startsWith(shorter)))
    return kept.map(prefix => ({ id: { $gte: prefix, $lt: successor(prefix) } }))
}

// The first string that sorts after every string starting with `prefix`.
function successor(prefix) {
    const last = prefix.charCodeAt(prefix.length - 1)
    return prefix.slice(0, -1) + String.fromCharCode(last + 1)
}
