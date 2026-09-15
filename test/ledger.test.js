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

import { sourceFingerprint, questionFingerprint, readLedger, writeLedger, readPriorAnswers, migrations } from '../lib/ledger.js'

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
    // Built by running the real migrations, not by hand. A hand-written
    // copy of the schema drifts from the one users get, and the drift is
    // invisible until a column the code writes is missing in production.
    for (const migration of migrations) await migration.up(knex)

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

describe('one document, several questions', () => {
    it('keeps each step\'s answer under its own key', async () => {
        const source = await sourceFingerprint(entity)
        const report = ask({ step: 'report' })
        const notes = ask({ step: 'notes', prompt: 'explain the findings' })
        await writeLedger(entity, report, source, RESULT)
        await writeLedger(entity, notes, source, { notes: ['benign'] })

        assert.deepEqual(await readLedger(entity, report, source), RESULT)
        assert.deepEqual(await readLedger(entity, notes, source), { notes: ['benign'] })
    })

    it('does not let a churning late step evict the expensive first reading', async () => {
        // The reason `step` is in the key at all. Without it the prune keeps
        // the newest N rows PER DOCUMENT, so iterating on step three's prompt
        // a few times ages out step one's answer — the one that actually read
        // the 4 MB PDF — and the next build pays to read it again.
        const source = await sourceFingerprint(entity)
        const report = ask({ step: 'report' })
        await writeLedger(entity, report, source, RESULT, 2)

        for (let i = 0; i < 6; i++) {
            await writeLedger(entity, ask({ step: 'notes', prompt: `v${i}` }), source,
                { notes: [`v${i}`] }, 2)
            await new Promise(r => setTimeout(r, 2))
        }

        assert.deepEqual(await readLedger(entity, report, source), RESULT,
            'the expensive reading must survive any amount of churn on a later step')
        const notesRows = await knex('mikser_ocr_extractions').where({ id: entity.id, step: 'notes' })
        assert.equal(notesRows.length, 2, 'the late step is still bounded, on its own')
    })

    it('gives each step its own keep budget, not a shared one', async () => {
        // Sharper than "a late step must not evict an early one", which the
        // delete's own scoping already prevents. The budget is the leak: if
        // the prune counts rows across steps, a BUSY sibling written more
        // recently fills the budget and the step being pruned is cut below
        // its own `keep` — here to zero rows from a limit of two.
        const source = await sourceFingerprint(entity)
        const notes = (v) => ask({ step: 'notes', prompt: v })

        await writeLedger(entity, notes('v0'), source, { notes: ['v0'] }, 2)
        await new Promise(r => setTimeout(r, 2))
        await writeLedger(entity, notes('v1'), source, { notes: ['v1'] }, 2)
        await new Promise(r => setTimeout(r, 2))
        // A different step, written later, so it sits on top of any
        // document-wide ordering.
        for (const v of ['r0', 'r1', 'r2']) {
            await writeLedger(entity, ask({ step: 'report', prompt: v }), source, { report: v }, 2)
            await new Promise(r => setTimeout(r, 2))
        }
        // Now prune `notes`.
        await writeLedger(entity, notes('v2'), source, { notes: ['v2'] }, 2)

        const kept = await knex('mikser_ocr_extractions').where({ id: entity.id, step: 'notes' })
        assert.equal(kept.length, 2,
            `notes kept ${kept.length} of its own 2 — a sibling step consumed its budget`)
        assert.deepEqual(await readLedger(entity, notes('v2'), source), { notes: ['v2'] })
        assert.deepEqual(await readLedger(entity, notes('v1'), source), { notes: ['v1'] })
    })

    it('treats the legacy empty step as its own step', async () => {
        // Rows written before sequences existed carry the empty name, and a
        // named step must not collide with them.
        const source = await sourceFingerprint(entity)
        await writeLedger(entity, ask(), source, RESULT)
        await writeLedger(entity, ask({ step: 'notes' }), source, { notes: [] })
        assert.deepEqual(await readLedger(entity, ask(), source), RESULT)
        assert.deepEqual(await readLedger(entity, ask({ step: 'notes' }), source), { notes: [] })
    })
})

