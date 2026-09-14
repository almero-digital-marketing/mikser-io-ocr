// A match is a sequence of questions, not one reading.
//
// Reported from a pipeline that asks two today and will ask more: read the
// report (model, needs the PDF), derive the findings (CODE, deliberately —
// asking the model gave five findings one run and two the next from
// identical measurements), then explain each finding (model, needs only
// what step one extracted).
//
// Only the first was first-class. The rest got hand-rolled without retry,
// without concurrency, and with answers living in entity.meta — which the
// catalog wipe destroys on any config change, re-paying ninety seconds of
// sequential calls whenever anybody edited a comment.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'

import { normalizeSteps, resolvePrompt, LEGACY_STEP } from '../lib/steps.js'

const A = z.object({ a: z.string() })
const B = z.object({ b: z.string() })

describe('normalizeSteps', () => {
    it('treats every pre-sequence form as a sequence of one', () => {
        // The forms that already worked must keep working, and must keep the
        // empty step name so the ledger rows they wrote are still theirs.
        for (const spec of ['janus-report', A, { schema: A, prompt: 'p' }]) {
            const steps = normalizeSteps(spec)
            assert.equal(steps.length, 1)
            assert.equal(steps[0].name, LEGACY_STEP)
            assert.equal(steps[0].source, true, 'a single-value match still reads the document')
        }
    })

    it('carries a wrapper prompt through', () => {
        assert.equal(normalizeSteps({ schema: A, prompt: 'p' })[0].prompt, 'p')
    })

    it('reads an ordered sequence, keeping the order written', () => {
        const steps = normalizeSteps([
            { name: 'report', schema: A, prompt: 'read it' },
            { name: 'notes', schema: B, prompt: 'explain it', source: false },
        ])
        assert.deepEqual(steps.map(s => s.name), ['report', 'notes'])
        assert.equal(steps[0].source, true)
        assert.equal(steps[1].source, false, 'source: false must survive normalization')
    })

    it('refuses an unnamed step rather than numbering it', () => {
        // The name is the ledger key. Numbering by position would discard
        // every paid-for answer the first time the array is reordered.
        assert.throws(() => normalizeSteps([{ schema: A }], { patternForError: '/x/**' }),
            /has no `name`/)
    })

    it('refuses two steps with one name', () => {
        assert.throws(() => normalizeSteps([
            { name: 'dup', schema: A },
            { name: 'dup', schema: B },
        ]), /two steps named/)
    })

    it('refuses an empty sequence', () => {
        assert.throws(() => normalizeSteps([]), /empty array/)
    })
})

describe('resolvePrompt', () => {
    const entity = { id: '/x.pdf', meta: { findings: ['one', 'two'], measures: { n: 3 } } }

    it('passes a string prompt straight through', () => {
        assert.equal(resolvePrompt({ prompt: 'ask' }, entity).prompt, 'ask')
    })

    it('falls back to the plugin-level prompt', () => {
        assert.equal(resolvePrompt({}, entity, 'default').prompt, 'default')
    })

    it('derives a question from the entity', () => {
        // The whole point of step three: the question is built from what
        // step one extracted.
        const step = { prompt: (e) => `Находки: ${e.meta.findings.join(', ')}` }
        assert.equal(resolvePrompt(step, entity).prompt, 'Находки: one, two')
    })

    it('skips quietly when the prompt says the inputs are not ready', () => {
        const step = { prompt: (e) => e.meta.notYet ?? null }
        const out = resolvePrompt(step, entity)
        assert.match(out.skip, /not ready/)
        assert.equal(out.prompt, undefined)
        assert.equal(out.failed, undefined, 'waiting is not a failure')
    })

    it('reports a throwing prompt without killing the build', () => {
        // `entity.meta.findings.join()` before findings exists is the
        // ordinary way to express "not ready" by accident — and it is also
        // exactly what a typo looks like, so it is reported, not swallowed.
        const step = { prompt: (e) => e.meta.missing.join(',') }
        const out = resolvePrompt(step, { meta: {} })
        assert.ok(out.failed, 'a throw must come back as a reported failure')
        assert.equal(out.prompt, undefined)
    })

    it('stringifies a non-string return rather than passing an object on', () => {
        assert.equal(resolvePrompt({ prompt: () => 42 }, entity).prompt, '42')
    })
})
