// mikser-io-ocr — schema-driven OCR + structured-data extraction.
//
// One lifecycle plugin. At onProcess, for each new/updated entity:
//
//   1. First-matching glob from `options.match` picks a schema.
//   2. resolveSchema turns the spec into a zod object (string → name
//      lookup via the `schemas` service's lookup; object → direct).
//   3. schema.safeParse(entity.meta) — if it already passes, skip.
//      Hand-authored entities and re-runs of unchanged files don't
//      burn LLM tokens for no reason.
//   4. readEntityContent(entity) routes through the engine's
//      scheme-dispatched provider (fs / gdrive / notion / s3 / etc.)
//      and returns text content OR a path to a cached binary.
//   5. buildMessages turns that into a multi-modal user turn.
//   6. generateObject({ model, schema, messages }) — provider-agnostic
//      via AI SDK. Result is validated by the schema at the model layer.
//   7. Merge into entity.meta. The journal auto-persists the mutation.
//
// What this plugin is NOT:
//   - A pipeline abstraction over providers — that's AI SDK's job.
//   - A schema registry — that's mikser-io-schemas.
//   - A source plugin — entities arrive via documents / files / gdrive /
//     wherever. ocr is purely a consumer.

import pMap from 'p-map'
import { generateObject } from 'ai'
import { readEntityContent, useService } from 'mikser-io'
import { pickMatch, resolveSchema, normalizeMatchValue } from './lib/resolve.js'
import { buildMessages } from './lib/messages.js'
import { resolveContent } from './lib/content.js'
import { sourceFingerprint, questionFingerprint, readLedger, writeLedger } from './lib/ledger.js'
import { extractWithRetry, DEFAULT_RETRIES } from './lib/attempt.js'
import { buildEnvelope, readEnvelope, FAILURE_INSTRUCTION } from './lib/envelope.js'

