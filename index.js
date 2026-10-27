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
// A call that THREW is written down and asked again later, on its own, with
// a growing delay (lib/requeue.js); the first pass after startup also looks
// for matched documents with no answer at all (lib/sweep.js). Without either,
// a document only came back when its file changed — see 27.10.2026 in
// lib/requeue.js.
//
// What this plugin is NOT:
//   - A pipeline abstraction over providers — that's AI SDK's job.
//   - A schema registry — that's mikser-io-schemas.
//   - A source plugin — entities arrive via documents / files / gdrive /
//     wherever. ocr is purely a consumer.

import path from 'node:path'
import pMap from 'p-map'
import { generateObject } from 'ai'
import { readEntityContent, useService } from 'mikser-io'
import { pickMatch, resolveSchema } from './lib/resolve.js'
import { normalizeSteps, resolvePrompt, cacheKeyFor, resolveAttachments } from './lib/steps.js'
import { planFromPriors, satisfies } from './lib/backfill.js'
import { buildMessages } from './lib/messages.js'
import { resolveContent } from './lib/content.js'
import { sourceFingerprint, sourceFor, questionFingerprint, readLedger, writeLedger, readPriorAnswers } from './lib/ledger.js'
import { extractWithRetry, DEFAULT_RETRIES } from './lib/attempt.js'
import {
    resolveRequeue, matchKey, readRequeue, isDue, nextRetryAt, recordRetry, recordDeclined,
    recordReimport, queueNow, clearRequeue, createBreaker, describeDelay, DECLINED, REIMPORT,
} from './lib/requeue.js'
import { unansweredStep, idRanges } from './lib/sweep.js'

// The provider call, replaceable so a test can drive a whole pass — a
// failure, the retry, the answer — without a provider. ai's own mock models
// change shape between majors, and the suite runs against whichever major
// npm resolves, so a test built on one would break on the next.
let generate = generateObject
export function __setGenerateObjectForTests(fn) {
    generate = fn ?? generateObject
}

// setTimeout cannot wait longer than this; a later retry wakes early and
// goes back to sleep.
const LONGEST_TIMEOUT = 2_147_483_647

