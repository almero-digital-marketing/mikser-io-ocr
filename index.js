// mikser-io-ocr — schema-driven OCR + structured-data extraction.
//
// One lifecycle plugin. At onProcess, for each new/updated entity:
//
//   1. First-matching glob from `options.match` picks a schema.
//   2. resolveSchema turns the spec into a zod object (string → name
//      lookup via runtime.options.schemas.lookup; object → direct).
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
import { readEntityContent } from 'mikser-io'
import { pickMatch, resolveSchema } from './lib/resolve.js'
import { buildMessages } from './lib/messages.js'

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
            const schemasSurface = runtime.options.schemas

            for await (const { entity, operation } of useJournal(
                'OCR',
                [OPERATION.CREATE, OPERATION.UPDATE],
                signal,
            )) {
                if (signal.aborted) return

                const hit = pickMatch(entity, options.match)
                if (!hit) continue

                // Resolve schema once per entity. Throws if the spec
                // is misconfigured — let it crash the cycle rather
                // than silently skipping; config errors should be loud.
                let schema
                try {
                    schema = resolveSchema(hit.spec, { schemasSurface, patternForError: hit.pattern })
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

                const messages = await buildMessages({
                    entity,
                    contentResult,
                    prompt: options.prompt,
                })
                if (!messages) {
                    logger.trace('ocr: %s has no extractable content, skipping', entity.id)
                    continue
                }

                try {
                    const { object } = await generateObject({
                        model:       options.model,
                        schema,
                        messages,
                        abortSignal: signal,
                        ...(options.generateObjectOptions ?? {}),
                    })
                    entity.meta = { ...(entity.meta ?? {}), ...object }
                    logger.info('ocr: extracted %s (pattern %s)', entity.id, hit.pattern)
                } catch (err) {
                    logger.error('ocr: %s — generateObject failed: %s', entity.id, err.message)
                }
            }
        })
    }
}
