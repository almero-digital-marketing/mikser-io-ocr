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

import { generateObject } from 'ai'
import { readEntityContent, useService } from 'mikser-io'
import { pickMatch, resolveSchema, normalizeMatchValue } from './lib/resolve.js'
import { buildMessages } from './lib/messages.js'
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

            for await (const { entity, operation } of useJournal(
                'OCR',
                [OPERATION.CREATE, OPERATION.UPDATE],
                signal,
            )) {
                if (signal.aborted) return

                const hit = pickMatch(entity, options.match)
                if (!hit) continue

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
                    continue
                }

                // Already-satisfied entities skip the LLM call entirely.
                // This is the read-mostly path on warm builds — most
                // entities already have valid meta and don't need re-ext.
                if (schema.safeParse(entity.meta ?? {}).success) {
                    logger.trace('ocr: %s already satisfies schema, skipping', entity.id)
                    continue
                }

                // Fetch content via the scheme-dispatched provider.
                // Returns { content } (text) | { contentSkipped, cachedAt }
                // (binary) | { contentError } (failure).
                const contentResult = await readEntityContent(entity)
                if (contentResult.contentError) {
                    logger.warn('ocr: %s — cannot read content: %s', entity.id, contentResult.contentError)
                    continue
                }

                // Prompt precedence: per-match override → plugin-level
                // prompt → buildMessages' built-in DEFAULT_PROMPT. The
                // failure instruction is always appended so the model
                // knows it can report an unprocessable source instead
                // of fabricating values to satisfy the schema.
                const messages = await buildMessages({
                    entity,
                    contentResult,
                    prompt: matchPrompt ?? options.prompt,
                    extraInstruction: FAILURE_INSTRUCTION,
                })
                if (!messages) {
                    logger.trace('ocr: %s has no extractable content, skipping', entity.id)
                    continue
                }

                try {
                    // generateObject runs against the ENVELOPE, not the
                    // bare schema, so the model has a first-class failure
                    // branch. On failure we write nothing — the entity
                    // stays unsatisfied, which mikser-io-schemas already
                    // surfaces as a pending/broken entity. No parallel
                    // error store; the existing schema-validation surface
                    // is the single source of truth for "this didn't
                    // extract".
                    const { object } = await generateObject({
                        model:       options.model,
                        schema:      buildEnvelope(schema),
                        messages,
                        abortSignal: signal,
                        ...(options.generateObjectOptions ?? {}),
                    })
                    const outcome = readEnvelope(object)
                    if (!outcome.ok) {
                        logger.warn('ocr: %s — model could not extract (pattern %s): %s',
                            entity.id, hit.pattern, outcome.reason)
                        continue
                    }
                    entity.meta = { ...(entity.meta ?? {}), ...outcome.data }
                    logger.info('ocr: extracted %s (pattern %s)', entity.id, hit.pattern)
                } catch (err) {
                    logger.error('ocr: %s — generateObject failed: %s', entity.id, err.message)
                }
            }
        })
        // Names this package to the runtime's loaded-plugin record, so
        // ping reports it as running rather than as undetectable.
        return { module: import.meta.url }
    }
}
