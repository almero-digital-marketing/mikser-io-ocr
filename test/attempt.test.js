// Retrying the transient failures that cost whole documents.
//
// Measured across a day of runs with an unchanged prompt and schema: a
// DIFFERENT report failed on each run, and every one succeeded when re-run
// with nothing changed. So the failure was in the call, not the document —
// and each one left a customer-facing page rendered without its data until
// somebody noticed and touched the file.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { extractWithRetry, backoffDelay, DEFAULT_RETRIES } from '../lib/attempt.js'

// Tests never sleep: the delay is injected precisely so a backoff is not
// something a suite has to wait out.
const nap = async () => {}

// A call that fails the first `failures` times, then succeeds.
function flaky(failures, mode = 'throw') {
    let seen = 0
    return async () => {
        if (seen++ < failures) {
            if (mode === 'throw') throw new Error('Invalid JSON')
            return { ok: false, reason: 'cannot read the document' }
        }
        return { ok: true, data: { patient: 'A. Ivanova' } }
    }
}

describe('a thrown provider error', () => {
    it('is retried and the extraction survives', async () => {
        // The exact observed case: `generateObject failed: Invalid JSON`,
        // which succeeded on a re-run that changed nothing.
        const out = await extractWithRetry({ call: flaky(1), sleep: nap })
        assert.equal(out.ok, true)
        assert.deepEqual(out.data, { patient: 'A. Ivanova' })
        assert.equal(out.attempts, 2)
    })

    it('gives up after `retries` further attempts and says how many', async () => {
        let calls = 0
        const out = await extractWithRetry({
            call: async () => { calls++; throw new Error('gateway timeout') },
            retries: 2, sleep: nap,
        })
        assert.equal(out.ok, false)
        assert.equal(out.threw, true, 'a throw must be reported as a provider fault')
        assert.equal(calls, 3, 'the first attempt plus two retries')
        assert.equal(out.attempts, 3)
        assert.match(out.reason, /gateway timeout/)
    })

    it('can be turned off with retries: 0', async () => {
        let calls = 0
        const out = await extractWithRetry({
            call: async () => { calls++; throw new Error('nope') },
            retries: 0, sleep: nap,
        })
        assert.equal(calls, 1)
        assert.equal(out.ok, false)
    })
})

describe('an envelope reporting failure', () => {
    it('is retried at most once, however high `retries` goes', async () => {
        // The model read the document and said it cannot extract. That is an
        // ANSWER, not a fault — and a genuinely unreadable scan says it every
        // time, at full price. The flake is real, so one more look; ten is
        // burning money on a document that will never parse.
        let calls = 0
        const out = await extractWithRetry({
            call: async () => { calls++; return { ok: false, reason: 'illegible' } },
            retries: 9, sleep: nap,
        })
        assert.equal(calls, 2, `an envelope failure must not be retried ${calls - 1} times`)
        assert.equal(out.ok, false)
        assert.equal(out.threw, false, 'the model answering is not a provider fault')
        assert.match(out.reason, /illegible/, "the model's own reason survives")
    })

    it('still recovers when the one retry is the one that works', async () => {
        const out = await extractWithRetry({ call: flaky(1, 'envelope'), sleep: nap })
        assert.equal(out.ok, true)
        assert.equal(out.attempts, 2)
    })

    it('is not retried at all when retries is 0', async () => {
        let calls = 0
        const out = await extractWithRetry({
            call: async () => { calls++; return { ok: false, reason: 'illegible' } },
            retries: 0, sleep: nap,
        })
        assert.equal(calls, 1)
    })
})

describe('a cancelled cycle', () => {
    it('is not reported as the model refusing the document', async () => {
        // It was, and it cost the reporter their first pass: four lines of
        // "model could not extract" sent them looking for a bad PDF when the
        // model had never been asked anything.
        const controller = new AbortController()
        controller.abort()
        const out = await extractWithRetry({
            call: async () => ({ ok: true, data: {} }),
            signal: controller.signal, sleep: nap,
        })
        assert.equal(out.ok, false)
        assert.equal(out.aborted, true, 'an abort must be distinguishable from an answer')
        assert.equal(out.threw, false, 'and from a provider fault')
        assert.match(out.reason, /cancelled/)
    })

    it('reports an abort that arrives as a thrown provider error, without retrying it', async () => {
        // What actually happens in flight: the AbortSignal fires and the
        // provider call rejects with "This operation was aborted". Retrying
        // that is pure noise, and it is what the reporter saw — four
        // "attempt 1 failed, retrying: This operation was aborted" lines for
        // a cycle that had already been restarted.
        const controller = new AbortController()
        const retries = []
        let slept = 0
        let calls = 0
        const out = await extractWithRetry({
            call: async () => {
                calls++
                controller.abort()
                throw new Error('This operation was aborted')
            },
            signal: controller.signal, retries: 3,
            sleep: async () => { slept++ },
            onRetry: (info) => retries.push(info),
        })
        assert.equal(out.aborted, true)
        assert.equal(out.threw, false, 'a restart is not a provider fault')
        assert.equal(calls, 1, 'a cancelled cycle must not pay the provider again')
        assert.deepEqual(retries, [], 'and must not log a retry it is not going to make')
        assert.equal(slept, 0, 'nor back off before giving up')
    })
})

describe('the retry mechanics', () => {
    it('does not call again once the signal is aborted', async () => {
        let calls = 0
        const controller = new AbortController()
        const out = await extractWithRetry({
            call: async () => { calls++; controller.abort(); throw new Error('boom') },
            signal: controller.signal, retries: 5, sleep: nap,
        })
        assert.equal(calls, 1, 'an aborted build must stop paying the provider')
        assert.equal(out.ok, false)
    })

    it('reports each retry as it happens, for a log that shows the flake', async () => {
        const seen = []
        await extractWithRetry({
            call: flaky(2), sleep: nap,
            onRetry: (info) => seen.push(info),
        })
        assert.equal(seen.length, 2)
        assert.deepEqual(seen.map(s => s.attempt), [1, 2])
        assert.equal(seen[0].threw, true)
    })

    it('succeeds without sleeping when the first attempt works', async () => {
        let slept = 0
        const out = await extractWithRetry({
            call: async () => ({ ok: true, data: {} }),
            sleep: async () => { slept++ },
        })
        assert.equal(out.attempts, 1)
        assert.equal(slept, 0, 'the happy path must cost nothing')
    })

    it('backs off further each time, with jitter to spread a burst', async () => {
        // A cold rebuild starts every extraction at once, so un-jittered
        // backoff would resynchronise them into the same wall.
        const first = Array.from({ length: 40 }, () => backoffDelay(0))
        const second = Array.from({ length: 40 }, () => backoffDelay(1))
        assert.ok(Math.max(...first) <= 500, 'attempt 0 stays within its base')
        assert.ok(Math.min(...second) >= 500, 'attempt 1 waits longer than attempt 0 ever does')
        assert.ok(new Set(first).size > 1, 'jittered, not fixed')
    })

    it('defaults to two retries', async () => {
        assert.equal(DEFAULT_RETRIES, 2)
    })
})
