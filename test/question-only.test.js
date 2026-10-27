// A question that never sees the document is not asked again because the
// document's bytes changed.
//
// Reported 27.10.2026: the clinic boxes were about to re-send every skin-check
// JSON with one more top-level block — JANUS detail tables that no question
// reads. Every report's checksum would change, and the three `source: false`
// steps over them (reading, procedures, visual) would have been asked again
// for all 260 reports: about $80 for answers that could not differ, because
// the model is sent the prompt and nothing else.
//
// These drive the whole plugin through the engine's harness, with the durable
// store on a real sqlite file and the provider replaced, across two processes:
// the one that paid for the answer and the one that sees the re-sent file.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import knexFactory from 'knex'
import { z } from 'zod'
import runtime from 'mikser-io/src/runtime.js'
import { createHarness } from 'mikser-io/testing/harness.js'

import { ocr, __setGenerateObjectForTests } from '../index.js'
import { migrations, QUESTION_ONLY } from '../lib/ledger.js'

const PATTERN = '/skincheck/Janus/**/*.json'
const MODEL = { provider: 'anthropic', modelId: 'claude-test' }
const READING = z.object({ summary: z.string() })
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex')

// The question is built from meta, the way the reported site builds it.
const reading = (over = {}) => ({
    name: 'reading', schema: READING, source: false,
    prompt: (entity) => `Explain these measures: ${JSON.stringify(entity.meta.measures)}`,
    ...over,
})

const report = (checksum, meta = {}) => ({
    id: '/skincheck/Janus/0888_271026.json',
    collection: 'skincheck',
    uri: '/srv/premium/skincheck/Janus/0888_271026.json',
    checksum,
    // What a step that reads the document is sent.
    content: JSON.stringify({ measures: { pores: 3 }, ...meta }),
    meta: { measures: { pores: 3 }, ...meta },
})

// The same file again, with a block nothing asks about.
const resent = () => report('v2', { tables: { pores: [[1, 2], [3, 4]] } })

let dir, knex, calls

before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ocr-question-only-'))
    knex = knexFactory({
        client: 'better-sqlite3',
        connection: { filename: path.join(dir, 'mikser.data.sqlite') },
        useNullAsDefault: true,
    })
    for (const migration of migrations) await migration.up(knex)
    runtime.durable = knex
})

after(async () => {
    __setGenerateObjectForTests(null)
    runtime.durable = null
    await knex?.destroy()
    await rm(dir, { recursive: true, force: true })
})

beforeEach(async () => {
    await knex('mikser_ocr_extractions').del()
    await knex('mikser_ocr_requeue').del()
    calls = 0
    __setGenerateObjectForTests(async () => {
        calls++
        return { object: { success: true, error: null, data: { summary: 'Calm skin.' } } }
    })
})

afterEach(() => __setGenerateObjectForTests(null))

// One process, one cycle over what the journal holds, and the entity as
// the cycle left it.
async function run(step, { journal = [], entities = [] } = {}) {
    const h = createHarness({ entities, journal: journal.map(entity => ({ operation: 'update', entity })) })
    h.core.updatedHook = async () => {}
    h.core.triggeredHook = async () => {}
    ocr({ model: MODEL, concurrency: 1, retries: 0, match: { [PATTERN]: [step] } })(h.core)
    await h.runHook('process', new AbortController().signal)
    await h.runHook('processed')
    return h.journal.map(e => e.entity)
}

const ledgerSource = async () =>
    (await knex('mikser_ocr_extractions').where({ step: 'reading' }).first())?.source

describe('a step asked only its prompt', () => {
    it('is not asked again when the re-sent file adds a block no question reads', async () => {
        await run(reading(), { journal: [report('v1')] })
        assert.equal(calls, 1)

        const [after] = await run(reading(), { journal: [resent()] })
        assert.equal(calls, 1, 'the question did not change, so neither can the answer')
        assert.equal(after.meta.summary, 'Calm skin.', 'the stored answer is on the page all the same')
        assert.deepEqual(after.meta.tables.pores, [[1, 2], [3, 4]])
    })

    it('finds the answers 11.9.0 filed against the file, after the file changed', async () => {
        // The upgrade path. Up to 11.9.0 every step was filed against the
        // file — exactly what an explicit `sourceInKey: true` does now. If the
        // re-send lands before anything looked those rows up, they carry the
        // OLD checksum, and refusing them would be the full re-ask the
        // upgrade exists to avoid.
        await run(reading({ sourceInKey: true }), { journal: [report('v1')] })
        assert.equal(await ledgerSource(), 'sum:v1')

        const [after] = await run(reading(), { journal: [resent()] })
        assert.equal(calls, 1)
        assert.equal(after.meta.summary, 'Calm skin.')
        assert.equal(await ledgerSource(), QUESTION_ONLY, 're-filed, so the table says what it depends on')
    })

    it('is asked again when what the question is about changed', async () => {
        await run(reading(), { journal: [report('v1')] })
        await run(reading(), { journal: [report('v2', { measures: { pores: 4 } })] })
        assert.equal(calls, 2, 'a new measure is a new question')
    })

    it('is not counted as unanswered at startup when its answer was filed against an older file', async () => {
        // The sweep asks the ledger the same way the pass does. Asked the
        // old way, every re-sent report would look unanswered at the next
        // restart and be queued.
        await run(reading({ sourceInKey: true }), { journal: [report('v1')] })
        const { meta: { summary, ...rest }, ...unanswered } = resent()
        await run(reading(), { entities: [{ ...unanswered, meta: rest }] })
        assert.equal(calls, 1)
        assert.equal(await knex('mikser_ocr_requeue').count({ n: '*' }).first().then(r => Number(r.n)), 0)
    })
})

describe('what keeps the document in the key', () => {
    it('a step that reads it is asked again when it changes', async () => {
        const step = { name: 'reading', schema: READING, prompt: 'Explain the report.' }
        await run(step, { journal: [report('v1')] })
        await run(step, { journal: [resent()] })
        assert.equal(calls, 2, 'its answer was read from those bytes')
    })

    it('a `key` standing in for the prompt', async () => {
        // The key hides the data the prompt was built from; only the file
        // still says when that changed.
        await run(reading({ key: 'reading-v1' }), { journal: [report('v1')] })
        await run(reading({ key: 'reading-v1' }), { journal: [resent()] })
        assert.equal(calls, 2)
    })

    it('attached files, until the author says the prompt identifies them', async () => {
        const attach = () => [{ data: JPEG, mediaType: 'image/jpeg' }]
        await run(reading({ attach }), { journal: [report('v1')] })
        await run(reading({ attach }), { journal: [resent()] })
        assert.equal(calls, 2, 'the files may be chosen from what the document says')

        // Declared — and the answer already filed for this exact question is
        // used, whichever file it was filed against. That is how a step
        // like the reported site's `visual` upgrades without a re-ask.
        await run(reading({ attach, sourceInKey: false }), { journal: [report('v3')] })
        assert.equal(calls, 2)
        assert.equal(await ledgerSource(), QUESTION_ONLY)
    })
})
