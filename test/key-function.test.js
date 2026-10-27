// A `key` that is a function of the entity, and a key given to a step whose
// answers were filed under its prompt.
//
// Reported 27.10.2026: a site asks for its notes with the client's whole
// readings table in the prompt. One row added to the clinic's sheet changed
// every report's prompt, and the next deploy would have asked 270 reports
// again, twice each, for notes on the same recommendations. The site keys
// the question on the prompt without the readings — and giving the step that
// key must not itself be the full re-ask.
//
// Driven through the whole plugin with the engine's harness, the durable
// store on a real sqlite file and the provider replaced, as in
// question-only.test.js.

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
import { migrations } from '../lib/ledger.js'

const PATTERN = '/skincheck/Janus/**/*.json'
const MODEL = { provider: 'anthropic', modelId: 'claude-test' }
const NOTES = z.object({ notes: z.string() })

// The prompt carries the recommendations and the readings, as the reported
// site's does.
const prompt = (entity) => `Explain the cards.\n\nReadings:\n${JSON.stringify(entity.meta.readings)}\n\nCards:\n${entity.meta.cards.join(', ')}`
const withoutReadings = (entity, asked) => asked.replace(/\n\nReadings:\n[\s\S]*?\n\nCards:\n/, '\n\nCards:\n')

const notes = (over = {}) => ({ name: 'notes', schema: NOTES, source: false, sourceInKey: false, prompt, ...over })

const report = (meta = {}) => ({
    id: '/skincheck/Janus/0888_271026.json',
    collection: 'skincheck',
    uri: '/srv/premium/skincheck/Janus/0888_271026.json',
    checksum: 'v1',
    meta: { readings: { pores: 3 }, cards: ['pores'], ...meta },
})

let dir, knex, calls

before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ocr-key-function-'))
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
        return { object: { success: true, error: null, data: { notes: `Notes ${calls}.` } } }
    })
})

afterEach(() => __setGenerateObjectForTests(null))

async function run(step, { journal = [], entities = [] } = {}) {
    const h = createHarness({ entities, journal: journal.map(entity => ({ operation: 'update', entity })) })
    h.core.updatedHook = async () => {}
    h.core.triggeredHook = async () => {}
    ocr({ model: MODEL, concurrency: 1, retries: 0, match: { [PATTERN]: [step] } })(h.core)
    await h.runHook('process', new AbortController().signal)
    await h.runHook('processed')
    return h.journal.map(e => e.entity)
}

const rows = async () => Number((await knex('mikser_ocr_extractions').count({ n: '*' }).first()).n)

describe('a key that is a function of the entity', () => {
    it('is not asked again when what the key leaves out changes', async () => {
        await run(notes({ key: withoutReadings }), { journal: [report()] })
        const [after] = await run(notes({ key: withoutReadings }), { journal: [report({ readings: { pores: 3, uv: 6 } })] })
        assert.equal(calls, 1, 'a new reading, the same recommendations')
        assert.equal(after.meta.notes, 'Notes 1.')
    })

    it('is asked again when what the key keeps changes', async () => {
        await run(notes({ key: withoutReadings }), { journal: [report()] })
        await run(notes({ key: withoutReadings }), { journal: [report({ cards: ['pores', 'redness'] })] })
        assert.equal(calls, 2, 'another card is another question')
    })

    it('files under the prompt when it throws', async () => {
        const broken = () => { throw new Error('no cards yet') }
        await run(notes({ key: broken }), { journal: [report()] })
        await run(notes({ key: broken }), { journal: [report({ readings: { pores: 4 } })] })
        assert.equal(calls, 2, 'the prompt changed, and without a key the prompt is the question')
    })
})

describe('a key given to a step that had none', () => {
    it('takes the answer filed under this very prompt instead of asking', async () => {
        await run(notes(), { journal: [report()] })
        assert.equal(calls, 1)

        const [after] = await run(notes({ key: withoutReadings }), { journal: [report()] })
        assert.equal(calls, 1, 'the same prompt, answered already')
        assert.equal(after.meta.notes, 'Notes 1.')
        assert.equal(await rows(), 2, 'filed under the key beside the old row')

        // Filed under the key, it now holds when only the readings change.
        await run(notes({ key: withoutReadings }), { journal: [report({ readings: { pores: 3, uv: 6 } })] })
        assert.equal(calls, 1)
    })

    it('still asks when the prompt itself is new', async () => {
        await run(notes(), { journal: [report()] })
        await run(notes({ key: withoutReadings }), { journal: [report({ readings: { pores: 3, uv: 6 } })] })
        assert.equal(calls, 2, 'nothing was ever filed under this prompt or this key')
    })

    it('is not counted as unanswered at startup', async () => {
        await run(notes(), { journal: [report()] })
        const { meta: { notes: _, ...rest }, ...unanswered } = { ...report(), meta: { ...report().meta } }
        await run(notes({ key: withoutReadings }), { entities: [{ ...unanswered, meta: rest }] })
        assert.equal(calls, 1)
        assert.equal(Number((await knex('mikser_ocr_requeue').count({ n: '*' }).first()).n), 0)
    })
})
