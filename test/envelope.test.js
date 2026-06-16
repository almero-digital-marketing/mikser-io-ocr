// Envelope tests — uses real zod (the plugin builds the envelope with
// it, so the test should too).

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'

import { buildEnvelope, readEnvelope, FAILURE_INSTRUCTION } from '../lib/envelope.js'

const invoice = z.object({
    number: z.string(),
    total:  z.number(),
})

describe('buildEnvelope', () => {
    it('accepts a success result carrying valid data', () => {
        const env = buildEnvelope(invoice)
        const r = env.safeParse({ success: true, error: null, data: { number: 'A1', total: 42 } })
        assert.equal(r.success, true)
    })

    it('accepts a failure result with null data', () => {
        const env = buildEnvelope(invoice)
        const r = env.safeParse({ success: false, error: 'illegible scan', data: null })
        assert.equal(r.success, true, 'envelope itself parses; failure is a valid envelope value')
    })

    it('the inner schema is only enforced when data is present', () => {
        const env = buildEnvelope(invoice)
        // data null → inner required fields not demanded
        assert.equal(env.safeParse({ success: false, error: 'blank', data: null }).success, true)
        // data present but invalid → rejected
        assert.equal(env.safeParse({ success: true, error: null, data: { number: 'A1' } }).success, false)
    })
})

describe('readEnvelope', () => {
    it('unwraps a clean success into { ok: true, data }', () => {
        const out = readEnvelope({ success: true, error: null, data: { number: 'A1', total: 42 } })
        assert.deepEqual(out, { ok: true, data: { number: 'A1', total: 42 } })
    })

    it('reports failure with the model-supplied reason', () => {
        const out = readEnvelope({ success: false, error: 'page is blank', data: null })
        assert.deepEqual(out, { ok: false, reason: 'page is blank' })
    })

    it('treats success=true with null data as a failure (defensive)', () => {
        const out = readEnvelope({ success: true, error: null, data: null })
        assert.equal(out.ok, false)
        assert.match(out.reason, /could not process/)
    })

    it('treats a missing success flag as a failure', () => {
        const out = readEnvelope({ data: { number: 'A1', total: 42 } })
        assert.equal(out.ok, false)
    })

    it('falls back to a generic reason when error is empty', () => {
        const out = readEnvelope({ success: false, error: '', data: null })
        assert.match(out.reason, /could not process/)
    })

    it('handles null/garbage input without throwing', () => {
        assert.equal(readEnvelope(null).ok, false)
        assert.equal(readEnvelope(undefined).ok, false)
    })
})

describe('FAILURE_INSTRUCTION', () => {
    it('references every envelope field name so prompt and schema stay in sync', () => {
        assert.match(FAILURE_INSTRUCTION, /success/)
        assert.match(FAILURE_INSTRUCTION, /error/)
        assert.match(FAILURE_INSTRUCTION, /data/)
    })

    it('tells the model not to fabricate', () => {
        assert.match(FAILURE_INSTRUCTION, /invent|guess|fabricat|approximat/i)
    })
})
