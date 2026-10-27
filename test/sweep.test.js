// What a restart looks for: matched documents with no answer.
//
// On 27.10.2026 a restart after the spend cap was lifted asked about 2
// documents out of 178, because it only saw what the journal carried. The
// sweep asks the catalog instead — and must not ask about what is already
// answered, or every restart becomes a bill.

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import knexFactory from 'knex'
import { z } from 'zod'
import runtime from 'mikser-io/src/runtime.js'

import { migrations, questionFingerprint, writeLedger } from '../lib/ledger.js'
import { unansweredStep, literalPrefix, idRanges } from '../lib/sweep.js'

const MODEL = { provider: 'anthropic', modelId: 'claude-test' }
const VISUAL = z.object({ visualCheck: z.object({ acne: z.string() }) })
const READING = z.object({ summary: z.string() })
const PATTERN = '/skincheck/Janus/**/*.json'

const hitFor = (spec) => ({ pattern: PATTERN, spec })
const options = { model: MODEL }
const report = (meta = {}, over = {}) =>
    ({ id: '/skincheck/Janus/0888_271026.json', checksum: 'c1', meta: { measures: {}, ...meta }, ...over })

let dir, knex

before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ocr-sweep-'))
    knex = knexFactory({
        client: 'better-sqlite3',
        connection: { filename: path.join(dir, 'mikser.data.sqlite') },
        useNullAsDefault: true,
    })
    for (const migration of migrations) await migration.up(knex)
    runtime.durable = knex
})

after(async () => {
    runtime.durable = null
    await knex?.destroy()
    await rm(dir, { recursive: true, force: true })
})

beforeEach(async () => { await knex('mikser_ocr_extractions').del() })

describe('unansweredStep', () => {
    const visual = [{ name: 'visual', schema: VISUAL, source: false, prompt: 'look' }]

    it('names the step a document with no answer is owed', async () => {
        assert.equal(await unansweredStep(report(), hitFor(visual), { options }), `${PATTERN}#visual`)
    })

    it('is null when meta already satisfies every step', async () => {
        const answered = report({ visualCheck: { acne: 'none' } })
        assert.equal(await unansweredStep(answered, hitFor(visual), { options }), null)
    })

    it('is null when the ledger holds the answer — asking would cost nothing but a re-render', async () => {
        const entity = report()
        const identity = questionFingerprint({ schema: VISUAL, model: MODEL, prompt: 'look', step: 'visual' })
        await writeLedger(entity, identity, 'sum:c1', { visualCheck: { acne: 'mild' } })
        assert.equal(await unansweredStep(entity, hitFor(visual), { options }), null)
    })

    it('still asks a step that reads the file when the ledger answer is for an older version of it', async () => {
        const reads = [{ name: 'visual', schema: VISUAL, prompt: 'look' }]
        const entity = report()
        const identity = questionFingerprint({ schema: VISUAL, model: MODEL, prompt: 'look', step: 'visual' })
        await writeLedger(entity, identity, 'sum:c1', { visualCheck: { acne: 'mild' } })
        const edited = report({}, { checksum: 'c2' })
        assert.equal(await unansweredStep(edited, hitFor(reads), { options }), `${PATTERN}#visual`)
    })

    it('does not ask a step sent only its prompt because the file changed', async () => {
        // The same question has the same answer, whatever the file's bytes.
        const entity = report()
        const identity = questionFingerprint({ schema: VISUAL, model: MODEL, prompt: 'look', step: 'visual' })
        await writeLedger(entity, identity, 'sum:c1', { visualCheck: { acne: 'mild' } })
        const edited = report({}, { checksum: 'c2' })
        assert.equal(await unansweredStep(edited, hitFor(visual), { options }), null)
    })

    it('is null for a step whose prompt says it is not ready', async () => {
        // Waiting on something other than the model — a face-points pass, a
        // findings plugin. Queueing it would ask nothing.
        const waiting = [{ name: 'visual', schema: VISUAL, source: false,
            prompt: (entity) => entity.meta.faceAnchors ? 'look' : null }]
        assert.equal(await unansweredStep(report(), hitFor(waiting), { options }), null)
    })

    it('judges a later step against what the ledger gave the earlier one', async () => {
        const sequence = [
            { name: 'visual', schema: VISUAL, source: false, prompt: 'look' },
            { name: 'reading', schema: READING, source: false,
                prompt: (entity) => `write about ${entity.meta.visualCheck.acne}` },
        ]
        const entity = report()
        const identity = questionFingerprint({ schema: VISUAL, model: MODEL, prompt: 'look', step: 'visual' })
        await writeLedger(entity, identity, 'sum:c1', { visualCheck: { acne: 'mild' } })
        assert.equal(await unansweredStep(entity, hitFor(sequence), { options }), `${PATTERN}#reading`,
            'the reading prompt can only be built from the restored visual answer')
    })

    it('asks whatever meta lacks when there is no ledger at all', async () => {
        assert.equal(await unansweredStep(report(), hitFor(visual), { options: { ...options, cache: false } }),
            `${PATTERN}#visual`)
    })

    it('is null for a match the plugin cannot read, which the pass reports itself', async () => {
        assert.equal(await unansweredStep(report(), hitFor([]), { options }), null)
    })
})

describe('narrowing the catalog walk', () => {
    it('takes the literal start of a glob', () => {
        assert.equal(literalPrefix('/skincheck/Janus/**/*.json'), '/skincheck/Janus/')
        assert.equal(literalPrefix('/documents/invoice-*.pdf'), '/documents/invoice-')
        assert.equal(literalPrefix('/exact/id.pdf'), '/exact/id.pdf')
        assert.equal(literalPrefix('**/*.pdf'), '')
        assert.equal(literalPrefix('/a/{b,c}/*.pdf'), '/a/')
    })

    it('walks one id range per distinct prefix, dropping ranges another covers', () => {
        assert.deepEqual(idRanges(['/skincheck/Janus/**/*.json', '/skincheck/**/*.pdf', '/invoices/*.pdf']), [
            { id: { $gte: '/invoices/', $lt: '/invoices0' } },
            { id: { $gte: '/skincheck/', $lt: '/skincheck0' } },
        ])
    })

    it('walks everything when a pattern starts with a wildcard', () => {
        assert.deepEqual(idRanges(['**/*.pdf', '/skincheck/**']), [null])
    })

    it('covers every id the pattern can match and nothing outside the prefix', () => {
        const [range] = idRanges(['/skincheck/**'])
        const inside = (id) => id >= range.id.$gte && id < range.id.$lt
        assert.equal(inside('/skincheck/Janus/a.json'), true)
        assert.equal(inside('/skincheck/'), true)
        assert.equal(inside('/skincheck0'), false)
        assert.equal(inside('/skinchecks/a.json'), false)
        assert.equal(inside('/documents/a.md'), false)
    })
})
