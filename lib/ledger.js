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
// Exported so the upgrade path can be run against a real database in a
// test. Real installs already have the 001 table — 11.3.0 shipped it — so
// 002 is a rebuild carrying their rows across, and that has to be proven
// rather than assumed.
export const migrations = [
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
    {
        // One row per document was one row too few.
        //
        // The identity was computed correctly and stored — schema, model,
        // prompt — but the row was keyed on `id` alone and written with
        // `.onConflict('id').merge()`, so re-extracting a document under a
        // different question OVERWROTE the previous answer instead of sitting
        // beside it.
        //
        // That made trying a prompt destructive. Reported: a prompt was
        // tightened, measured as worse, and reverted to the exact previous
        // text — and the old rows were gone. The rollback re-read everything,
        // about thirteen model calls, and one report then failed twice and
        // needed hand-holding to recover. A comparison you cannot undo is a
        // gamble, not an experiment, and the fingerprint was built precisely
        // to make it an experiment.
        //
        // sqlite cannot alter a primary key, so the table is rebuilt and the
        // rows are carried across: every answer already paid for is kept.
        name: '002-key-per-question',
        up: async (knex) => {
            const TEMP = `${TABLE}_002`
            await knex.schema.createTable(TEMP, (table) => {
                table.text('id').notNullable()
                table.text('source').notNullable()
                table.text('schema_hash').notNullable()
                table.text('model').notNullable()
                table.text('prompt_hash').notNullable()
                table.text('result').notNullable()
                table.bigInteger('extracted_at').notNullable()
                table.primary(['id', 'schema_hash', 'model', 'prompt_hash'])
                // The read is "this document, this question" and the prune
                // below walks one document's rows by age.
                table.index(['id', 'extracted_at'])
            })
            const rows = await knex(TABLE).select('*')
            if (rows.length) await knex(TEMP).insert(rows)
            await knex.schema.dropTable(TABLE)
            await knex.schema.renameTable(TEMP, TABLE)
        },
    },
    {
        // A document now has a SEQUENCE of questions asked about it, and the
        // step is part of which question this row answers.
        //
        // The key would nearly work without it — a different step has a
        // different schema and prompt, so a different key. What breaks is the
        // PRUNE, which keeps the newest `keep` rows per document: iterate on
        // step three's prompt a few times and step one's answer, the
        // expensive one that actually read the PDF, ages out and the next
        // build pays to read it again. Pruning per (id, step) keeps each
        // question's history to itself.
        //
        // Rows written before sequences existed carry the empty step, which
        // is what a single-value match still uses — so every answer already
        // paid for stays reachable.
        name: '003-step',
        up: async (knex) => {
            const TEMP = `${TABLE}_003`
            await knex.schema.createTable(TEMP, (table) => {
                table.text('id').notNullable()
                table.text('step').notNullable().defaultTo('')
                table.text('source').notNullable()
                table.text('schema_hash').notNullable()
                table.text('model').notNullable()
                table.text('prompt_hash').notNullable()
                table.text('result').notNullable()
                table.bigInteger('extracted_at').notNullable()
                table.primary(['id', 'step', 'schema_hash', 'model', 'prompt_hash'])
                table.index(['id', 'step', 'extracted_at'])
            })
            const rows = await knex(TABLE).select('*')
            if (rows.length) await knex(TEMP).insert(rows.map(r => ({ ...r, step: '' })))
            await knex.schema.dropTable(TABLE)
            await knex.schema.renameTable(TEMP, TABLE)
        },
    },
]

registerMigrations('ocr', migrations)

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
export function questionFingerprint({ schema, model, prompt, step = '' }) {
    return {
        step,
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
        // The question is part of the key now, so the lookup asks for the
        // exact one. `source` stays a comparison rather than a key column:
        // an answer to the right question about the WRONG version of the
        // document is a miss, but the row is the one we are about to
        // replace, not a separate row to accumulate.
        const row = await knex(TABLE).where({
            id: entity.id,
            step: identity.step ?? '',
            schema_hash: identity.schema_hash,
            model: identity.model,
            prompt_hash: identity.prompt_hash,
        }).first()
        if (!row) return null
        if (row.source !== source) return null
        return JSON.parse(row.result)
    } catch {
        // A ledger that cannot be read must never stop a build — the worst
        // case is the behaviour that existed before it.
        return null
    }
}

// Answers stored for this document and step under a DIFFERENT schema — the
// previous generations of the same question.
//
// Matched on the same model and the same prompt, and deliberately not across
// a prompt change. A prompt is free text and its effect is unbounded:
// "measurements in mm" to "in cm" is the same schema and a different answer,
// so reusing across it would serve an answer to a question nobody asked. A
// schema can be checked; guidance cannot. See `key` in the README for the
// lever that lets an author declare a prompt edit immaterial.
//
// Newest first, because the most recent answer is the most likely to still
// satisfy the current schema and the best base for a backfill.
export async function readPriorAnswers(entity, identity, source, limit = 5) {
    if (!source) return []
    const knex = useDurableDatabase()
    if (!knex) return []
    try {
        const rows = await knex(TABLE)
            .where({
                id: entity.id,
                step: identity.step ?? '',
                model: identity.model,
                prompt_hash: identity.prompt_hash,
                source,
            })
            .whereNot({ schema_hash: identity.schema_hash })
            .orderBy('extracted_at', 'desc')
            .limit(limit)
        return rows.map(row => {
            try { return JSON.parse(row.result) } catch { return null }
        }).filter(Boolean)
    } catch {
        return []
    }
}

export async function writeLedger(entity, identity, source, result, keep = DEFAULT_KEEP) {
    if (!source) return false
    const knex = useDurableDatabase()
    if (!knex) return false
    const step = identity.step ?? ''
    const row = {
        id: entity.id,
        source,
        ...identity,
        step,
        result: JSON.stringify(result),
        extracted_at: Date.now(),
    }
    try {
        await knex(TABLE).insert(row)
            .onConflict(['id', 'step', 'schema_hash', 'model', 'prompt_hash']).merge()
        await pruneLedger(knex, entity.id, step, keep)
        return true
    } catch {
        return false
    }
}

// Rows per document are bounded, oldest first.
//
// Keeping every answer a document ever produced would grow without limit
// across prompt iterations, and the value of an old one falls off a cliff:
// what rollback needs is the answer you had before this change, not the one
// from forty prompts ago. Default 5 — enough to step back through a few
// attempts, small enough that a thousand documents is thousands of rows
// rather than however many times somebody edited a prompt.
export const DEFAULT_KEEP = 5

async function pruneLedger(knex, id, step, keep = DEFAULT_KEEP) {
    if (!Number.isFinite(keep) || keep <= 0) return
    // Per (id, STEP). Scoped per document alone, iterating on a cheap late
    // step would age out the expensive first reading — the one that actually
    // opened the PDF — and the next build would pay to read it again.
    const rows = await knex(TABLE).where({ id, step })
        .select('schema_hash', 'model', 'prompt_hash', 'extracted_at')
        .orderBy('extracted_at', 'desc')
    for (const row of rows.slice(keep)) {
        await knex(TABLE).where({
            id,
            step,
            schema_hash: row.schema_hash,
            model: row.model,
            prompt_hash: row.prompt_hash,
        }).del()
    }
}
