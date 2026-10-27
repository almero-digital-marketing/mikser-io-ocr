// A failed extraction comes back on its own.
//
// Reported 27.10.2026: the Anthropic spend cap refused 176 of 260 skin-check
// reports in the middle of a rebuild. The cap was lifted and mikser
// restarted; the restart journaled 19 entities and asked about the 2 new
// scans, and the 176 stayed blank. Nothing had recorded that they were owed
// an answer, and an entity only re-enters the journal when its file changes.
//
// These drive the whole plugin through the engine's harness — journal,
// catalog, the durable store on a real sqlite file — with the provider
// replaced, across the cycles a real process would run: the failure, the
// retry with nothing in the journal, the answer, and the restart.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { format } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import knexFactory from 'knex'
import { z } from 'zod'
import runtime from 'mikser-io/src/runtime.js'
import { createHarness } from 'mikser-io/testing/harness.js'

import { ocr, __setGenerateObjectForTests } from '../index.js'
import { migrations } from '../lib/ledger.js'
import { readRequeue, RETRY, DECLINED, REIMPORT, TRIP_AFTER } from '../lib/requeue.js'

const TABLE = 'mikser_ocr_requeue'
const PATTERN = '/skincheck/Janus/**/*.json'
const MODEL = { provider: 'anthropic', modelId: 'claude-test' }
const CAP = 'You have reached your specified API usage limits'
const VISUAL = z.object({ visualCheck: z.object({ acne: z.string() }) })
const READING = z.object({ summary: z.string() })
const SKINCHECK = '/srv/premium/skincheck'

const visualStep = { name: 'visual', schema: VISUAL, source: false, prompt: 'look at the photographs' }
const readingStep = { name: 'reading', schema: READING, source: false, prompt: 'write the summary' }
const KEY = `${PATTERN}#visual`

const report = (name, over = {}) => ({
    id: `/skincheck/Janus/${name}.json`,
    collection: 'skincheck',
    uri: `${SKINCHECK}/Janus/${name}.json`,
    checksum: `sum-${name}`,
    meta: { measures: { pores: 3 } },
    ...over,
})

// The provider, by question: what each prompt gets back right now.
function provider() {
    const calls = []
    const modes = { visual: 'answer', reading: 'answer' }
    const fn = async ({ messages }) => {
        const question = JSON.stringify(messages).includes('photographs') ? 'visual' : 'reading'
        calls.push(question)
        const mode = modes[question]
        if (mode === 'refuse') throw new Error(CAP)
        if (mode === 'decline') return { object: { success: false, error: 'the photographs are too dark', data: null } }
        const data = question === 'visual' ? { visualCheck: { acne: 'mild' } } : { summary: 'Calm skin.' }
        return { object: { success: true, error: null, data } }
    }
    return { calls, modes, fn }
}

// Wait for a condition, not for a number of turns: the timer path does real
// I/O before it gets there, and how long that takes is the machine's business.
async function waitFor(condition, what, ms = 2000) {
    const deadline = Date.now() + ms
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
        await new Promise(resolve => setTimeout(resolve, 5))
    }
}

let dir, knex, seam

before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ocr-requeue-pass-'))
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
    await knex(TABLE).del()
    await knex('mikser_ocr_extractions').del()
    seam = provider()
    __setGenerateObjectForTests(seam.fn)
})

afterEach(() => __setGenerateObjectForTests(null))

// One process: a harness standing in for the engine, and the plugin(s) in it.
function boot({ entities = [], journal = [], options = {}, plugins } = {}) {
    const h = createHarness({ entities, journal, options: { sourceFolders: { skincheck: SKINCHECK }, ...options } })
    const reimported = []
    const triggered = []
    h.core.updatedHook = async (name, context) => { reimported.push({ name, ...context }) }
    h.core.triggeredHook = async (name) => { triggered.push(name) }
    for (const plugin of plugins ?? [ocr({
        model: MODEL, concurrency: 1, retries: 0,
        requeue: { first: 20, max: 40 },
        match: { [PATTERN]: [visualStep] },
    })]) plugin(h.core)
    const cycle = async () => {
        await h.runHook('process', new AbortController().signal)
        await h.runHook('processed')
    }
    // The engine clears the journal when a cycle finalizes.
    const finalize = () => { h.journal.length = 0 }
    const said = (level) => h.logs.filter(l => l.level === level).map(l => format(...l.args))
    return { h, cycle, finalize, said, reimported, triggered }
}

const rowsFor = async (key = KEY) => readRequeue([key])
const makeDue = () => knex(TABLE).update({ retry_at: 0 })
const updates = (h) => h.journal.filter(e => e.operation === 'update')

