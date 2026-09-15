// One upload must not become four reads of the same document.
//
// A WebDAV client writes a 4 MB PDF in chunks and each write is a change
// event, so one upload arrived as four CREATE rows for one file. The
// extraction pass walks journal ROWS, so with concurrency on it started
// four extractions of the same document at once — in parallel, before any
// of them could write the ledger row that would have stopped the others.
// Four full reads, all billed, all but one thrown away.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'

import { addPending } from '../index.js'

const MATCH = { '/skincheck/**/*.pdf': z.object({ patient: z.string() }) }
const gather = (entities, match = MATCH) => {
    const pending = new Map()
    for (const entity of entities) addPending(pending, entity, match)
    return [...pending.values()]
}

describe('gathering work from journal rows', () => {
    it('collapses repeated rows for one file into a single extraction', () => {
        const rows = ['a', 'b', 'c', 'd'].map(checksum =>
            ({ id: '/skincheck/report.pdf', meta: {}, checksum }))
        assert.equal(gather(rows).length, 1,
            'one document is one read, however many events it arrived as')
    })

    it('keeps the LAST row, which carries the latest state', () => {
        const kept = gather([
            { id: '/skincheck/x.pdf', checksum: 'first' },
            { id: '/skincheck/x.pdf', checksum: 'last' },
        ])
        assert.equal(kept[0].entity.checksum, 'last')
    })

    it('does not collapse different documents', () => {
        const kept = gather([
            { id: '/skincheck/a.pdf' },
            { id: '/skincheck/b.pdf' },
            { id: '/skincheck/a.pdf' },
        ])
        assert.deepEqual(kept.map(k => k.id).sort(), ['/skincheck/a.pdf', '/skincheck/b.pdf'])
    })

    it('ignores entities no pattern claims', () => {
        assert.equal(gather([{ id: '/documents/post.md' }]).length, 0)
    })

    it('carries the matched pattern through, since the step list hangs off it', () => {
        const [work] = gather([{ id: '/skincheck/report.pdf' }])
        assert.equal(work.hit.pattern, '/skincheck/**/*.pdf')
    })

    it('survives a journal entry with no entity', () => {
        // DELETE rows carry no entity; a walk must not throw on one.
        const pending = new Map()
        addPending(pending, undefined, MATCH)
        addPending(pending, null, MATCH)
        assert.equal(pending.size, 0)
    })
})