// How often a due retry looks again while a cycle is still running.
const CYCLE_POLL_MS = 1000

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
// Said ONCE per step, the first time a schema change is found to need work.
//
// Nothing warned at all before: twelve documents was a shrug, a thousand
// would have been six and a half hours nobody asked for. The count is the
// documents in this pass, which is the upper bound on what will be read.
const schemaChangeReported = new Set()
function reportSchemaChange(logger, label, documents, fields) {
    if (schemaChangeReported.has(label)) return
    schemaChangeReported.add(label)
    logger.notice(
        { code: 'ocr-schema-changed', step: label, documents, fields },
        'ocr: the schema for %s changed — up to %d document(s) will be asked again, for %j. '
        + 'Fields the stored answers already satisfy are not re-read.',
        label, documents, fields)
}

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
        runtime, useLogger, useJournal, onProcess, onProcessed,
        findEntity, iterateEntities, updateEntity, updatedHook, triggeredHook,
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

        // null when `requeue: false` — nothing recorded, nothing asked again.
        const requeue = resolveRequeue(options.requeue)

        // Pattern → the key this call's requeue rows are filed under. A
        // pattern whose steps do not normalize has no key; the pass reports
        // that for every entity it reaches.
        const keyOf = new Map()
        for (const [pattern, spec] of Object.entries(options.match)) {
            try {
                keyOf.set(pattern, matchKey(pattern, normalizeSteps(spec, { patternForError: pattern })))
            } catch { /* reported per entity by the pass */ }
        }
        const keys = [...keyOf.values()]

        // Answered on a later attempt, waiting for the cycle to end so their
        // source can import them again. id → { collection, relativePath }.
        const reimports = new Map()
        let timer = null
        let lastWake = 0
        let swept = false

        // Only a process that stays up has a "later" to ask in. A one-shot
        // build exits after its cycle, and the next one's startup sweep is
        // its retry.
        const lasting = () => Boolean(runtime.options?.watch || runtime.options?.server)

        async function arm() {
            clearTimeout(timer)
            timer = null
            if (!requeue || !lasting()) return
            if (reimports.size) return sleepUntil(Date.now())
            const at = await nextRetryAt(keys)
            // Never more than one cycle per `first` from here. A row the pass
            // cannot move — a durable store that reads but will not write —
            // stays due, and without a floor every cycle would start the next
            // one the moment it ended.
            if (at !== null) sleepUntil(Math.max(at, lastWake + requeue.first))
        }

        function sleepUntil(at) {
            clearTimeout(timer)
            timer = setTimeout(() => wake(at), Math.min(LONGEST_TIMEOUT, Math.max(0, at - Date.now())))
            // A pending retry must not be what keeps a process alive.
            timer.unref?.()
        }

        async function wake(at) {
            timer = null
            if (Date.now() < at) return sleepUntil(at)
            // Never while a cycle is running. A trigger does not queue
            // behind the cycle in flight: runtime.process() CANCELS it and
            // starts again, which would abort extractions already being paid
            // for, and a re-import journaled mid-cycle is half-applied and
            // then cleared at finalize (mikser-io's manager.js, `deliver`).
            // `processing` is true for the whole cycle, gaps between phases
            // included — which is why this needs mikser-io 11.14.0.
            if (runtime.processing) return sleepUntil(Date.now() + CYCLE_POLL_MS)
            const logger = useLogger()
            lastWake = Date.now()
            try {
                // The documents a retry answered go back through their
                // source exactly as an edited file would, so every plugin
                // after this one derives from the answer instead of from
                // the page as it was rendered without it.
                const waiting = [...reimports.values()]
                reimports.clear()
                for (const { collection, relativePath } of waiting) {
                    await updatedHook(collection, { relativePath })
                }
                // And a cycle for the retries that are due. The engine
                // debounces triggers, so this and the re-imports above are
                // one cycle, not two.
                await triggeredHook('ocr-requeue', { plugin: 'ocr' })
            } catch (err) {
                logger.warn('ocr: could not start the cycle that asks again: %s', err?.message ?? err)
            }
        }

        // After every cycle's process phase, whichever started it — including
        // the ones where this call had nothing in the journal.
        if (requeue) onProcessed(() => arm())

        // Where a recovered document's file lives, when it came from a
        // folder source — the only kind that can be asked to import one
        // file again. Anything else (a sheet row, a drive document) is
        // updated in place instead.
        function reimportTarget(entity) {
            const folder = runtime.options?.sourceFolders?.[entity?.collection]
            if (!folder || typeof entity.uri !== 'string' || !path.isAbsolute(entity.uri)) return null
            const relativePath = path.relative(folder, entity.uri)
            if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null
            return { collection: entity.collection, relativePath }
        }

        // Matched documents in the catalog that nobody asked about — see
        // lib/sweep.js. Null when the cycle was cancelled mid-walk.
        async function sweep(pending, rows, { schemasSurface, signal }) {
            const found = []
            const seen = new Set()
            for (const range of idRanges(Object.keys(options.match))) {
                for await (const entity of iterateEntities(range ?? undefined)) {
                    if (signal.aborted) return null
                    if (!entity?.id || seen.has(entity.id) || pending.has(entity.id)) continue
                    seen.add(entity.id)
                    const hit = pickMatch(entity, options.match)
                    const key = hit && keyOf.get(hit.pattern)
                    if (!key) continue
                    const previous = rows.get(entity.id)
                    if (isDue(previous)) continue
                    const source = await sourceFingerprint(entity)
                    let step = previous?.step ?? ''
                    // A re-import that never landed is queued as it is: its
                    // answer is in the ledger, so the check below would call
                    // it answered and leave the page without it.
                    if (previous?.kind !== REIMPORT) {
                        if (previous?.kind === DECLINED && (previous.source ?? null) === (source ?? null)) continue
                        step = await unansweredStep(entity, hit, { schemasSurface, options })
                        if (!step) continue
                    }
                    found.push({ id: entity.id, entity, hit, key, step, source, previous })
                }
            }
            return found
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

            // The documents owed an answer from before: a call that threw,
            // and — on the first pass — anything matched that has no answer
            // at all. They are NOT journal entries, so they are asked off the
            // catalog's copy, and only an answer puts them back into the
            // pipeline (see `recovered` and `reimports` below). A retry the
            // provider refuses again touches nothing else in the build.
            let rows = requeue ? await readRequeue(keys) : new Map()
            const sweptIds = new Set()
            if (requeue && !swept) {
                const found = await sweep(pending, rows, { schemasSurface, signal })
                if (found === null || signal.aborted) return
                swept = true
                for (const { id } of found) sweptIds.add(id)
                if (found.length) {
                    logger.info('ocr: %d matched document(s) have no answer yet (%s) — asking now',
                        found.length, [...new Set(found.map(f => f.step))].join(', '))
                    // Queued durably, so a cycle cancelled before reaching
                    // them does not lose them. With nowhere to queue them,
                    // asked in this pass instead.
                    if (await queueNow(found, keys) < found.length) {
                        for (const { id, entity, hit } of found) {
                            pending.set(id, { id, entity, hit, requeued: true })
                        }
                    }
                    rows = await readRequeue(keys)
                }
            }
            if (requeue) {
                const now = Date.now()
                let due = 0
                for (const row of rows.values()) {
                    if (!isDue(row, now) || pending.has(row.id)) continue
                    if (signal.aborted) return
                    const entity = await findEntity({ id: row.id })
                    const hit = entity ? pickMatch(entity, options.match) : null
                    if (!hit || !keyOf.has(hit.pattern)) {
                        // The document is gone, or this call no longer
                        // matches it with a question it can ask. Nothing is
                        // owed.
                        await clearRequeue(row.id, keys)
                        continue
                    }
                    pending.set(row.id, { id: row.id, entity, hit, requeued: true })
                    if (!sweptIds.has(row.id)) due++
                }
                if (due) logger.info('ocr: asking %d document(s) again that failed earlier', due)
            }
            if (!pending.size) return

            // id → the meta to merge. Keyed by id because pass three
            // deserializes its own entity objects from the journal rows;
            // the ones gathered above are copies.
            const extracted = new Map()
            // Requeued documents a retry answered and that cannot be sent
            // back through a source: id → { entity, data }, re-entered into
            // this cycle after pass three.
            const recovered = new Map()
            const reimporting = new Set()
            // Stops asking once the provider has refused several calls in a
            // row this pass — see lib/requeue.js. Only with the requeue on,
            // because only then is a document left unasked asked later.
            const breaker = requeue ? createBreaker() : null
            const caching = options.cache !== false

            await pMap(pending.values(), async ({ entity, hit, requeued }) => {
                if (signal.aborted) return

                // This document's requeue row, when there is one to keep.
                const key = keyOf.get(hit.pattern)
                const previous = rows.get(entity.id)
                const filing = requeue && key ? { id: entity.id, key, keys, previous } : null
                let fingerprinted
                const fingerprint = () => (fingerprinted ??= sourceFingerprint(entity))
                // A row was written for this document this pass, or the pass
                // was cut short — either way, nothing to clear.
                let settled = false
                // Every answer this pass is in the ledger, so a re-import will
                // find it there rather than ask again.
                let filed = true
                // A config error leaves nothing to retry: a fix restarts the
                // process, and the config change wipes the catalog anyway.
                const abandon = async () => {
                    if (requeued) await clearRequeue(entity.id, keys)
                }

                // A match is a SEQUENCE of questions — see lib/steps.js.
                // Every form that worked before is a sequence of one, so the
                // single-value shapes are unchanged.
                let steps
                try {
                    steps = normalizeSteps(hit.spec, { patternForError: hit.pattern })
                } catch (err) {
                    logger.error('ocr: %s', err.message)
                    await abandon()
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
                        await abandon()
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

                    const identity = caching
                        ? questionFingerprint({
                            schema, model: options.model,
                            // `key` stands in for the prompt when the author
                            // declared one — see lib/steps.js.
                            prompt: cacheKeyFor(step, asked.prompt),
                            step: step.name })
                        : null
                    // The document's version, or the question alone for a
                    // step whose answer cannot change with it.
                    const source = caching ? sourceFor(step, await fingerprint()) : null
                    // What the model will actually be asked, if anything. A
                    // full schema by default; a backfill narrows it to the
                    // fields a previous generation's answer does not already
                    // provide.
                    let asking = schema
                    let basis = null
                    if (caching) {
                        const remembered = await readLedger(entity, identity, source)
                        if (remembered) {
                            meta = { ...meta, ...remembered }
                            produced = { ...(produced ?? {}), ...remembered }
                            logger.debug('ocr: %s %s restored from the ledger (no model call)',
                                entity.id, label)
                            continue
                        }

                        // Missed on the schema. Before paying to read the
                        // document again, ask whether a previous generation's
                        // answer is still a valid answer to the question as it
                        // is now — zod decides, not a tolerant hash. See
                        // lib/backfill.js.
                        const plan = planFromPriors(schema, await readPriorAnswers(entity, identity, source))
                        if (plan?.reuse) {
                            meta = { ...meta, ...plan.reuse }
                            produced = { ...(produced ?? {}), ...plan.reuse }
                            // Filed under the new schema so the next build is
                            // a direct hit rather than this search again.
                            filed = await writeLedger(entity, identity, source, plan.reuse, options.keep) && filed
                            logger.debug(
                                'ocr: %s %s — the schema changed but the stored answer still satisfies it (no model call)',
                                entity.id, label)
                            continue
                        }
                        if (plan?.backfill) {
                            asking = plan.backfill
                            basis = plan.prior
                            reportSchemaChange(logger, label, pending.size, plan.fields)
                            logger.debug('ocr: %s %s — asking only for %j', entity.id, label, plan.fields)
                        }
                    }

                    // Past the ledger, which answers without the provider, and
                    // before anything is read or cropped for a call that would
                    // only be refused.
                    if (breaker?.open) {
                        breaker.skip()
                        if (filing) {
                            await recordRetry({ ...filing, step: label, source: await fingerprint(),
                                reason: breaker.reason }, requeue)
                        }
                        logger.debug('ocr: %s %s not asked — the provider refused the calls before it',
                            entity.id, label)
                        settled = true
                        break
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

                    // The step's own files, prepared only now — past the
                    // ledger, so a warm build never reads or crops them.
                    const attached = await resolveAttachments(step, view)
                    if (attached.skip) {
                        logger.debug('ocr: %s skipping %s — %s', entity.id, label, attached.skip)
                        continue
                    }
                    if (attached.failed) {
                        logger.warn('ocr: %s could not attach the files for %s: %s',
                            entity.id, label, attached.failed)
                        continue
                    }

                    const messages = await buildMessages({
                        entity: view,
                        contentResult: step.source ? resolved : null,
                        prompt: asked.prompt,
                        extraInstruction: FAILURE_INSTRUCTION,
                        attachments: attached.attachments,
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
                            const { object } = await generate({
                                model:       options.model,
                                schema:      buildEnvelope(asking),
                                messages,
                                abortSignal: signal,
                                ...(options.generateObjectOptions ?? {}),
                            })
                            return readEnvelope(object)
                        },
                    })

                    if (result.ok) {
                        breaker?.answered()
                        // A backfill's answer is only the missing fields, so
                        // it is merged onto the generation it was built from —
                        // and the merge is validated against the FULL schema
                        // before it is stored, so a partial ask can never file
                        // a row that does not answer the question it is filed
                        // under. If it does not validate, the row is left
                        // unwritten and the next cycle does the whole
                        // extraction rather than trusting a half-answer.
                        let answer = result.data
                        if (basis) {
                            const merged = { ...basis, ...result.data }
                            if (satisfies(schema, merged)) {
                                answer = merged
                            } else {
                                logger.warn(
                                    'ocr: %s %s — backfilling %j did not produce a complete answer; '
                                    + 'the full extraction will run next cycle',
                                    entity.id, label, Object.keys(result.data))
                                break
                            }
                        }
                        meta = { ...meta, ...answer }
                        produced = { ...(produced ?? {}), ...answer }
                        filed = caching
                            && await writeLedger(entity, identity, source, answer, options.keep)
                            && filed
                        logger.info('ocr: extracted %s (%s)%s', entity.id, label,
                            result.attempts > 1 ? ` after ${result.attempts} attempts` : '')
                    } else if (result.aborted) {
                        // Not a failure of the document or the model: the
                        // cycle was restarted under it. The engine carries
                        // the journal entry into the next cycle, so this is
                        // picked up rather than lost — and a requeued
                        // document's row is still due.
                        logger.debug('ocr: %s %s cancelled mid-flight — the next cycle will pick it up',
                            entity.id, label)
                        settled = true
                        break
                    } else if (result.threw) {
                        breaker?.failed(result.reason)
                        const plan = filing
                            ? await recordRetry({ ...filing, step: label, source: await fingerprint(),
                                reason: result.reason }, requeue)
                            : null
                        logger.error('ocr: %s %s — generateObject failed after %d attempt(s): %s%s',
                            entity.id, label, result.attempts, result.reason,
                            plan ? ` — asking again in ${describeDelay(plan.delay)}` : '')
                        settled = true
                        // Later steps read what this one was going to leave,
                        // so carrying on would ask a question about an answer
                        // that does not exist.
                        break
                    } else {
                        // The provider answered, whatever the model said.
                        breaker?.answered()
                        if (filing) {
                            await recordDeclined({ ...filing, step: label, source: await fingerprint(),
                                reason: result.reason })
                        }
                        logger.warn('ocr: %s %s — model could not extract after %d attempt(s): %s',
                            entity.id, label, result.attempts, result.reason)
                        settled = true
                        break
                    }
                }

                if (requeued) {
                    // Asked off the catalog's copy, so it is not in this
                    // cycle's journal and pass three would never reach it.
                    // Only a complete answer puts it back in the pipeline;
                    // anything that failed is in its row, and the answers
                    // that did arrive are in the ledger for the next try.
                    if (settled) return
                    if (!produced) {
                        // Nothing was owed after all — the copy already
                        // satisfies every step, or a step is not ready.
                        await clearRequeue(entity.id, keys)
                        return
                    }
                    // Back through its source, as if the file had been
                    // edited, so everything after this plugin is derived from
                    // the answer: on the reported site a later plugin lowers
                    // a finding on what the photographs show, and a second
                    // ocr() writes its summary from those findings. Applied
                    // to the copy, the summary would describe findings the
                    // page no longer has. The re-import finds the answer in
                    // the ledger — which is why it is only taken when every
                    // answer is filed there.
                    const target = caching && filed ? reimportTarget(entity) : null
                    if (target && await recordReimport({ ...filing, step: previous?.step,
                        source: await fingerprint() }, requeue)) {
                        reimports.set(entity.id, target)
                        reimporting.add(entity.id)
                        return
                    }
                    recovered.set(entity.id, { entity, data: produced })
                    await clearRequeue(entity.id, keys)
                    return
                }
                if (filing && previous && !settled) await clearRequeue(entity.id, keys)
                if (produced) extracted.set(entity.id, produced)
            }, { concurrency, signal })

            if (breaker?.skipped) {
                logger.warn('ocr: %d document(s) were not asked this pass — the provider refused the calls '
                    + 'before them (%s). They are queued and asked again with the ones that failed.',
                    breaker.skipped, breaker.reason ?? 'refused')
            }

            // Pass three: apply. The mutation happens inside the body, which
            // is the only place useJournal's write-back can see it.
            if (extracted.size) {
                for await (const { entity } of useJournal(
                    'OCR apply',
                    [OPERATION.CREATE, OPERATION.UPDATE],
                    signal,
                )) {
                    const data = extracted.get(entity.id)
                    if (!data) continue
                    entity.meta = { ...(entity.meta ?? {}), ...data }
                }
            }

            if (reimporting.size) {
                logger.info('ocr: %d document(s) answered on a later attempt — re-importing them '
                    + 'when this cycle ends, so what follows them is derived again', reimporting.size)
            }

            // Answered on a later attempt and with no source to re-import
            // them: entered into THIS cycle's journal as the catalog has them
            // plus the answer, so the rest of the cycle — persist, render —
            // carries it. Plugins after this one see it; the ones before it
            // already ran on the copy in an earlier cycle.
            for (const { entity, data } of recovered.values()) {
                if (signal.aborted) return
                await updateEntity({ ...entity, meta: { ...(entity.meta ?? {}), ...data } })
            }
            if (recovered.size) {
                logger.info('ocr: %d document(s) answered on a later attempt — updated in place', recovered.size)
            }
        })
        // Names this package to the runtime's loaded-plugin record, so
        // ping reports it as running rather than as undetectable.
        return { module: import.meta.url }
    }
}
