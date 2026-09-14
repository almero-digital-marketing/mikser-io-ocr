// The upgrade from the 11.3.0 ledger.
//
// 11.3.0 shipped the table keyed on `id` alone, so installs in the wild
// have it and it holds answers that were paid for. 002 rebuilds the table
// with the composite key, because sqlite cannot alter a primary key — and
// a rebuild that loses rows would charge people for every document again,
// which is the exact cost the ledger exists to avoid.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import knexFactory from 'knex'

import { migrations } from '../lib/ledger.js'

const TABLE = 'mikser_ocr_extractions'
let dir, knex

before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ocr-migrate-'))
    knex = knexFactory({
        client: 'better-sqlite3',
        connection: { filename: path.join(dir, 'd.sqlite') },
        useNullAsDefault: true,
    })
})
after(async () => { await knex?.destroy(); await rm(dir, { recursive: true, force: true }) })

const row = (over = {}) => ({
    id: '/skincheck/8501054473.pdf',
    source: 'sum:abc',
    schema_hash: 'sh1',
    model: 'openai:gpt-4o-mini',
    prompt_hash: 'ph1',
    result: JSON.stringify({ patient: 'A. Ivanova' }),
    extracted_at: Date.now(),
    ...over,
})

describe('migrating a 11.3.0 ledger', () => {
    it('carries every existing answer across the rebuild', async () => {
        await migrations[0].up(knex)
        const before = [
            row(),
            row({ id: '/skincheck/other.pdf', result: JSON.stringify({ patient: 'B. Petrov' }) }),
        ]
        await knex(TABLE).insert(before)

        await migrations[1].up(knex)
        await migrations[2].up(knex)

        const after = await knex(TABLE).orderBy('id')
        assert.equal(after.length, 2, 'no answer may be lost in the rebuild')
        assert.deepEqual(after.map(r => r.id).sort(),
            ['/skincheck/8501054473.pdf', '/skincheck/other.pdf'])
        assert.equal(JSON.parse(after.find(r => r.id === '/skincheck/other.pdf').result).patient, 'B. Petrov')
        assert.deepEqual([...new Set(after.map(r => r.step))], [''],
            'rows from before sequences keep the empty step, so they stay reachable')
    })

    it('leaves a table that accepts two questions for one document', async () => {
        // The point of the whole migration.
        await knex(TABLE).insert(row({ step: '', prompt_hash: 'ph2', result: JSON.stringify({ patient: 'variant' }) }))
        const rows = await knex(TABLE).where({ id: '/skincheck/8501054473.pdf' })
        assert.equal(rows.length, 2)
    })

    it('still refuses a duplicate of the same document AND question', async () => {
        await assert.rejects(
            () => knex(TABLE).insert(row({ step: '', prompt_hash: 'ph2', extracted_at: Date.now() + 1 })),
            /UNIQUE|constraint/i,
            'the composite key must still be a key')
    })

    it('runs on an empty ledger without complaint', async () => {
        const fresh = knexFactory({
            client: 'better-sqlite3',
            connection: { filename: path.join(dir, 'empty.sqlite') },
            useNullAsDefault: true,
        })
        try {
            for (const migration of migrations) await migration.up(fresh)
            assert.deepEqual(await fresh(TABLE).select('*'), [])
        } finally { await fresh.destroy() }
    })
})
