// How many extractions run at once.
//
// The default moved from 1 to 4. Serial was the cautious choice and the
// caution was misplaced: the per-document work shares nothing between
// documents, and at ~50s per report a thousand reports is fourteen hours
// of a cold rebuild — which any config change triggers, because the
// catalog is wiped and only the ledger saves it.
//
// Four is meant to sit under a default provider tier rather than be the
// thing that trips its rate limit.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConcurrency, DEFAULT_CONCURRENCY } from '../index.js'

describe('resolveConcurrency', () => {
    it('defaults to four', () => {
        assert.equal(DEFAULT_CONCURRENCY, 4)
        assert.equal(resolveConcurrency(undefined), 4)
        assert.equal(resolveConcurrency(null), 4)
    })

    it('honours an explicit setting, including strictly serial', () => {
        assert.equal(resolveConcurrency(1), 1, 'concurrency: 1 must still mean serial')
        assert.equal(resolveConcurrency(16), 16)
    })

    it('never returns something p-map would reject', () => {
        // p-map throws on 0 and negatives, which would stop the build over
        // a config typo. The worst outcome of a bad value here is a slower
        // or faster pass, never a wrong one.
        assert.equal(resolveConcurrency(0), 1)
        assert.equal(resolveConcurrency(-3), 1)
        assert.equal(resolveConcurrency(Number.NaN), 1)
        assert.equal(resolveConcurrency('nonsense'), 1)
    })

    it('truncates a fraction rather than passing it on', () => {
        assert.equal(resolveConcurrency(2.7), 2)
        assert.equal(resolveConcurrency(0.5), 1)
    })

    it('reads a numeric string, since env vars are strings', () => {
        assert.equal(resolveConcurrency('8'), 8)
    })
})
