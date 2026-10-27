// A provider error is not an answer, and it must not be the last word.
//
// An extraction that threw left no record anywhere. The entity was processed
// once, from the journal, and the journal only carries an entity again when
// its file changes or the catalog is wiped — so a document whose call failed
// stayed without an answer until somebody touched it.
//
// Reported 27.10.2026: the Anthropic account hit its monthly spend cap in the
// middle of a rebuild. 176 of 260 skin-check reports logged "You have reached
// your specified API usage limits". The cap was lifted and mikser restarted,
// and the restart journaled 19 entities and asked about the 2 new scans. The
// 176 stayed blank, on pages already sent to clients, with nothing in the log
// to say they were waiting for anything.
//
// So a thrown extraction is now RECORDED, in the durable store beside the
// ledger, and asked again later on its own — with a growing delay, because
// the outage that caused this lasts until the 1st of the month, and asking
// 176 documents every few minutes for three weeks is its own kind of fault.
//
// THREE KINDS OF ROW
//
//   retry     the call threw. Asked again at `retry_at`, which moves further
//             out with every failure: `first`, doubled each time, up to `max`.
//
//   declined  the model read the document and said it cannot extract. That is
//             its considered answer and is NOT retried — the behaviour before
//             this file existed. The row exists only so the startup sweep (see
//             lib/sweep.js) does not pay to ask the same question again on
//             every restart.
//
//   reimport  a retry succeeded, and the entity has to go through the whole
//             pipeline again — see `recordReimport`. The row is the promise
//             that it will, and it is cleared when the entity next arrives
//             from the journal.
//
// Keyed per document and per MATCH, not per document: one config can hold two
// ocr() calls over the same pattern asking different questions — the reported
// site does exactly that, one reading the photographs and one writing the
// summary — and one call's success must not clear the other's failure.

import { useDurableDatabase } from 'mikser-io'

const TABLE = 'mikser_ocr_requeue'

export const RETRY = 'retry'
export const DECLINED = 'declined'
export const REIMPORT = 'reimport'

// Appended to the ledger's migrations (lib/ledger.js), which are registered
// under one owner; defined here so the table and the code that reads it live
// in one file.
export const migration = {
    name: '004-requeue',
    up: async (knex) => {
        await knex.schema.createTable(TABLE, (table) => {
            table.text('id').notNullable()
            table.text('match_key').notNullable()
            table.text('kind').notNullable()
            // The step that failed, for the log and for whoever reads the
            // table. Not part of the key: a requeued entity runs its whole
            // sequence again, and the satisfied steps skip for free.
            table.text('step').notNullable().defaultTo('')
            // The document version the row is about. A changed file is a new
            // document, so its count of failures starts again.
            table.text('source')
            table.text('reason')
            table.integer('attempts').notNullable().defaultTo(0)
            table.bigInteger('updated_at').notNullable()
            table.bigInteger('retry_at')
            table.primary(['id', 'match_key'])
            table.index(['match_key', 'retry_at'])
        })
    },
}

// A minute, then doubling, never more than an hour apart.
//
// The first look is soon because most thrown errors are a rate window or a
// gateway that has recovered by then. The ceiling is what an outage costs: at
// an hour it is a couple of dozen attempts a day, each of which stops after a
// few refused calls (see createBreaker), and the readings come back within the
// hour of the provider doing so — immediately, on a restart.
export const DEFAULT_REQUEUE = { first: 60_000, max: 3_600_000 }

// `requeue: false` is the behaviour before any of this: nothing recorded,
// nothing asked again, no sweep. Anything else is the defaults, with whatever
// the config set over them. A malformed number falls back rather than
// stopping the build — the worst a bad value can do here is ask sooner or
// later than intended.
export function resolveRequeue(value) {
    if (value === false) return null
    const given = value !== null && typeof value === 'object' ? value : {}
    const first = positive(given.first) ?? DEFAULT_REQUEUE.first
    const max = Math.max(first, positive(given.max) ?? DEFAULT_REQUEUE.max)
    return { first, max }
}

function positive(value) {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : undefined
}

// How long to wait after the n-th failure in a row.
//
// Not jittered, unlike the backoff inside one call (lib/attempt.js). Jitter
// spreads a burst, and here the burst is the point: the documents that failed
// together are asked again together, in one pass, where the breaker can see
// that the provider is still refusing after a handful of them. Spread out,
// every one of them would be its own pass and its own refused call.
export function requeueDelay(attempts, { first, max } = DEFAULT_REQUEUE) {
    const n = Math.max(1, Math.trunc(Number(attempts)) || 1)
    // The exponent is clamped so a row that has failed for years does not
    // compute Infinity on its way to `max`.
    return Math.min(max, first * 2 ** Math.min(n - 1, 40))
}

// "in 4m", for a log line a person reads.
export function describeDelay(ms) {
    if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
    if (ms < 86_400_000) return `${+(ms / 3_600_000).toFixed(1)}h`
    return `${+(ms / 86_400_000).toFixed(1)}d`
}

// Which ocr() call a row belongs to: the pattern, plus the names of the steps
// it asks. Two calls over the same pattern differ in their steps — names are
// already identities (lib/steps.js) — and a single-value match has none, so
// its key is the pattern as written.
export function matchKey(pattern, steps = []) {
    const names = steps.map(step => step?.name).filter(Boolean)
    return names.length ? `${pattern}#${names.join(',')}` : pattern
}

