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

import { normalizeSteps, resolvePrompt, cacheKeyFor, resolveAttachments, LEGACY_STEP } from '../lib/steps.js'

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

describe('the `key` lever', () => {
    it('carries an explicit cache key through', () => {
        const [step] = normalizeSteps([{ name: 'notes', schema: A, prompt: 'long guidance', key: 'notes-v2' }])
        assert.equal(step.key, 'notes-v2')
    })

    it('stands in for the prompt in the cache identity', () => {
        // The wiring, not just the field: with a key, the ledger identity is
        // the key; without one it is the prompt text, so a reworded prompt
        // still invalidates by default.
        const [withKey] = normalizeSteps([{ name: 'n', schema: A, prompt: 'v1 guidance', key: 'notes-v2' }])
        assert.equal(cacheKeyFor(withKey, 'v1 guidance'), 'notes-v2')
        assert.equal(cacheKeyFor(withKey, 'totally reworded guidance'), 'notes-v2',
            'rewording must not invalidate once the author has taken control')

        const [noKey] = normalizeSteps([{ name: 'n', schema: A, prompt: 'v1 guidance' }])
        assert.equal(cacheKeyFor(noKey, 'v1 guidance'), 'v1 guidance')
        assert.equal(cacheKeyFor(noKey, 'reworded'), 'reworded', 'default stays prompt-sensitive')

        // A function of the entity and the prompt; nothing back, or a throw,
        // and the prompt is the question again.
        const [derived] = normalizeSteps([{ name: 'n', schema: A, prompt: 'p', key: (entity, prompt) => `${entity.meta.cards}|${prompt.length}` }])
        assert.equal(cacheKeyFor(derived, 'four', { meta: { cards: 'pores' } }), 'pores|4')
        const [empty] = normalizeSteps([{ name: 'n', schema: A, prompt: 'p', key: () => null }])
        assert.equal(cacheKeyFor(empty, 'the prompt', {}), 'the prompt')
        const [broken] = normalizeSteps([{ name: 'n', schema: A, prompt: 'p', key: () => { throw new Error('x') } }])
        assert.equal(cacheKeyFor(broken, 'the prompt', {}), 'the prompt')
    })

    it('is absent unless asked for, so the prompt stays the identity', () => {
        // Default must not change: a prompt edit invalidates, because a
        // prompt's effect is unbounded and cannot be checked against a
        // stored answer the way a schema can.
        assert.equal(normalizeSteps([{ name: 'n', schema: A, prompt: 'p' }])[0].key, undefined)
        assert.equal(normalizeSteps(A)[0].key, undefined)
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

// A question about more than the entity's own source: photographs beside a
// database record, crops of them. Reported from a skin-check pipeline that
// reads acne scars off the side-view photos of a scan whose source is JSON.
describe('attachments', () => {
    const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex')
    const entity = { id: '/r.json', meta: { photos: ['a', 'b'] } }

    it('carries `attach` through normalization, and refuses one that is not a function', () => {
        const attach = () => []
        const [step] = normalizeSteps([{ name: 'scars', schema: A, attach }])
        assert.equal(step.attach, attach)
        assert.throws(() => normalizeSteps([{ name: 'scars', schema: A, attach: 'photos/*.jpg' }],
            { patternForError: '/x/**' }), /`attach` that is not a function/)
    })

    it('is absent unless asked for, and then attaches nothing', async () => {
        const [step] = normalizeSteps([{ name: 'n', schema: A }])
        assert.equal(step.attach, undefined)
        assert.deepEqual(await resolveAttachments(step, entity), { attachments: [] })
    })

    it('derives the files from the entity, awaiting an async attach', async () => {
        const step = { attach: async (e) => e.meta.photos.map((name) => ({ data: JPEG, mediaType: 'image/jpeg', filename: name })) }
        const out = await resolveAttachments(step, entity)
        assert.deepEqual(out.attachments.map((f) => f.filename), ['a', 'b'])
    })

    it('skips quietly when the files are not ready', async () => {
        const out = await resolveAttachments({ attach: () => null }, entity)
        assert.match(out.skip, /not ready/)
        assert.equal(out.failed, undefined, 'waiting is not a failure')
    })

    it('reports a throw, and a malformed file, without killing the build', async () => {
        assert.ok((await resolveAttachments({ attach: () => { throw new Error('no frame') } }, entity)).failed)
        assert.match((await resolveAttachments({ attach: () => 'not an array' }, entity)).failed, /array/)
        assert.match((await resolveAttachments({ attach: () => [{ data: JPEG }] }, entity)).failed, /mediaType/)
        assert.match((await resolveAttachments({ attach: () => [{ data: 'path.jpg', mediaType: 'image/jpeg' }] }, entity)).failed, /bytes/)
    })
})

describe('whether the document is in the key', () => {
    // A `source: false` step is sent its prompt and nothing else, so the
    // file's bytes were only ever in its key by accident — and the accident
    // was about to re-ask three questions about 260 reports because the
    // clinic boxes re-sent every JSON with one more block nobody reads.
    const step = (over) => normalizeSteps([{ name: 'n', schema: A, ...over }], { patternForError: '/x/**' })[0]

    it('keeps it for every step that reads the document', () => {
        for (const spec of ['janus-report', A, { schema: A, prompt: 'p' }]) {
            assert.equal(normalizeSteps(spec)[0].sourceInKey, true)
        }
        assert.equal(step({}).sourceInKey, true)
    })

    it('drops it for a step asked only its prompt', () => {
        assert.equal(step({ source: false, prompt: 'p' }).sourceInKey, false)
    })

    it('keeps it when a `key` stands in for the prompt', () => {
        // The prompt built from the file's data no longer moves the
        // identity; the file is what still does.
        assert.equal(step({ source: false, key: 'v1' }).sourceInKey, true)
    })

    it('keeps it when files are attached', () => {
        // They are not in the key, and they may be chosen from the file.
        assert.equal(step({ source: false, attach: () => [] }).sourceInKey, true)
    })

    it('drops it when the author says the prompt identifies everything', () => {
        assert.equal(step({ source: false, attach: () => [], sourceInKey: false }).sourceInKey, false)
        assert.equal(step({ source: false, key: 'v1', sourceInKey: false }).sourceInKey, false)
    })

    it('keeps it when the author asks to, on a step that would drop it', () => {
        assert.equal(step({ source: false, sourceInKey: true }).sourceInKey, true)
    })

    it('refuses to drop it from a step that reads the document', () => {
        assert.throws(() => step({ sourceInKey: false }), /sends the document/)
    })

    it('refuses a value that is not true or false', () => {
        assert.throws(() => step({ source: false, sourceInKey: 'no' }), /not true or false/)
    })
})
