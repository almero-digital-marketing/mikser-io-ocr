// Adding one field must not re-read the document.
//
// `schema_hash` is over the whole schema, so any edit missed every stored
// row. Reported: one field added to a forty-field schema over 8-page 4 MB
// PDFs re-read all twelve documents, 4m44s and a full bill, to obtain one
// number each — about six and a half hours at a thousand documents. Nothing
// was stale and nothing had failed.
//
// Deliberately NOT a tolerant hash. Hashing "the shape that constrains the
// answer" would make an optional addition match the old row and hand back
// the old answer — and the new field would then be absent forever with
// nothing saying so. That trades a bill for silent incompleteness, which is
// the worse currency.
//
// zod decides instead: validate the stored answer against the schema as it
// is NOW.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'

import { satisfies, reusablePrior, missingFields, partialSchema, planFromPriors } from '../lib/backfill.js'

const BEFORE = z.object({
    patient: z.string(),
    findings: z.array(z.string()),
})
const STORED = { patient: 'A. Ivanova', findings: ['nevus, benign'] }

// The two ways to add a field, and they are not the same event.
const PLUS_OPTIONAL = z.object({
    patient: z.string(),
    findings: z.array(z.string()),
    uvSensitivity: z.number().optional(),
})
const PLUS_NULLABLE = z.object({
    patient: z.string(),
    findings: z.array(z.string()),
    uvSensitivity: z.number().nullable(),
})

describe('an additive schema change', () => {
    it('reuses the stored answer when it still satisfies the schema', () => {
        // The `.optional()` case, and most schema edits are this. Zero model
        // calls: the answer on file IS a valid answer to the new question.
        assert.equal(satisfies(PLUS_OPTIONAL, STORED), true)
        const plan = planFromPriors(PLUS_OPTIONAL, [STORED])
        assert.deepEqual(plan.reuse, STORED)
        assert.equal(plan.backfill, undefined, 'nothing needs asking')
    })

    it('asks only for the field that is actually missing', () => {
        // The `.nullable()` case from the report: required, so the stored
        // answer no longer validates and something must be asked — but one
        // field of forty, not forty.
        const plan = planFromPriors(PLUS_NULLABLE, [STORED])
        assert.equal(plan.reuse, undefined)
        assert.deepEqual(plan.fields, ['uvSensitivity'])
        assert.deepEqual(Object.keys(plan.backfill.shape), ['uvSensitivity'],
            'the question sent to the model is the gap, not the whole schema')
        assert.deepEqual(plan.prior, STORED, 'and it is merged onto what was already known')
    })

    it('produces a complete answer when the backfill is merged', () => {
        const plan = planFromPriors(PLUS_NULLABLE, [STORED])
        const merged = { ...plan.prior, uvSensitivity: 3 }
        assert.equal(satisfies(PLUS_NULLABLE, merged), true,
            'the merge must validate against the FULL schema before it is stored')
    })

    it('prefers the newest generation that still fits', () => {
        const stale = { patient: 'old', findings: [] }
        const plan = planFromPriors(PLUS_OPTIONAL, [STORED, stale])
        assert.deepEqual(plan.reuse, STORED, 'priors arrive newest first')
    })
})

describe('when a partial ask will not do', () => {
    it('does the full extraction when nothing is stored', () => {
        assert.equal(planFromPriors(PLUS_NULLABLE, []), null)
        assert.equal(planFromPriors(PLUS_NULLABLE, null), null)
    })

    it('does the full extraction when EVERY field is missing', () => {
        // Asking for every field is the full extraction, without the merge
        // risk, so it goes down the ordinary path.
        assert.equal(planFromPriors(PLUS_NULLABLE, [{ unrelated: true }]), null)
    })

    it('does not attempt a partial ask when the failure is object-level', () => {
        // A refinement fails on the OBJECT while every field validates on its
        // own, so there is no gap to narrow to. In zod 4 a refined object
        // still exposes `shape` and `pick`, which is exactly the case that
        // would produce a partial ask for zero fields and then merge a
        // half-answer over a rejected one.
        const refined = z.object({ a: z.number(), b: z.number() })
            .refine(v => v.a < v.b, 'a must be below b')
        assert.deepEqual(missingFields(refined, { a: 5, b: 1 }), [],
            'each field is individually fine — the object is not')
        assert.equal(satisfies(refined, { a: 5, b: 1 }), false)
        assert.equal(planFromPriors(refined, [{ a: 5, b: 1 }]), null,
            'an object-level failure is not fixed by re-asking a field')
    })

    it('does not attempt a partial ask on a schema with no shape at all', () => {
        const union = z.union([z.object({ a: z.string() }), z.object({ b: z.string() })])
        assert.equal(missingFields(union, { c: 1 }), null)
        assert.equal(planFromPriors(union, [{ c: 1 }]), null)
    })

    it('treats a narrowed type as missing, not as satisfied', () => {
        // Not every edit is additive. A field whose type tightened has a
        // stored value that no longer validates, and it must be re-asked.
        const narrowed = z.object({
            patient: z.string(),
            findings: z.array(z.string()).min(2),
        })
        assert.deepEqual(missingFields(narrowed, STORED), ['findings'])
    })

    it('treats a removed field as nothing to ask about', () => {
        const fewer = z.object({ patient: z.string() })
        assert.deepEqual(missingFields(fewer, STORED), [])
        assert.equal(satisfies(fewer, STORED), true, 'an extra stored key does not invalidate')
    })
})

describe('the pieces, exactly', () => {
    it('satisfies() refuses non-objects rather than throwing', () => {
        assert.equal(satisfies(BEFORE, null), false)
        assert.equal(satisfies(BEFORE, 'nope'), false)
        assert.equal(satisfies(BEFORE, undefined), false)
    })

    it('reusablePrior() returns null when none fit', () => {
        assert.equal(reusablePrior(PLUS_NULLABLE, [STORED]), null)
    })

    it('missingFields() asks each field through its own validator', () => {
        // Not a presence check: `undefined` is legitimately satisfied for an
        // optional field, and null is not for a plain one.
        const schema = z.object({ a: z.string().optional(), b: z.string() })
        assert.deepEqual(missingFields(schema, { b: 'here' }), [])
        assert.deepEqual(missingFields(schema, { a: 'here' }), ['b'])
        assert.deepEqual(missingFields(schema, { b: null }), ['b'])
    })

    it('partialSchema() returns null for an empty gap', () => {
        assert.equal(partialSchema(PLUS_NULLABLE, []), null)
        assert.equal(partialSchema(PLUS_NULLABLE, null), null)
    })
})
