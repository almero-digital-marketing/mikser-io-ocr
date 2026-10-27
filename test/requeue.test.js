// The record of extractions that threw, and when to ask again.
//
// Reported 27.10.2026: a spend cap refused 176 of 260 reports mid-rebuild.
// The cap was lifted, mikser restarted, and the 176 stayed blank — nothing
// had written down that they were owed an answer, and the journal only
// carries an entity again when its file changes. These pin down the record
// that now says so, against the real migration on a real sqlite file.

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import knexFactory from 'knex'
import runtime from 'mikser-io/src/runtime.js'

import { migrations } from '../lib/ledger.js'
import {
    resolveRequeue, requeueDelay, describeDelay, matchKey, readRequeue, isDue, nextRetryAt,
    recordRetry, recordDeclined, recordReimport, queueNow, clearRequeue, createBreaker,
    DEFAULT_REQUEUE, TRIP_AFTER, RETRY, DECLINED, REIMPORT,
} from '../lib/requeue.js'

const TABLE = 'mikser_ocr_requeue'
const VISUAL = '/skincheck/Janus/**/*.json#visual'
const READING = '/skincheck/Janus/**/*.json#reading'
const ID = '/skincheck/Janus/0888123456_271026.json'
const CAP = 'You have reached your specified API usage limits'

let dir, knex

before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ocr-requeue-'))
    knex = knexFactory({
        client: 'better-sqlite3',
        connection: { filename: path.join(dir, 'mikser.data.sqlite') },
        useNullAsDefault: true,
    })
    // The real migrations, in order — the table users get, not a copy of it.
    for (const migration of migrations) await migration.up(knex)
    runtime.durable = knex
})

after(async () => {
    runtime.durable = null
    await knex?.destroy()
    await rm(dir, { recursive: true, force: true })
})

beforeEach(async () => { await knex(TABLE).del() })

const policy = { first: 60_000, max: 3_600_000 }
const fail = (over = {}, now) => recordRetry({
    id: ID, key: VISUAL, keys: [VISUAL], step: VISUAL, source: 'sum:a', reason: CAP, ...over,
}, policy, now)
const rowOf = async (key = VISUAL) => (await readRequeue([key])).get(ID)

describe('the requeue policy', () => {
    it('is on by default, and off only when asked', () => {
        assert.deepEqual(resolveRequeue(undefined), DEFAULT_REQUEUE)
        assert.deepEqual(resolveRequeue(true), DEFAULT_REQUEUE)
        assert.equal(resolveRequeue(false), null, '`requeue: false` is the behaviour before it existed')
    })

    it('takes what the config sets and falls back on nonsense', () => {
        assert.deepEqual(resolveRequeue({ first: 5_000, max: 20_000 }), { first: 5_000, max: 20_000 })
        assert.deepEqual(resolveRequeue({ first: 'soon', max: -1 }), DEFAULT_REQUEUE)
        assert.deepEqual(resolveRequeue({ first: 90_000, max: 1_000 }), { first: 90_000, max: 90_000 },
            'a ceiling below the first delay would mean asking sooner after more failures')
    })

    it('doubles the delay after each failure and stops at the ceiling', () => {
        const delays = [1, 2, 3, 4, 5, 6, 7, 8].map(n => requeueDelay(n, policy))
        assert.deepEqual(delays.slice(0, 6), [60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000])
        assert.deepEqual(delays.slice(6), [3_600_000, 3_600_000])
    })

    it('stays finite for a row that has failed for a very long time', () => {
        // A spend cap that resets on the 1st is weeks of failures.
        assert.equal(requeueDelay(10_000, policy), policy.max)
    })

    it('says a delay the way a person reads it', () => {
        assert.equal(describeDelay(30_000), '30s')
        assert.equal(describeDelay(240_000), '4m')
        assert.equal(describeDelay(3_600_000), '1h')
        assert.equal(describeDelay(5_400_000), '1.5h')
    })
})

describe('the key a row is filed under', () => {
    it('is the pattern plus the step names, so two ocr() calls over one pattern stay apart', () => {
        // The reported site asks two questions of the same files, in two
        // ocr() calls: one reads the photographs, one writes the summary.
        assert.equal(matchKey('/skincheck/Janus/**/*.json', [{ name: 'visual' }]), VISUAL)
        assert.equal(matchKey('/skincheck/Janus/**/*.json', [{ name: 'reading' }]), READING)
        assert.notEqual(VISUAL, READING)
    })

    it('is the pattern alone for a single-value match, which has no step name', () => {
        assert.equal(matchKey('/invoices/**/*.pdf', [{ name: '' }]), '/invoices/**/*.pdf')
    })
})