describe('a call that threw', () => {
    it('is written down, with when it will be asked again', async () => {
        seam.modes.visual = 'refuse'
        const x = report('0888_271026')
        const { cycle, said } = boot({ entities: [x], journal: [{ operation: 'create', entity: { ...x } }] })
        await cycle()

        const row = (await rowsFor()).get(x.id)
        assert.equal(row?.kind, RETRY, 'a refused call must leave a record that it is owed')
        assert.equal(row.attempts, 1)
        assert.equal(row.reason, CAP)
        assert.ok(said('error').some(line => line.includes(CAP) && line.includes('asking again in')),
            'the log has to say the document is coming back, not just that it failed')
    })

    it('is asked again in a later cycle with nothing in the journal, and the answer re-enters it', async () => {
        // The reported shape exactly: nothing touches the file, so nothing
        // journals it. The retry has to find it on its own.
        seam.modes.visual = 'refuse'
        const x = report('0888_271026', { collection: 'sheets', uri: 'https://sheets.example/row/7' })
        const { h, cycle, finalize } = boot({ entities: [x], journal: [{ operation: 'create', entity: { ...x } }] })
        await cycle()
        finalize()

        seam.modes.visual = 'answer'
        await makeDue()
        await cycle()

        assert.deepEqual(seam.calls, ['visual', 'visual'])
        const [update] = updates(h)
        assert.equal(update?.entity.id, x.id, 'the answer must reach the pipeline, or the page never shows it')
        assert.deepEqual(update.entity.meta.visualCheck, { acne: 'mild' })
        assert.equal(update.entity.meta.measures.pores, 3, 'the rest of meta is the catalog’s, untouched')
        assert.equal((await rowsFor()).size, 0, 'nothing is owed once it is answered')
    })

    it('touches nothing else in the build while the provider still refuses', async () => {
        seam.modes.visual = 'refuse'
        const x = report('0888_271026')
        const { h, cycle, finalize } = boot({ entities: [x], journal: [{ operation: 'create', entity: { ...x } }] })
        await cycle()
        finalize()

        await makeDue()
        await cycle()
        assert.equal(h.journal.length, 0, 'a refused retry must not re-render or re-derive anything')
        const row = (await rowsFor()).get(x.id)
        assert.equal(row.attempts, 2)
        assert.ok(Number(row.retry_at) > Date.now(), 'and it is pushed further out, not asked every cycle')
    })

    it('waits for its delay rather than being asked every cycle', async () => {
        seam.modes.visual = 'refuse'
        const x = report('0888_271026')
        const { cycle, finalize } = boot({
            entities: [x], journal: [{ operation: 'create', entity: { ...x } }],
            plugins: [ocr({ model: MODEL, concurrency: 1, retries: 0, requeue: { first: 60_000 },
                match: { [PATTERN]: [visualStep] } })],
        })
        await cycle()
        finalize()
        await cycle()
        await cycle()
        assert.deepEqual(seam.calls, ['visual'], 'a cycle that runs for another reason must not hammer the provider')
    })
})

describe('an answer to a document that came from a folder', () => {
    it('is sent back through its source after the cycle, so what follows it is derived again', async () => {
        // On the reported site a later plugin lowers a finding on what the
        // photographs show, and a second ocr() writes its summary from those
        // findings. Applied to the catalog's copy, the summary would describe
        // findings the page no longer has.
        seam.modes.visual = 'refuse'
        const x = report('0888_271026')
        const { h, cycle, finalize, reimported, triggered } = boot({
            entities: [x], journal: [{ operation: 'create', entity: { ...x } }],
            options: { watch: true },
        })
        await cycle()
        finalize()

        seam.modes.visual = 'answer'
        await makeDue()
        await cycle()
        assert.equal(updates(h).length, 0, 'not applied to the copy')
        assert.equal((await rowsFor()).get(x.id)?.kind, REIMPORT, 'and remembered until the re-import lands')

        await waitFor(() => reimported.length === 1, 'the re-import')
        assert.deepEqual(reimported[0], { name: 'skincheck', relativePath: 'Janus/0888_271026.json' })
        await waitFor(() => triggered.length >= 1, 'the cycle that carries it')

        // The re-import arrives as the source made it: fresh meta, no answer.
        // The ledger has it, so the provider is not asked again.
        h.journal.push({ id: 99, operation: 'update', entity: { ...x, meta: { measures: { pores: 3 } } } })
        await cycle()
        assert.deepEqual(seam.calls, ['visual', 'visual'], 'the re-import must not pay for the answer twice')
        assert.deepEqual(h.journal[0].entity.meta.visualCheck, { acne: 'mild' })
        assert.equal((await rowsFor()).size, 0)
    })
})

