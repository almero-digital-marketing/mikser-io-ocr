// Pure-logic tests for the dispatch helpers — no AI SDK, no real engine.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { pickMatch, resolveSchema } from '../lib/resolve.js'

// Stand-in for a real zod schema: any object exposing safeParse.
const fakeSchema = (name) => ({
    safeParse: () => ({ success: false }),
    __name: name,
})

describe('pickMatch', () => {
    it('returns the first matching pattern (predictable insertion order)', () => {
        const match = {
            '/blog/**':       fakeSchema('post'),
            '/blog/2026/**':  fakeSchema('post2026'),   // would also match but not reached
        }
        const result = pickMatch({ id: '/blog/2026/launch.md' }, match)
        assert.equal(result.pattern, '/blog/**')
        assert.equal(result.spec.__name, 'post')
    })

    it('returns null when no pattern matches', () => {
        const match = { '/docs/**': fakeSchema('docs') }
        assert.equal(pickMatch({ id: '/blog/hello.md' }, match), null)
    })

    it('returns null for null entity or null match', () => {
        assert.equal(pickMatch(null, { '/x/**': fakeSchema('x') }), null)
        assert.equal(pickMatch({ id: '/x' }, null), null)
    })

    it('returns null when entity has no id', () => {
        assert.equal(pickMatch({}, { '/x/**': fakeSchema('x') }), null)
    })

    it('supports a string spec (schema by name)', () => {
        const match = { '/invoices/**': 'invoice' }
        const result = pickMatch({ id: '/invoices/q1.pdf' }, match)
        assert.equal(result.spec, 'invoice')
    })
})

describe('resolveSchema', () => {
    it('passes through a zod-shaped object', () => {
        const schema = fakeSchema('post')
        assert.equal(resolveSchema(schema), schema)
    })

    it('resolves a string via schemasSurface.lookup', () => {
        const schema = fakeSchema('article')
        const surface = { lookup: (n) => (n === 'article' ? schema : undefined) }
        assert.equal(resolveSchema('article', { schemasSurface: surface }), schema)
    })

    it('throws when a string is passed but schemasSurface is missing', () => {
        assert.throws(
            () => resolveSchema('article', {}),
            /runtime\.options\.schemas is not exposed/,
        )
    })

    it('throws when a string is passed but the named schema is unknown', () => {
        const surface = { lookup: () => undefined }
        assert.throws(
            () => resolveSchema('article', { schemasSurface: surface }),
            /schema "article" not registered/,
        )
    })

    it('throws on null spec', () => {
        assert.throws(() => resolveSchema(null), /is null/)
    })

    it('throws on unexpected type (number, bool)', () => {
        assert.throws(() => resolveSchema(42), /must be a schema name \(string\) or a zod schema object/)
        assert.throws(() => resolveSchema(true), /must be a schema name \(string\) or a zod schema object/)
    })

    it('error message names the offending pattern when provided', () => {
        assert.throws(
            () => resolveSchema(null, { patternForError: '/invoices/**' }),
            /\/invoices\/\*\*/,
        )
    })
})
