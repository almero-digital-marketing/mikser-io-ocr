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
import { pickMatch, resolveSchema } from './lib/resolve.js'
import { normalizeSteps, resolvePrompt } from './lib/steps.js'
import { buildMessages } from './lib/messages.js'
import { resolveContent } from './lib/content.js'
import { sourceFingerprint, questionFingerprint, readLedger, writeLedger } from './lib/ledger.js'
import { extractWithRetry, DEFAULT_RETRIES } from './lib/attempt.js'

// How many extractions run at once when nothing says otherwise.
//
// Four, not one. Serial was the cautious default and the caution was
// misplaced: the per-document work is a read, a provider call and a write,
// with nothing shared between documents, and at ~50s per report a thousand
// reports is fourteen hours of a cold rebuild — which happens on any config
// change, because the catalog is wiped and only the ledger saves it.
//
// Low enough to sit under a default provider tier rather than being the
// thing that trips its rate limit; `concurrency` is there to raise when the
// budget is known. A provider that does start refusing now has retries with
// jittered backoff in front of it, which is the other half of why this can
// move.
export const DEFAULT_CONCURRENCY = 4

// Whatever the config said, turned into a usable worker count.
//
// Guards the values that would otherwise be taken literally: 0 and negatives
// (p-map rejects them), NaN from a bad env var, and fractions. A malformed
// setting falls back to the default rather than stopping the build — the
// worst outcome of getting this wrong is a slower or faster pass, never a
// wrong one, so refusing to run would be the larger harm.
// Add one journal entry's entity to the work set, if a pattern claims it.
//
// Keyed by ID, because one file can arrive as several journal entries: a
// WebDAV client writes a 4 MB PDF in chunks and every write is a change
// event, so one upload came through as four CREATE rows. Walking rows meant
// four extractions of the same document, started at once under concurrency,
// all before any could write the ledger row that would have stopped the
// others — four full reads, all billed, all but one discarded.
//
// Last entry wins: later rows carry later state, and it is the same file.
export function addPending(pending, entity, match) {
    if (!entity?.id) return pending
    const hit = pickMatch(entity, match)
    if (hit) pending.set(entity.id, { id: entity.id, entity, hit })
    return pending
}

export function resolveConcurrency(value) {
    if (value === undefined || value === null) return DEFAULT_CONCURRENCY
    const n = Math.trunc(Number(value))
    if (!Number.isFinite(n) || n < 1) return 1
    return n
}
import { buildEnvelope, readEnvelope, FAILURE_INSTRUCTION } from './lib/envelope.js'

