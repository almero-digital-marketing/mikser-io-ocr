// An extraction survives the catalog.
//
// The only thing standing between a document and the model was
// `schema.safeParse(entity.meta)`. That is free and correct on a warm
// rebuild — and it holds exactly as long as the catalog does. mikser wipes
// the catalog on any config change (ADR-0002: the files are the source of
// truth, the catalog is a derived cache), so editing a comment in
// mikser.config.js sends every matched document back to the model.
//
// Reported from a real session: eight PDFs, two minutes and a few cents,
// fifteen times in one afternoon — every time a line in the pipeline moved.
// The cost is unbounded in the number of documents and is triggered by
// something that has nothing to do with them. And these were customer
// skin-check reports: read once, expensive to read again, and the reading
// IS the work. Losing it to a cache wipe is losing work, not time.
//
// So the ledger lives in the DURABLE store — a separate database
// (mikser.data.sqlite, in the working folder) that the cache wipe does not
// touch, the same place auth grants and the change-set log live. Not the
// output folder: for the project this came from the documents are customer
// records and out/ is served by express.static, so anything derived from
// them carries the same constraint.
//
// WHAT COUNTS AS THE SAME DOCUMENT
//
// The choice looked like exact-but-expensive (hash every file every build)
// against cheap-but-approximate (size and mtime). It is neither, because
// mikser already hashes every source file during import — that is how its
// own change gate decides whether to emit a journal entry at all. So
// `entity.checksum` is an exact content hash that has already been paid
// for, and reading it costs nothing. Size and mtime are the fallback for an
// entity that arrives without one.
//
// WHAT ELSE INVALIDATES
//
// Everything that goes into the answer, because none of it is visible from
// the source file: the schema (a changed shape asks a different question),
// the model and its provider, and the effective prompt. Any of them
// differing is a miss, and a miss re-reads. The alternative is a stored
// result that no longer means what it says, which is worse than paying for
// the call.

import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { registerMigrations, useDurableDatabase } from 'mikser-io'

const TABLE = 'mikser_ocr_extractions'
const md5 = (value) => createHash('md5').update(value).digest('hex')

// Registered at import time so the migration is declared before the durable
// store opens. Names are permanent — append, never edit.
registerMigrations('ocr', [
    {
        name: '001-extractions',
        up: async (knex) => {
            await knex.schema.createTable(TABLE, (table) => {
                table.text('id').primary()
                table.text('source').notNullable()
                table.text('schema_hash').notNullable()
                table.text('model').notNullable()
                table.text('prompt_hash').notNullable()
                table.text('result').notNullable()
                table.bigInteger('extracted_at').notNullable()
            })
        },
    },
])

// The identity of this document version. `entity.checksum` is the content
// hash mikser's import gate already computed; nothing here re-reads a file
// that mikser has read.
export async function sourceFingerprint(entity) {
    if (entity?.checksum) return `sum:${entity.checksum}`
    if (!entity?.uri) return null
    try {
        const info = await stat(entity.uri)
        // Not as exact as a hash — a write that preserves size and mtime is
        // invisible. It is the fallback, and it is still better than asking
        // the model again on every build.
        return `stat:${info.size}:${Math.trunc(info.mtimeMs)}`
    } catch {
        // No identity means no caching: extract, and do not record something
        // we cannot check later.
        return null
    }
}

// The identity of the question being asked.
export function questionFingerprint({ schema, model, prompt }) {
    return {
        schema_hash: schemaHash(schema),
        model: `${model?.provider ?? 'unknown'}:${model?.modelId ?? 'unknown'}`,
        prompt_hash: md5(prompt ?? ''),
    }
}

function schemaHash(schema) {
    try {
        // zod 4's JSON Schema output is structural: it changes when the shape
        // changes and not when the file is merely reformatted or its fields
        // reordered in source.
        return md5(JSON.stringify(z.toJSONSchema(schema)))
    } catch {
        // A custom validator with a safeParse-shaped surface has no JSON
        // Schema — resolveSchema accepts those deliberately. Its source text
        // at least changes when the validator does.
        try { return `src:${md5(String(schema))}` } catch { return 'unknown' }
    }
}

export async function readLedger(entity, identity, source) {
    if (!source) return null
    const knex = useDurableDatabase()
    if (!knex) return null
    try {
        const row = await knex(TABLE).where({ id: entity.id }).first()
        if (!row) return null
        if (row.source !== source) return null
        if (row.schema_hash !== identity.schema_hash) return null
        if (row.model !== identity.model) return null
        if (row.prompt_hash !== identity.prompt_hash) return null
        return JSON.parse(row.result)
    } catch {
        // A ledger that cannot be read must never stop a build — the worst
        // case is the behaviour that existed before it.
        return null
    }
}

export async function writeLedger(entity, identity, source, result) {
    if (!source) return false
    const knex = useDurableDatabase()
    if (!knex) return false
    const row = {
        id: entity.id,
        source,
        ...identity,
        result: JSON.stringify(result),
        extracted_at: Date.now(),
    }
    try {
        await knex(TABLE).insert(row).onConflict('id').merge()
        return true
    } catch {
        return false
    }
}