describe('a schema edit, against the real ledger', () => {
    it('finds the previous generation of the same question', async () => {
        // The lookup the reuse and backfill paths are built on: same
        // document, same step, same model, same prompt, DIFFERENT schema.
        const source = await sourceFingerprint(entity)
        const before = questionFingerprint({ schema: SCHEMA, model: MODEL, prompt: 'extract', step: 'report' })
        await writeLedger(entity, before, source, RESULT)

        const after = questionFingerprint({
            schema: z.object({ patient: z.string(), findings: z.array(z.string()), uv: z.number().nullable() }),
            model: MODEL, prompt: 'extract', step: 'report',
        })
        assert.equal(await readLedger(entity, after, source), null, 'precondition: the new schema misses')
        assert.deepEqual(await readPriorAnswers(entity, after, source), [RESULT],
            'but the previous generation is findable')
    })

    it('does not reach across a prompt change', async () => {
        // A prompt is free text and its effect is unbounded: "measurements in
        // mm" to "in cm" is the same schema and a different answer. A schema
        // can be checked against a stored answer; guidance cannot.
        const source = await sourceFingerprint(entity)
        await writeLedger(entity, ask({ step: 'report', prompt: 'in mm' }), source, RESULT)
        const other = questionFingerprint({
            schema: z.object({ patient: z.string() }), model: MODEL, prompt: 'in cm', step: 'report',
        })
        assert.deepEqual(await readPriorAnswers(entity, other, source), [],
            'a different prompt is a different question, not an older generation of this one')
    })

    it('does not reach across a model change', async () => {
        const source = await sourceFingerprint(entity)
        await writeLedger(entity, ask({ step: 'report' }), source, RESULT)
        const other = questionFingerprint({
            schema: z.object({ patient: z.string() }),
            model: { provider: 'openai', modelId: 'gpt-4o' }, prompt: 'extract', step: 'report',
        })
        assert.deepEqual(await readPriorAnswers(entity, other, source), [])
    })

    it('does not reach across a changed document', async () => {
        // The source version is still absolute: a different PDF's answer is
        // not an older generation, it is a different document.
        await writeLedger(entity, ask({ step: 'report' }), 'sum:v1', RESULT)
        const after = questionFingerprint({
            schema: z.object({ patient: z.string() }), model: MODEL, prompt: 'extract', step: 'report',
        })
        assert.deepEqual(await readPriorAnswers(entity, after, 'sum:v2'), [])
    })

    it('returns generations newest first', async () => {
        const source = await sourceFingerprint(entity)
        for (const [i, schema] of [
            z.object({ a: z.string() }),
            z.object({ b: z.string() }),
            z.object({ c: z.string() }),
        ].entries()) {
            await writeLedger(entity,
                questionFingerprint({ schema, model: MODEL, prompt: 'extract', step: 'report' }),
                source, { generation: i })
            await new Promise(r => setTimeout(r, 2))
        }
        const current = questionFingerprint({
            schema: z.object({ d: z.string() }), model: MODEL, prompt: 'extract', step: 'report',
        })
        const priors = await readPriorAnswers(entity, current, source)
        assert.deepEqual(priors.map(p => p.generation), [2, 1, 0],
            'the most recent answer is the best candidate for reuse')
    })
})

describe('an explicit `key` instead of the prompt', () => {
    it('keeps the row when the prompt is reworded but the key is unchanged', async () => {
        // What the lever is for: the author says the edit was cosmetic.
        const source = await sourceFingerprint(entity)
        const before = questionFingerprint({ schema: SCHEMA, model: MODEL, prompt: 'notes-v1', step: 'notes' })
        await writeLedger(entity, before, source, RESULT)
        const after = questionFingerprint({ schema: SCHEMA, model: MODEL, prompt: 'notes-v1', step: 'notes' })
        assert.deepEqual(await readLedger(entity, after, source), RESULT)
    })

    it('invalidates when the key is bumped', async () => {
        const source = await sourceFingerprint(entity)
        await writeLedger(entity,
            questionFingerprint({ schema: SCHEMA, model: MODEL, prompt: 'notes-v1', step: 'notes' }),
            source, RESULT)
        const bumped = questionFingerprint({ schema: SCHEMA, model: MODEL, prompt: 'notes-v2', step: 'notes' })
        assert.equal(await readLedger(entity, bumped, source), null,
            'bumping the key is how the author says the question changed')
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