// The name stopped fitting once a match became a conversation. `extract` is
// the same implementation under the word that describes it: reading a
// document is one of the questions it asks, not the whole job. `ocr` stays,
// because renaming a published entry point would break every consumer to buy
// nothing.
export const extract = (...args) => ocr(...args)

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
            const concurrency = resolveConcurrency(options.concurrency)

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
            // A MAP, keyed by id, because one file can be several journal
            // entries. A WebDAV upload writes in chunks and each write is a
            // change event, so one 4 MB PDF arrived as four CREATE rows —
            // and with concurrency on, all four were extracted at once, in
            // parallel, before any of them could write the ledger row that
            // would have stopped the others. Four full reads of the same
            // document, all billed, all but one thrown away.
            //
            // Last entry wins: later rows carry later state, and the entity
            // is the same file either way.
            const pending = new Map()
            for await (const { entity } of useJournal(
                'OCR scan',
                [OPERATION.CREATE, OPERATION.UPDATE],
                signal,
            )) {
                if (signal.aborted) return
                addPending(pending, entity, options.match)
            }
            if (!pending.size) return

            // id → the meta to merge. Keyed by id because pass three
            // deserializes its own entity objects from the journal rows;
            // the ones gathered above are copies.
            const extracted = new Map()

            await pMap(pending.values(), async ({ entity, hit }) => {
                if (signal.aborted) return

                // A match is a SEQUENCE of questions — see lib/steps.js.
                // Every form that worked before is a sequence of one, so the
                // single-value shapes are unchanged.
                let steps
                try {
                    steps = normalizeSteps(hit.spec, { patternForError: hit.pattern })
                } catch (err) {
                    logger.error('ocr: %s', err.message)
                    return
                }

                // Steps run IN ORDER within one entity, because a later step
                // reads what the earlier ones left. Concurrency is across
                // entities, which is where the independence actually is.
                //
                // `meta` accumulates as we go: step three has to see step
                // one's answer, and the entity object itself is not mutated
                // until pass three.
                let meta = { ...(entity.meta ?? {}) }
                let produced = null

                for (const step of steps) {
                    if (signal.aborted) return
                    const label = step.name ? `${hit.pattern}#${step.name}` : hit.pattern
                    const view = { ...entity, meta }

                    let schema
                    try {
                        schema = resolveSchema(step.schemaSpec, { schemasSurface, patternForError: label })
                    } catch (err) {
                        logger.error('ocr: %s', err.message)
                        return
                    }

                    // Already-satisfied steps skip the call entirely. This is
                    // the read-mostly path on warm builds.
                    if (schema.safeParse(meta).success) {
                        logger.trace('ocr: %s already satisfies %s, skipping', entity.id, label)
                        continue
                    }

                    // A prompt may be a function of the entity, because a
                    // derived question is derived from something — and that
                    // is also how a step says it is not ready yet.
                    const asked = resolvePrompt(step, view, options.prompt)
                    if (asked.skip) {
                        // Quiet: a step waiting for an earlier one is the
                        // normal state of a pipeline mid-build, and the next
                        // cycle picks it up.
                        logger.debug('ocr: %s skipping %s — %s', entity.id, label, asked.skip)
                        continue
                    }
                    if (asked.failed) {
                        // Not fatal — the inputs may exist next cycle — but
                        // not silent either, because a typo in the prompt
                        // throws exactly the same way.
                        logger.warn('ocr: %s could not build the prompt for %s: %s',
                            entity.id, label, asked.failed)
                        continue
                    }

                    const caching = options.cache !== false
                    const identity = caching
                        ? questionFingerprint({
                            schema, model: options.model, prompt: asked.prompt, step: step.name })
                        : null
                    const source = caching ? await sourceFingerprint(entity) : null
                    if (caching) {
                        const remembered = await readLedger(entity, identity, source)
                        if (remembered) {
                            meta = { ...meta, ...remembered }
                            produced = { ...(produced ?? {}), ...remembered }
                            logger.debug('ocr: %s %s restored from the ledger (no model call)',
                                entity.id, label)
                            continue
                        }
                    }

                    // `source: false` asks about what earlier steps put on
                    // meta, not about the document. Attaching a 4 MB PDF
                    // again to ask about a hundred bytes of JSON already in
                    // hand pays for the whole thing twice.
                    let resolved = { content: '' }
                    if (step.source) {
                        const contentResult = await readEntityContent(entity)
                        resolved = await resolveContent(entity, contentResult)
                        if (resolved.skipped) {
                            // WARN, not trace. This entity matched a pattern
                            // the author wrote, so they have said they expect
                            // extraction here — and the alternative is a pass
                            // that finishes in milliseconds, extracts
                            // nothing, and reports success.
                            logger.warn('ocr: %s matched %j but produced no model call: %s',
                                entity.id, label, resolved.skipped)
                            continue
                        }
                    }

                    const messages = await buildMessages({
                        entity: view,
                        contentResult: step.source ? resolved : null,
                        prompt: asked.prompt,
                        extraInstruction: FAILURE_INSTRUCTION,
                    })
                    if (!messages) {
                        logger.warn('ocr: %s matched %j but built no message — please report this.',
                            entity.id, label)
                        continue
                    }

                    // Retried, because these failures were measured to be
                    // transient: a different report failed on each run and
                    // every one succeeded when re-run unchanged, while the
                    // page it fed rendered empty until somebody noticed. See
                    // lib/attempt.js for why a throw and an envelope failure
                    // are not retried the same number of times.
                    const result = await extractWithRetry({
                        retries: options.retries ?? DEFAULT_RETRIES,
                        signal,
                        onRetry: ({ attempt, reason, threw }) => {
                            if (signal.aborted) return   // a restart is not a flaky provider
                            logger.warn('ocr: %s %s attempt %d failed (%s), retrying: %s',
                                entity.id, label, attempt,
                                threw ? 'provider error' : 'model reported failure', reason)
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
                        meta = { ...meta, ...result.data }
                        produced = { ...(produced ?? {}), ...result.data }
                        if (caching) await writeLedger(entity, identity, source, result.data, options.keep)
                        logger.info('ocr: extracted %s (%s)%s', entity.id, label,
                            result.attempts > 1 ? ` after ${result.attempts} attempts` : '')
                    } else if (result.aborted) {
                        // Not a failure of the document or the model: the
                        // cycle was restarted under it. The engine carries
                        // the journal entry into the next cycle, so this is
                        // picked up rather than lost.
                        logger.debug('ocr: %s %s cancelled mid-flight — the next cycle will pick it up',
                            entity.id, label)
                        break
                    } else if (result.threw) {
                        logger.error('ocr: %s %s — generateObject failed after %d attempt(s): %s',
                            entity.id, label, result.attempts, result.reason)
                        // Later steps read what this one was going to leave,
                        // so carrying on would ask a question about an answer
                        // that does not exist.
                        break
                    } else {
                        logger.warn('ocr: %s %s — model could not extract after %d attempt(s): %s',
                            entity.id, label, result.attempts, result.reason)
                        break
                    }
                }

                if (produced) extracted.set(entity.id, produced)
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