describe('recording a call that threw', () => {
    it('makes the document due again after the first delay', async () => {
        const now = 1_000_000
        const plan = await fail({}, now)
        assert.deepEqual(plan, { attempts: 1, delay: 60_000, retryAt: now + 60_000 })

        const row = await rowOf()
        assert.equal(row.kind, RETRY)
        assert.equal(row.reason, CAP)
        assert.equal(isDue(row, now + 59_999), false)
        assert.equal(isDue(row, now + 60_000), true)
    })

    it('backs off further with every failure in a row', async () => {
        await fail({}, 0)
        await fail({ previous: await rowOf() }, 0)
        const third = await fail({ previous: await rowOf() }, 0)
        assert.equal(third.attempts, 3)
        assert.equal(third.delay, 240_000)
    })

    it('starts counting again when the document itself changed', async () => {
        await fail({}, 0)
        await fail({ previous: await rowOf() }, 0)
        const edited = await fail({ source: 'sum:b', previous: await rowOf() }, 0)
        assert.equal(edited.attempts, 1, 'a changed file is a new document')
    })

    it('reports when the next attempt is due', async () => {
        await fail({}, 1_000)
        await recordRetry({ id: '/skincheck/Janus/other.json', key: VISUAL, keys: [VISUAL],
            step: VISUAL, source: 'sum:o', reason: CAP }, { first: 5_000, max: 5_000 }, 1_000)
        assert.equal(await nextRetryAt([VISUAL]), 6_000, 'the earliest of them')
        assert.equal(await nextRetryAt([READING]), null, 'nothing for another ocr() call')
    })
})

describe('a model that declined', () => {
    it('is recorded but never due — its answer is not retried', async () => {
        await recordDeclined({ id: ID, key: VISUAL, keys: [VISUAL], step: VISUAL,
            source: 'sum:a', reason: 'the photographs are too dark' })
        const row = await rowOf()
        assert.equal(row.kind, DECLINED)
        assert.equal(isDue(row, Number.MAX_SAFE_INTEGER), false)
        assert.equal(await nextRetryAt([VISUAL]), null, 'a declined row must not wake anything')
    })
})

describe('a re-import waiting to land', () => {
    it('stays due later, backing off, in case it never does', async () => {
        await recordReimport({ id: ID, key: VISUAL, keys: [VISUAL], step: VISUAL, source: 'sum:a' }, policy, 0)
        const first = await rowOf()
        assert.equal(first.kind, REIMPORT)
        assert.equal(Number(first.retry_at), 60_000)

        await recordReimport({ id: ID, key: VISUAL, keys: [VISUAL], step: VISUAL, source: 'sum:a',
            previous: first }, policy, 0)
        assert.equal(Number((await rowOf()).retry_at), 120_000)
    })
})

describe('queueing at startup', () => {
    it('makes a document due now', async () => {
        await queueNow([{ id: ID, key: VISUAL, step: VISUAL, source: 'sum:a' }], [VISUAL], 5_000)
        const row = await rowOf()
        assert.equal(row.kind, RETRY)
        assert.equal(isDue(row, 5_000), true)
        assert.equal(row.attempts, 0, 'nothing has failed yet — it was never asked')
    })

    it('asks now but keeps the count of a row that was backing off', async () => {
        // A restart is "try now", not "the provider never failed".
        await fail({}, 0)
        await fail({ previous: await rowOf() }, 0)
        await queueNow([{ id: ID, key: VISUAL, step: VISUAL, source: 'sum:a', previous: await rowOf() }],
            [VISUAL], 10)
        const row = await rowOf()
        assert.equal(isDue(row, 10), true)
        assert.equal(row.attempts, 2)
        assert.equal(row.reason, CAP)
    })
})

describe('clearing', () => {
    it("touches only this ocr() call's rows", async () => {
        await fail({ key: VISUAL, keys: [VISUAL] })
        await fail({ key: READING, keys: [READING] })
        await clearRequeue(ID, [VISUAL])
        assert.equal(await rowOf(VISUAL), undefined)
        assert.ok(await rowOf(READING), "one call's answer must not clear the other's failure")
    })

    it('keeps one row per document per call when its pattern changes', async () => {
        const OLD = '/skincheck/**/*.json#visual'
        await fail({ key: OLD, keys: [OLD, VISUAL] })
        await fail({ key: VISUAL, keys: [OLD, VISUAL] })
        const rows = await knex(TABLE).where({ id: ID })
        assert.deepEqual(rows.map(r => r.match_key), [VISUAL], 'two rows would ask twice')
    })
})

describe('without a durable store', () => {
    it('writes nothing and never throws', async () => {
        runtime.durable = null
        try {
            assert.equal(await fail(), null)
            assert.equal(await nextRetryAt([VISUAL]), null)
            assert.equal((await readRequeue([VISUAL])).size, 0)
            assert.equal(await queueNow([{ id: ID, key: VISUAL }], [VISUAL]), 0)
        } finally {
            runtime.durable = knex
        }
    })
})

describe('the breaker', () => {
    it(`opens after ${TRIP_AFTER} thrown failures in a row, and says so once`, () => {
        const breaker = createBreaker()
        const opened = [CAP, CAP, CAP, CAP].map(reason => breaker.failed(reason))
        assert.deepEqual(opened, [false, false, true, false])
        assert.equal(breaker.open, true)
        assert.equal(breaker.reason, CAP)
    })

    it('does not open on failures with answers between them', () => {
        const breaker = createBreaker()
        breaker.failed('Invalid JSON')
        breaker.failed('Invalid JSON')
        breaker.answered()
        breaker.failed('Invalid JSON')
        assert.equal(breaker.open, false, 'one bad response is the document, not the provider')
    })

    it('closes again when a call in flight comes back answered', () => {
        const breaker = createBreaker()
        for (let i = 0; i < TRIP_AFTER; i++) breaker.failed(CAP)
        breaker.answered()
        assert.equal(breaker.open, false)
    })
})