describe('a provider that refuses everything', () => {
    it(`stops asking after ${TRIP_AFTER} refusals in a row and queues the rest`, async () => {
        seam.modes.visual = 'refuse'
        const reports = ['a', 'b', 'c', 'd', 'e', 'f'].map(name => report(name))
        const { cycle, said } = boot({
            entities: reports,
            journal: reports.map(entity => ({ operation: 'create', entity: { ...entity } })),
        })
        await cycle()

        assert.equal(seam.calls.length, TRIP_AFTER,
            'asking 176 documents once the first few were refused identically buys only refusals')
        const rows = await rowsFor()
        assert.equal(rows.size, 6, 'every one of them is owed an answer, asked or not')
        assert.ok([...rows.values()].every(row => row.kind === RETRY && row.reason === CAP))
        assert.ok(said('warn').some(line => line.includes('3 document(s) were not asked')))
    })

    it('keeps asking while answers arrive between the failures', async () => {
        let n = 0
        __setGenerateObjectForTests(async () => {
            if (n++ % 2 === 0) throw new Error('Invalid JSON')
            return { object: { success: true, error: null, data: { visualCheck: { acne: 'none' } } } }
        })
        const reports = ['a', 'b', 'c', 'd', 'e', 'f'].map(name => report(name))
        const { cycle } = boot({
            entities: reports,
            journal: reports.map(entity => ({ operation: 'create', entity: { ...entity } })),
        })
        await cycle()
        assert.equal(n, 6, 'one bad response at a time is the document, not the provider')
    })
})

describe('a model that declined', () => {
    it('is not asked again on a timer, nor at the next startup', async () => {
        // Its considered "cannot extract" is an answer, and the behaviour for
        // it is unchanged: asked again when the file changes, not before.
        seam.modes.visual = 'decline'
        const x = report('0888_271026')
        const first = boot({ entities: [x], journal: [{ operation: 'create', entity: { ...x } }] })
        await first.cycle()
        assert.equal((await rowsFor()).get(x.id)?.kind, DECLINED)

        const restarted = boot({ entities: [x] })
        await restarted.cycle()
        assert.deepEqual(seam.calls, ['visual'], 'a restart must not pay for the same refusal again')
    })

    it('is asked again when the file itself changes, as before', async () => {
        seam.modes.visual = 'decline'
        const x = report('0888_271026')
        const first = boot({ entities: [x], journal: [{ operation: 'create', entity: { ...x } }] })
        await first.cycle()

        const edited = { ...x, checksum: 'sum-rescanned' }
        const restarted = boot({ entities: [edited] })
        await restarted.cycle()
        assert.deepEqual(seam.calls, ['visual', 'visual'])
    })
})

describe('the first pass after startup', () => {
    it('asks every matched document that has no answer, and nothing else', async () => {
        const answered = report('answered', { meta: { measures: {}, visualCheck: { acne: 'none' } } })
        const unanswered = report('unanswered')
        const elsewhere = { ...report('elsewhere'), id: '/documents/elsewhere.json' }
        const waiting = report('waiting')
        const { h, cycle, finalize, said } = boot({
            entities: [answered, unanswered, elsewhere, waiting],
            plugins: [ocr({
                model: MODEL, concurrency: 1, retries: 0,
                match: { [PATTERN]: [{ ...visualStep,
                    // Not ready until the scan's measures exist — like the
                    // reported step waiting for face points.
                    prompt: (entity) => entity.meta.measures ? 'look at the photographs' : null }] },
            })],
        })
        delete waiting.meta.measures
        await cycle()

        assert.deepEqual(seam.calls, ['visual'], 'only the one with no answer and a question ready')
        assert.deepEqual([...(await rowsFor()).keys()], [unanswered.id],
            'answered, and waiting to go back through its source')
        assert.equal(updates(h).length, 0)
        assert.ok(said('info').some(line => line.includes('1 matched document(s) have no answer yet')))

        finalize()
        await cycle()
        assert.equal(seam.calls.length, 1, 'once per process, not every cycle')
    })

    it('finds what an earlier version left unanswered, with no record of it', async () => {
        // The 176: failed under 11.8.0, which wrote nothing down.
        const blank = ['a', 'b', 'c'].map(name => report(name))
        const { cycle } = boot({ entities: blank })
        await cycle()
        assert.equal(seam.calls.length, 3)
        const rows = [...(await rowsFor()).values()]
        assert.equal(rows.length, 3)
        assert.ok(rows.every(row => row.kind === REIMPORT), 'each answered, each going back through its source')
    })

    it('updates in place what no source can import again', async () => {
        const row = report('7', { id: '/skincheck/Janus/sheet-row-7.json', collection: 'sheets', uri: '' })
        const { h, cycle } = boot({ entities: [row] })
        await cycle()
        assert.equal(updates(h)[0]?.entity.id, row.id)
        assert.deepEqual(updates(h)[0].entity.meta.visualCheck, { acne: 'mild' })
        assert.equal((await rowsFor()).size, 0)
    })

    it('does not ask a document whose answer is in the ledger', async () => {
        const x = report('0888_271026')
        const first = boot({ entities: [x], journal: [{ operation: 'create', entity: { ...x } }] })
        await first.cycle()
        assert.equal(seam.calls.length, 1)

        // The catalog lost meta (a wipe would also re-journal it, but the
        // ledger answer alone must not count as "owed").
        const restarted = boot({ entities: [x] })
        await restarted.cycle()
        assert.equal(seam.calls.length, 1)
    })

    it('asks right away for a document that was backing off, keeping its count', async () => {
        seam.modes.visual = 'refuse'
        const x = report('0888_271026')
        const first = boot({
            entities: [x], journal: [{ operation: 'create', entity: { ...x } }],
            plugins: [ocr({ model: MODEL, concurrency: 1, retries: 0, requeue: { first: 60_000 },
                match: { [PATTERN]: [visualStep] } })],
        })
        await first.cycle()

        // The provider is back and somebody restarts — the first thing tried
        // on the day this was reported.
        seam.modes.visual = 'answer'
        const restarted = boot({
            entities: [x],
            plugins: [ocr({ model: MODEL, concurrency: 1, retries: 0, requeue: { first: 60_000 },
                match: { [PATTERN]: [visualStep] } })],
        })
        await restarted.cycle()
        assert.deepEqual(seam.calls, ['visual', 'visual'])
        assert.equal((await rowsFor()).get(x.id)?.kind, REIMPORT)
    })
})