// Every row this ocr() call owns, by document id. Read once per pass.
export async function readRequeue(keys) {
    const knex = useDurableDatabase()
    if (!knex || !keys?.length) return new Map()
    try {
        const rows = await knex(TABLE).whereIn('match_key', keys)
        return new Map(rows.map(row => [row.id, row]))
    } catch {
        // A table that cannot be read must never stop a build — the worst
        // case is the behaviour that existed before it.
        return new Map()
    }
}

export function isDue(row, now = Date.now()) {
    if (!row || (row.kind !== RETRY && row.kind !== REIMPORT)) return false
    return row.retry_at != null && Number(row.retry_at) <= now
}

// When this ocr() call next has something to ask, or null.
export async function nextRetryAt(keys) {
    const knex = useDurableDatabase()
    if (!knex || !keys?.length) return null
    try {
        const [row] = await knex(TABLE)
            .whereIn('match_key', keys)
            .whereIn('kind', [RETRY, REIMPORT])
            .min({ at: 'retry_at' })
        return row?.at == null ? null : Number(row.at)
    } catch {
        return null
    }
}

// The call threw. Returns { attempts, delay, retryAt }, or null when nothing
// could be written.
export async function recordRetry({ id, key, keys, step, source, reason, previous }, policy, now = Date.now()) {
    const same = previous?.kind === RETRY && (previous.source ?? null) === (source ?? null)
    const attempts = (same ? Number(previous.attempts) || 0 : 0) + 1
    const delay = requeueDelay(attempts, policy)
    const written = await write({
        id, match_key: key, kind: RETRY, step, source, reason,
        attempts, updated_at: now, retry_at: now + delay,
    }, keys)
    return written ? { attempts, delay, retryAt: now + delay } : null
}

// The model's considered "cannot extract". Never asked again on a timer.
export async function recordDeclined({ id, key, keys, step, source, reason }, now = Date.now()) {
    return write({
        id, match_key: key, kind: DECLINED, step, source, reason,
        attempts: 1, updated_at: now, retry_at: null,
    }, keys)
}

// A retry succeeded and the entity is being sent back through its source.
//
// `retry_at` is a fallback, not the plan: the re-import is asked for as soon
// as the cycle ends. The row stays due in case it never lands — a process
// stopped in between, a source that refused the file — and then the next pass
// finds the answer in the ledger and asks for the re-import again, on a
// growing delay so a source that will never take the file is not asked every
// minute for ever.
export async function recordReimport({ id, key, keys, step, source, previous }, policy, now = Date.now()) {
    const attempts = (previous?.kind === REIMPORT ? Number(previous.attempts) || 0 : 0) + 1
    return write({
        id, match_key: key, kind: REIMPORT, step, source,
        reason: 'answered on a later attempt; waiting for the source to re-import it',
        attempts, updated_at: now, retry_at: now + requeueDelay(attempts, policy),
    }, keys)
}

// Make documents due now. The startup sweep's queue — durable, so a cycle
// cancelled before it reaches them does not lose them.
//
// A row that was already backing off keeps its kind and its count: a restart
// asks now, but it does not pretend the provider has never failed.
export async function queueNow(entries, keys, now = Date.now()) {
    let written = 0
    for (const { id, key, step, source, previous } of entries) {
        const kind = previous?.kind === REIMPORT ? REIMPORT : RETRY
        const same = previous?.kind === kind && (previous.source ?? null) === (source ?? null)
        const ok = await write({
            id, match_key: key, kind, step, source,
            reason: same ? previous.reason : 'no answer was found at startup',
            attempts: same ? Number(previous.attempts) || 0 : 0,
            updated_at: now, retry_at: now,
        }, keys)
        if (ok) written++
    }
    return written
}

// Nothing is owed for this document any more.
export async function clearRequeue(id, keys) {
    const knex = useDurableDatabase()
    if (!knex || !keys?.length) return false
    try {
        await knex(TABLE).where({ id }).whereIn('match_key', keys).del()
        return true
    } catch {
        return false
    }
}

// One row per document per ocr() call. Rows under this call's OTHER keys are
// dropped first — the entity moved to another of its patterns when the config
// changed, and two rows would ask twice.
async function write(row, keys) {
    const knex = useDurableDatabase()
    if (!knex) return false
    try {
        const others = (keys ?? []).filter(key => key !== row.match_key)
        if (others.length) await knex(TABLE).where({ id: row.id }).whereIn('match_key', others).del()
        await knex(TABLE)
            .insert({ ...row, step: row.step ?? '', source: row.source ?? null, reason: row.reason ?? null })
            .onConflict(['id', 'match_key']).merge()
        return true
    } catch {
        return false
    }
}

// After this many thrown failures in a row, a pass stops asking.
//
// The retry brings back every document that failed together, and the spend
// cap that caused this refused all 176 of them identically — three attempts
// each, every one rejected. Asking the rest once the first few have been
// refused the same way buys nothing but the refusals. So a pass that sees
// three in a row with no answer between them leaves the rest unasked and
// files them under the same backoff; one answer closes it again, because a
// provider that answered is evidently answering.
//
// Three rather than one: a single document can throw for reasons of its own
// (a response that would not parse), and three in a row with nothing between
// them is not that.
export const TRIP_AFTER = 3

export function createBreaker(tripAfter = TRIP_AFTER) {
    let run = 0
    let reason = null
    let skipped = 0
    return {
        get open() { return reason !== null },
        get reason() { return reason },
        get skipped() { return skipped },
        // True only on the failure that opened it, so the caller says so once.
        failed(why) {
            run++
            if (reason === null && run >= tripAfter) {
                reason = why
                return true
            }
            return false
        },
        answered() {
            run = 0
            reason = null
        },
        skip() { skipped++ },
    }
}
