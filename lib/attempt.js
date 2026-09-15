// One extraction, retried when the failure looks transient.
//
// There was no retry anywhere in the plugin, and the failures are real.
// Reported from a day of runs against gpt-4o with an unchanged prompt and
// schema:
//
//   🔴 ocr: .../8309228240_130826.pdf — generateObject failed: Invalid JSON
//   🟡 ocr: .../8811225851_190826.pdf — model could not extract
//   🟡 ocr: .../0245316370_190826.pdf — model could not extract
//
// A DIFFERENT report failed on each run, and every one succeeded when re-run
// with nothing changed. So the failure is in the call, not in the document —
// and each one meant a customer-facing page rendered without its data until
// somebody noticed and touched the file.
//
// TWO KINDS OF FAILURE, treated differently, because they are not the same
// event wearing different clothes:
//
//   A THROW — a provider error, a timeout, `Invalid JSON` from a truncated
//   or malformed response. Nothing about the document caused it and nothing
//   about it will be true a second later. Retried up to `retries` times.
//
//   AN ENVELOPE saying `{ success: false }` — the model read the document
//   and is deliberately reporting that it cannot extract from it. That is an
//   ANSWER, not a fault, and it is the answer the envelope exists to make
//   possible. A genuinely unreadable scan will report the same thing every
//   time, at full price. So it gets one retry at most, never `retries` of
//   them: the observed flake is real, and so is the document that will never
//   parse.
//
// The delay is passed in so a test can run without sleeping. Jittered because
// a cold rebuild starts every one of these at once and un-jittered backoff
// would resynchronise them into the same wall the retry is meant to step
// around.

// Attempts after the first, for a thrown error.
export const DEFAULT_RETRIES = 2

// An envelope failure is the model's considered answer, so at most one more
// look regardless of how high `retries` goes.
const ENVELOPE_RETRIES = 1

export function backoffDelay(attempt, base = 500) {
    const exponential = base * (2 ** attempt)
    // Full jitter. The point is to spread a burst, not to be precise.
    return Math.round(exponential * (0.5 + Math.random() * 0.5))
}

/**
 * Run one extraction, retrying transient failures.
 *
 * `call()` resolves to { ok, data } | { ok: false, reason }, or throws.
 * Returns { ok, data } | { ok: false, reason, attempts, threw }.
 */
export async function extractWithRetry({
    call,
    retries = DEFAULT_RETRIES,
    signal,
    sleep = (ms) => new Promise(r => setTimeout(r, ms)),
    onRetry,
}) {
    const throwLimit = Math.max(0, retries)
    const envelopeLimit = Math.min(throwLimit, ENVELOPE_RETRIES)
    let attempt = 0
    let lastReason = 'no attempt was made'
    let lastThrew = false

    while (true) {
        // Flagged, not folded into the envelope branch. A cancelled cycle
        // never asked the model anything, and reporting it as "model could
        // not extract" sent the reporter looking for a bad PDF.
        if (signal?.aborted) {
            return { ok: false, reason: 'the cycle was cancelled', attempts: attempt, threw: false, aborted: true }
        }
        try {
            const outcome = await call(attempt)
            if (outcome?.ok) return { ...outcome, attempts: attempt + 1 }
            lastReason = outcome?.reason ?? 'the model reported failure'
            lastThrew = false
            if (attempt >= envelopeLimit) {
                return { ok: false, reason: lastReason, attempts: attempt + 1, threw: false }
            }
        } catch (err) {
            lastReason = err?.message ?? String(err)
            lastThrew = true
            // An abort surfaces as a thrown "This operation was aborted" from
            // the provider call, which is not a provider fault either.
            if (signal?.aborted) {
                return { ok: false, reason: 'the cycle was cancelled',
                    attempts: attempt + 1, threw: false, aborted: true }
            }
            if (attempt >= throwLimit) {
                return { ok: false, reason: lastReason, attempts: attempt + 1, threw: true }
            }
        }
        onRetry?.({ attempt: attempt + 1, reason: lastReason, threw: lastThrew })
        await sleep(backoffDelay(attempt))
        attempt++
    }
}
