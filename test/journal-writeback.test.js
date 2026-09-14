// Why extraction is gathered, processed, then applied — in three passes.
//
// useJournal persists an entity by diffing it when the GENERATOR RESUMES,
// which is when the loop body for that entry completes. Run the bodies
// concurrently and the generator gets pulled forward before any of them
// has finished, so it diffs an entity nobody has touched yet and writes
// nothing.
//
// This is not a race that usually works. It is every mutation, lost, with
// the provider still billed for all of them — which is the worst possible
// shape for a plugin whose whole job is expensive calls.
//
// mikser-io-vector maps over the journal with p-map and is correct, because
// it writes to an external store and never touches `entity`. Copying that
// pattern into a plugin that mutates is the trap, so this test states the
// hazard rather than leaving the three-pass structure looking like taste.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import pMap from 'p-map'

// useJournal's exact structure: yield the entry, then on resume diff it
// against what it was and write back if it moved.
// (mikser-io/src/journal.js — "Yield returned — caller's for-body completed
// for this iteration. Diff and write back if mutated.")
function journal(count, persisted) {
    return (async function* () {
        for (let i = 0; i < count; i++) {
            const entry = { entity: { id: `/d/${i}.pdf`, meta: {} } }
            const original = JSON.stringify(entry.entity)
            yield entry
            if (JSON.stringify(entry.entity) !== original) persisted.push(entry.entity.id)
        }
    })()
}

const slowExtraction = async (entity) => {
    await new Promise(r => setTimeout(r, 10))
    entity.meta.extracted = true
}

describe('mutating entities inside a concurrent journal map', () => {
    it('loses every mutation above concurrency 1 — the reason for three passes', async () => {
        for (const concurrency of [2, 4]) {
            const persisted = []
            await pMap(journal(6, persisted), async ({ entity }) => slowExtraction(entity),
                { concurrency })
            assert.equal(persisted.length, 0,
                `concurrency ${concurrency} persisted ${persisted.length}/6 — if this now passes, `
                + 'the journal contract changed and ocr can go back to one pass')
        }
    })

    it('is safe serially, which is why this was invisible until concurrency', async () => {
        const persisted = []
        for await (const { entity } of journal(6, persisted)) await slowExtraction(entity)
        assert.equal(persisted.length, 6)
    })

    it('the three-pass shape persists everything at any concurrency', async () => {
        // Gather (no mutation) → work concurrently off the journal → apply
        // inside a fresh walk, where the write-back can see it.
        for (const concurrency of [1, 4, 8]) {
            const persisted = []
            const gathered = []
            for await (const { entity } of journal(6, persisted)) gathered.push(entity)
            assert.equal(persisted.length, 0, 'the gather pass must not write anything')

            const results = new Map()
            await pMap(gathered, async (entity) => {
                await new Promise(r => setTimeout(r, 10))
                results.set(entity.id, { extracted: true })
            }, { concurrency })

            for await (const { entity } of journal(6, persisted)) {
                const data = results.get(entity.id)
                if (data) entity.meta = { ...entity.meta, ...data }
            }
            assert.equal(persisted.length, 6,
                `concurrency ${concurrency} persisted ${persisted.length}/6`)
        }
    })
})
