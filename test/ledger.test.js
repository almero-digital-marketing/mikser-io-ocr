// An extraction outlives the catalog.
//
// `schema.safeParse(entity.meta)` is free and correct on a warm rebuild,
// and it holds exactly as long as the catalog does. mikser wipes the
// catalog on any config change, so editing a comment in mikser.config.js
// used to send every matched document back to the model.
//
// Reported from a real session: eight PDFs, two minutes and a few cents,
// fifteen times in one afternoon. At a thousand documents it is a
// thousand model calls because someone edited a config comment — the cost
// is unbounded in the number of documents and triggered by something with
// nothing to do with them.
//
// The wipe is what these simulate: the catalog copy of meta goes away,
// and the question is whether the document has to be read again.

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import knexFactory from 'knex'
import { z } from 'zod'
import runtime from 'mikser-io/src/runtime.js'

import { sourceFingerprint, questionFingerprint, readLedger, writeLedger } from '../lib/ledger.js'

const SCHEMA = z.object({ patient: z.string(), findings: z.array(z.string()) })
const OTHER_SCHEMA = z.object({ patient: z.string(), findings: z.array(z.string()), grade: z.number() })
const MODEL = { provider: 'openai', modelId: 'gpt-4o-mini' }
const RESULT = { patient: 'A. Ivanova', findings: ['nevus, benign'] }

let dir, knex

before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ocr-ledger-'))
    knex = knexFactory({
        client: 'better-sqlite3',
        connection: { filename: path.join(dir, 'mikser.data.sqlite') },
        useNullAsDefault: true,
    })
    await knex.schema.createTable('mikser_ocr_extractions', (table) => {
        table.text('id').primary()
        table.text('source').notNullable()
        table.text('schema_hash').notNullable()
        table.text('model').notNullable()
        table.text('prompt_hash').notNullable()
        table.text('result').notNullable()
        table.bigInteger('extracted_at').notNullable()
    })
    // The injection point useDurableDatabase documents.
    runtime.durable = knex
})

after(async () => {
    runtime.durable = null
    await knex?.destroy()
    await rm(dir, { recursive: true, force: true })
})

beforeEach(async () => { await knex('mikser_ocr_extractions').del() })

const entity = { id: '/skincheck/8501054473.pdf', checksum: 'abc123' }
const ask = (overrides = {}) => questionFingerprint({
    schema: SCHEMA, model: MODEL, prompt: 'extract', ...overrides,
})

describe('the extraction ledger', () => {
    it('returns a stored extraction for the same document and question', async () => {
        const identity = ask()
        const source = await sourceFingerprint(entity)
        assert.equal(await writeLedger(entity, identity, source, RESULT), true)

        // The catalog wipe: nothing about the entity's meta survives, and
        // the plugin asks again from scratch.
        assert.deepEqual(await readLedger(entity, ask(), await sourceFingerprint(entity)), RESULT)
    })

    it('re-reads a document whose content changed', async () => {
        const identity = ask()
        await writeLedger(entity, identity, await sourceFingerprint(entity), RESULT)
        const edited = { ...entity, checksum: 'def456' }
        assert.equal(await readLedger(edited, identity, await sourceFingerprint(edited)), null,
            'a changed source must be read again')
    })

    it('re-reads when the schema changed', async () => {
        // A different shape is a different question, and the stored answer
        // no longer means what it says.
        await writeLedger(entity, ask(), await sourceFingerprint(entity), RESULT)
        const changed = ask({ schema: OTHER_SCHEMA })
        assert.equal(await readLedger(entity, changed, await sourceFingerprint(entity)), null)
    })

    it('re-reads when the model changed', async () => {
        await writeLedger(entity, ask(), await sourceFingerprint(entity), RESULT)
        const changed = ask({ model: { provider: 'openai', modelId: 'gpt-4o' } })
        assert.equal(await readLedger(entity, changed, await sourceFingerprint(entity)), null)
    })

    it('re-reads when the prompt changed', async () => {
        // Invisible from the source file, and it changes the answer.
        await writeLedger(entity, ask(), await sourceFingerprint(entity), RESULT)
        const changed = ask({ prompt: 'extract, and include the grade' })
        assert.equal(await readLedger(entity, changed, await sourceFingerprint(entity)), null)
    })

    it('does not confuse two documents', async () => {
        await writeLedger(entity, ask(), await sourceFingerprint(entity), RESULT)
        const other = { id: '/skincheck/8501054474.pdf', checksum: 'abc123' }
        assert.equal(await readLedger(other, ask(), await sourceFingerprint(other)), null,
            'the same bytes under a different id is a different document')
    })

    it('replaces the row rather than accumulating rows per document', async () => {
        await writeLedger(entity, ask(), 'sum:v1', RESULT)
        await writeLedger(entity, ask(), 'sum:v2', { patient: 'A. Ivanova', findings: [] })
        const rows = await knex('mikser_ocr_extractions').where({ id: entity.id })
        assert.equal(rows.length, 1, 'one row per document, holding its current version')
        assert.equal(rows[0].source, 'sum:v2')
    })
})

describe('what counts as the same document', () => {
    it('uses the content hash mikser already computed', async () => {
        // The exact-vs-cheap tradeoff does not apply: the import gate hashes
        // every source file anyway, so this is exact AND free.
        assert.equal(await sourceFingerprint({ id: '/x', checksum: 'abc123' }), 'sum:abc123')
    })

    it('falls back to size and mtime when no checksum came with the entity', async () => {
        const file = path.join(dir, 'report.pdf')
        await writeFile(file, 'hello')
        const first = await sourceFingerprint({ id: '/x', uri: file })
        assert.match(first, /^stat:5:\d+$/)

        await writeFile(file, 'hello there')
        const future = new Date(Date.now() + 2000)
        await utimes(file, future, future)
        assert.notEqual(await sourceFingerprint({ id: '/x', uri: file }), first)
    })

    it('refuses to cache what it cannot identify', async () => {
        // No identity means no row: storing something we cannot check later
        // is how a stale answer becomes permanent.
        assert.equal(await sourceFingerprint({ id: '/x' }), null)
        assert.equal(await writeLedger({ id: '/x' }, ask(), null, RESULT), false)
        assert.equal(await readLedger({ id: '/x' }, ask(), null), null)
    })

    it('does not treat a missing file as a stable identity', async () => {
        assert.equal(await sourceFingerprint({ id: '/x', uri: '/nonexistent/gone.pdf' }), null)
    })
})
