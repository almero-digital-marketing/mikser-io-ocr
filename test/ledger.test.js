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
        table.text('id').notNullable()
        table.text('source').notNullable()
        table.text('schema_hash').notNullable()
        table.text('model').notNullable()
        table.text('prompt_hash').notNullable()
        table.text('result').notNullable()
        table.bigInteger('extracted_at').notNullable()
        table.primary(['id', 'schema_hash', 'model', 'prompt_hash'])
        table.index(['id', 'extracted_at'])
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

    it('replaces the row for the SAME question when the document changes', async () => {
        await writeLedger(entity, ask(), 'sum:v1', RESULT)
        await writeLedger(entity, ask(), 'sum:v2', { patient: 'A. Ivanova', findings: [] })
        const rows = await knex('mikser_ocr_extractions').where({ id: entity.id })
        assert.equal(rows.length, 1, 'one row per (document, question)')
        assert.equal(rows[0].source, 'sum:v2')
    })
})

describe('two answers for one document', () => {
    it('keeps A when B is extracted, so a prompt change is not destructive', async () => {
        // The reported workflow, and the one the fingerprint was built for:
        // tighten a prompt, run it, measure it, revert. Keyed on `id` alone,
        // B's row overwrote A's, so reverting to the EXACT previous prompt
        // re-read everything — about thirteen model calls — and one report
        // then failed twice and needed hand-holding to recover.
        const source = await sourceFingerprint(entity)
        const promptA = ask({ prompt: 'extract' })
        const promptB = ask({ prompt: 'extract, be terse' })

        await writeLedger(entity, promptA, source, RESULT)
        await writeLedger(entity, promptB, source, { patient: 'A.I.', findings: [] })

        // The revert: the old prompt's answer is still there, and free.
        assert.deepEqual(await readLedger(entity, promptA, source), RESULT,
            'rolling back a prompt must cost nothing')
        assert.deepEqual(await readLedger(entity, promptB, source), { patient: 'A.I.', findings: [] })
    })

    it('keeps one answer per model, so a model comparison is reversible too', async () => {
        const source = await sourceFingerprint(entity)
        const mini = ask({ model: { provider: 'openai', modelId: 'gpt-4o-mini' } })
        const full = ask({ model: { provider: 'openai', modelId: 'gpt-4o' } })
        await writeLedger(entity, mini, source, RESULT)
        await writeLedger(entity, full, source, { patient: 'A. Ivanova', findings: ['x'] })

        assert.deepEqual(await readLedger(entity, mini, source), RESULT)
        assert.deepEqual(await readLedger(entity, full, source), { patient: 'A. Ivanova', findings: ['x'] })
        const rows = await knex('mikser_ocr_extractions').where({ id: entity.id })
        assert.equal(rows.length, 2, 'both answers stand')
    })

    it('bounds the rows per document, dropping the oldest first', async () => {
        // Unbounded growth across prompt iterations is the cost of keeping
        // answers, and an answer from forty prompts ago is not what a
        // rollback wants.
        const source = await sourceFingerprint(entity)
        for (let i = 0; i < 6; i++) {
            await writeLedger(entity, ask({ prompt: `v${i}` }), source, { patient: `p${i}`, findings: [] }, 3)
            // extracted_at is the prune's ordering, and these writes land
            // inside the same millisecond otherwise.
            await new Promise(r => setTimeout(r, 2))
        }
        const rows = await knex('mikser_ocr_extractions').where({ id: entity.id })
        assert.equal(rows.length, 3, `kept ${rows.length} rows, asked to keep 3`)
        // The three most recent survive.
        const kept = await Promise.all([3, 4, 5].map(i =>
            readLedger(entity, ask({ prompt: `v${i}` }), source)))
        assert.deepEqual(kept.map(k => k?.patient), ['p3', 'p4', 'p5'])
        assert.equal(await readLedger(entity, ask({ prompt: 'v0' }), source), null, 'the oldest went')
    })

    it('keeps everything when keep is 0 or nonsense', async () => {
        const source = await sourceFingerprint(entity)
        for (let i = 0; i < 4; i++) {
            await writeLedger(entity, ask({ prompt: `k${i}` }), source, { patient: `p${i}`, findings: [] }, 0)
        }
        const rows = await knex('mikser_ocr_extractions').where({ id: entity.id })
        assert.equal(rows.length, 4, 'pruning off means pruning off')
    })

    it('does not prune another document\'s rows', async () => {
        const other = { id: '/skincheck/other.pdf', checksum: 'zzz' }
        await writeLedger(other, ask(), await sourceFingerprint(other), RESULT, 1)
        for (let i = 0; i < 3; i++) {
            await writeLedger(entity, ask({ prompt: `x${i}` }), await sourceFingerprint(entity), RESULT, 1)
            await new Promise(r => setTimeout(r, 2))
        }
        assert.deepEqual(await readLedger(other, ask(), await sourceFingerprint(other)), RESULT,
            "one document's churn must not evict another's answer")
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