export function ocr(options = {}) {
    return ({
        runtime, useLogger, useJournal, onProcess,
        constants: { OPERATION },
    }) => {
        if (!options.model) {
            // Defensive — surface the misconfiguration at boot, not
            // mid-cycle when the first matching entity fires.
            onProcess(async () => {
                useLogger().error(
                    'ocr: no `model` configured. Pass an AI SDK model: ocr({ model: openai("gpt-4o-mini") }).'
                )
            })
            return
        }
        if (!options.match || Object.keys(options.match).length === 0) {
            onProcess(async () => {
                useLogger().warn('ocr: no `match` patterns configured — plugin is inert.')
            })
            return
        }

        onProcess(async (signal) => {
            const logger = useLogger()
            const schemasSurface = useService('schemas')
            const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 1) || 1)

            // THREE PASSES, and the shape is not decoration.
            //
            // useJournal writes an entity back by diffing it when the
            // generator RESUMES — that is, when the loop body for that entry
            // completes. Run the bodies concurrently and the generator is
            // pulled forward before any of them has finished, so it diffs an
            // entity nobody has touched yet and writes nothing. Measured over
            // a faithful reproduction of the generator:
            //
            //   pMap concurrency 1 : 6/6 mutations persisted
            //   pMap concurrency 2 : 0/6
            //   pMap concurrency 4 : 0/6
            //
            // Zero. Not a race that usually works — every extraction, gone,
            // with the model still billed for all of them. mikser-io-vector
            // maps over the journal concurrently and is fine only because it
            // writes to an external store and never touches `entity`.
            //
            // So: gather the matched entities first (no mutation, nothing to
            // write back), do the expensive work concurrently OFF the
            // journal, then walk it again and apply each answer inside the
            // body, where the write-back can see it.
            const pending = []
            for await (const { entity } of useJournal(
                'OCR scan',
                [OPERATION.CREATE, OPERATION.UPDATE],
                signal,
            )) {
                if (signal.aborted) return
                const hit = pickMatch(entity, options.match)
                if (hit) pending.push({ id: entity.id, entity, hit })
            }
            if (!pending.length) return

            // id → the meta to merge. Keyed by id because pass three
            // deserializes its own entity objects from the journal rows;
            // the ones gathered above are copies.
            const extracted = new Map()

            await pMap(pending, async ({ entity, hit }) => {
                if (signal.aborted) return

                // A match value is either a bare schema (string name |
                // zod) or a { schema, prompt } wrapper carrying a
                // per-pattern prompt override. Normalize, then resolve
                // the schema spec. resolveSchema throws on a
                // misconfigured spec — let it crash the cycle rather
                // than silently skipping; config errors should be loud.
                const { schemaSpec, prompt: matchPrompt } = normalizeMatchValue(hit.spec)
                let schema
                try {
                    schema = resolveSchema(schemaSpec, { schemasSurface, patternForError: hit.pattern })
                } catch (err) {
                    logger.error('ocr: %s', err.message)
                    return
                }

                // Already-satisfied entities skip the LLM call entirely.
                // This is the read-mostly path on warm builds — most
                // entities already have valid meta and don't need re-ext.
                if (schema.safeParse(entity.meta ?? {}).success) {
                    logger.trace('ocr: %s already satisfies schema, skipping', entity.id)
                    return
                }

                // The catalog is a derived cache and mikser wipes it on any
                // config change, so the gate above holds only until someone
                // edits a comment in mikser.config.js. The ledger is the
                // second gate and it outlives the catalog: a document is read
                // once per version of itself, whatever happens to the cache.
                //
                // Identity covers the document AND the question — schema,
                // model, prompt — because a stored answer to a different
                // question is worse than paying for the call. See lib/ledger.js.
                const caching = options.cache !== false
                const effectivePrompt = matchPrompt ?? options.prompt
                const identity = caching
                    ? questionFingerprint({ schema, model: options.model, prompt: effectivePrompt })
                    : null
                const source = caching ? await sourceFingerprint(entity) : null
                if (caching) {
                    const remembered = await readLedger(entity, identity, source)
                    if (remembered) {
                        extracted.set(entity.id, remembered)
                        logger.debug('ocr: %s restored from the extraction ledger (no model call)', entity.id)
                        return
                    }
                }

                // Fetch content via the scheme-dispatched provider.
                // Returns { content } (text) | { contentSkipped, cachedAt }
                // (binary) | { contentError } (failure).
                const contentResult = await readEntityContent(entity)

                // Normalize the engine's four answers into text, a path, or
                // a reason. Handles the two cases that used to end the pass
                // in silence: a local binary core declined to decode, and a
                // binary a `content: true` source had already mangled into a
                // string. See lib/content.js.
                const resolved = await resolveContent(entity, contentResult)
                if (resolved.skipped) {
                    // WARN, not trace. This entity matched a pattern the
                    // author wrote, so they have said they expect extraction
                    // here — and the alternative is a pass that finishes in
                    // milliseconds, extracts nothing, and reports success.
                    logger.warn('ocr: %s matched %j but produced no model call: %s',
                        entity.id, hit.pattern, resolved.skipped)
                    return
                }

                // Prompt precedence: per-match override → plugin-level
                // prompt → buildMessages' built-in DEFAULT_PROMPT. The
                // failure instruction is always appended so the model
                // knows it can report an unprocessable source instead
                // of fabricating values to satisfy the schema.
                const messages = await buildMessages({
                    entity,
                    contentResult: resolved,
                    prompt: effectivePrompt,
                    extraInstruction: FAILURE_INSTRUCTION,
                })
                if (!messages) {
                    // resolveContent has already ruled out every no-content
                    // case, so reaching here means the two disagree. Loud,
                    // because it is a bug in this plugin rather than in a
                    // project's config.
                    logger.warn('ocr: %s matched %j but built no message — please report this.',
                        entity.id, hit.pattern)
                    return
                }

                // generateObject runs against the ENVELOPE, not the bare
                // schema, so the model has a first-class failure branch. On
                // failure we write nothing — the entity stays unsatisfied,
                // which mikser-io-schemas already surfaces as a
                // pending/broken entity. No parallel error store; the
                // existing schema-validation surface is the single source of
                // truth for "this didn't extract".
                //
                // Retried, because these failures were measured to be
                // transient: a different report failed on each run and every
                // one succeeded when re-run unchanged, while the page it fed
                // rendered empty until somebody noticed. See lib/attempt.js
                // for why a throw and an envelope failure are not retried the
                // same number of times.
                const result = await extractWithRetry({
                    retries: options.retries ?? DEFAULT_RETRIES,
                    signal,
                    onRetry: ({ attempt, reason, threw }) => {
                        logger.warn('ocr: %s attempt %d failed (%s), retrying: %s',
                            entity.id, attempt, threw ? 'provider error' : 'model reported failure', reason)
                    },
                    call: async () => {
                        const { object } = await generateObject({
                            model:       options.model,
                            schema:      buildEnvelope(schema),
                            messages,
                            abortSignal: signal,
                            ...(options.generateObjectOptions ?? {}),
                        })
                        return readEnvelope(object)
                    },
                })

                if (result.ok) {
                    extracted.set(entity.id, result.data)
                    // Recorded only after a successful extraction — a failure
                    // is not an answer worth keeping, and the entity staying
                    // unsatisfied is what mikser-io-schemas reports on.
                    if (caching) await writeLedger(entity, identity, source, result.data, options.keep)
                    logger.info('ocr: extracted %s (pattern %s)%s', entity.id, hit.pattern,
                        result.attempts > 1 ? ` after ${result.attempts} attempts` : '')
                } else if (result.threw) {
                    logger.error('ocr: %s — generateObject failed after %d attempt(s): %s',
                        entity.id, result.attempts, result.reason)
                } else {
                    logger.warn('ocr: %s — model could not extract (pattern %s) after %d attempt(s): %s',
                        entity.id, hit.pattern, result.attempts, result.reason)
                }
            }, { concurrency, signal })

            if (!extracted.size) return

            // Pass three: apply. The mutation happens inside the body, which
            // is the only place useJournal's write-back can see it.
            for await (const { entity } of useJournal(
                'OCR apply',
                [OPERATION.CREATE, OPERATION.UPDATE],
                signal,
            )) {
                const data = extracted.get(entity.id)
                if (!data) continue
                entity.meta = { ...(entity.meta ?? {}), ...data }
            }
        })
        // Names this package to the runtime's loaded-plugin record, so
        // ping reports it as running rather than as undetectable.
        return { module: import.meta.url }
    }
}