describe('two ocr() calls over one pattern', () => {
    it('keep their own records', async () => {
        // The reported config: one call reads the photographs, another writes
        // the summary, both over /skincheck/Janus/**/*.json.
        seam.modes.visual = 'refuse'
        const x = report('0888_271026')
        const { cycle } = boot({
            entities: [x], journal: [{ operation: 'create', entity: { ...x } }],
            plugins: [
                ocr({ model: MODEL, retries: 0, match: { [PATTERN]: [visualStep] } }),
                ocr({ model: MODEL, retries: 0, match: { [PATTERN]: [readingStep] } }),
            ],
        })
        await cycle()
        assert.deepEqual(seam.calls.sort(), ['reading', 'visual'])
        assert.equal((await rowsFor(KEY)).get(x.id)?.kind, RETRY,
            "the summary's answer must not clear the photographs' failure")
        assert.equal((await rowsFor(`${PATTERN}#reading`)).size, 0)
    })
})

describe('the timer', () => {
    it('starts a cycle when a retry is due — but never while one is running', async () => {
        // A trigger mid-cycle does not wait: the engine cancels the running
        // cycle and starts again, aborting calls already being paid for.
        seam.modes.visual = 'refuse'
        const x = report('0888_271026')
        const { h, cycle, triggered } = boot({
            entities: [x], journal: [{ operation: 'create', entity: { ...x } }],
            options: { watch: true },
        })
        h.runtime.processing = true
        await cycle()

        await new Promise(resolve => setTimeout(resolve, 150))
        assert.equal(triggered.length, 0, 'due, but a cycle is running')

        h.runtime.processing = false
        await waitFor(() => triggered.length === 1, 'the requeue cycle')
        assert.deepEqual(triggered, ['ocr-requeue'])
    })

    it('starts nothing in a one-shot build, whose next startup sweep is its retry', async () => {
        seam.modes.visual = 'refuse'
        const x = report('0888_271026')
        const { cycle, triggered } = boot({ entities: [x], journal: [{ operation: 'create', entity: { ...x } }] })
        await cycle()
        await new Promise(resolve => setTimeout(resolve, 150))
        assert.equal(triggered.length, 0)
    })
})

describe('requeue: false', () => {
    it('is the behaviour before any of this: no record, no sweep, no timer', async () => {
        seam.modes.visual = 'refuse'
        const x = report('0888_271026')
        const other = report('blank')
        const { h, cycle, said } = boot({
            entities: [x, other], journal: [{ operation: 'create', entity: { ...x } }],
            options: { watch: true },
            plugins: [ocr({ model: MODEL, retries: 0, requeue: false, match: { [PATTERN]: [visualStep] } })],
        })
        await cycle()
        assert.deepEqual(seam.calls, ['visual'], 'only the journaled one — no sweep')
        assert.equal((await knex(TABLE).count({ n: '*' }))[0].n, 0)
        assert.equal(h.hooks.processed.length, 0)
        assert.ok(said('error').every(line => !line.includes('asking again')))
    })
})
