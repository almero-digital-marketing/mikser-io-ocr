// The two shapes a sources() entity arrives in, both of which ended the
// OCR pass in silence.
//
// Reported from a real build: customer PDFs catalogued with sources()
// because out/ is served by express.static and the files must not be
// copied there. Neither setting of that collection worked —
// `content: true` shipped 4 MB of decoded PDF as a prompt and the
// provider answered "exceeds the context window"; `content: false` was
// skipped at trace level, so eight reports finished in 11 ms with every
// page empty and the build green.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { resolveContent, looksDecodedBinary } from '../lib/content.js'

const PDF = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n'),
    // real binary: a stream of bytes that is not valid UTF-8
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
    Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
])

async function withFile(name, bytes, fn) {
    const dir = await mkdtemp(path.join(tmpdir(), 'ocr-content-'))
    try { 
        const file = path.join(dir, name)
        await writeFile(file, bytes)
        return await fn(file)
    } finally { await rm(dir, { recursive: true, force: true }) }
}

describe('resolveContent', () => {
    it('reads a local binary core declined to decode (content: false)', async () => {
        // The silent-skip case. Core returns contentSkipped with a reason
        // and a pointer to entity.uri; ocr used to discard both.
        await withFile('report.pdf', PDF, async (file) => {
            const got = await resolveContent({ id: '/skincheck/report.pdf', uri: file },
                { contentSkipped: 'Not text (.pdf) — the bytes are binary' })
            assert.equal(got.cachedAt, file, 'the local path IS the binary branch input')
            assert.equal(got.skipped, undefined)
        })
    })

    it('goes back to the bytes when content: true already mangled them', async () => {
        // The context-window case. The source decoded the PDF with
        // toString('utf8') before ocr saw it, leaving U+FFFD behind.
        await withFile('report.pdf', PDF, async (file) => {
            const mangled = PDF.toString('utf8')
            assert.ok(looksDecodedBinary(mangled), 'precondition: decoding left the tell')
            const got = await resolveContent({ id: '/skincheck/report.pdf', uri: file },
                { content: mangled })
            assert.equal(got.cachedAt, file, 'must not ship mangled bytes as a prompt')
            assert.equal(got.content, undefined)
        })
    })

    it('leaves real text alone', async () => {
        await withFile('note.md', Buffer.from('# Heading\n\nBody text.\n'), async (file) => {
            const got = await resolveContent({ id: '/documents/note.md', uri: file },
                { content: '# Heading\n\nBody text.\n' })
            assert.equal(got.content, '# Heading\n\nBody text.\n')
            assert.equal(got.cachedAt, undefined)
        })
    })

    it('keeps a provider mirror ahead of anything local', async () => {
        // gdrive/notion/s3 already mirrored the bytes; that path is the
        // authority and must not be second-guessed by a uri that happens
        // to look local.
        await withFile('cached.pdf', PDF, async (file) => {
            const got = await resolveContent({ id: '/drive/x.pdf', uri: 'gdrive://abc' },
                { cachedAt: file })
            assert.equal(got.cachedAt, file)
        })
    })

    it('explains itself when the source is remote and undecodable', async () => {
        const got = await resolveContent({ id: '/notion/x', uri: 'notion://abc' },
            { content: 'bad�bytes' })
        assert.match(got.skipped, /content: false/, 'names the setting that fixes it')
    })

    it('reports a read failure instead of skipping quietly', async () => {
        const got = await resolveContent({ id: '/x/gone.pdf', uri: '/nonexistent/gone.pdf' },
            { contentSkipped: 'Not text (.pdf)' })
        assert.match(got.skipped, /ENOENT|no such file/i)
    })

    it('passes a contentError through with its reason', async () => {
        const got = await resolveContent({ id: '/x/y', uri: 'file:///x/y' },
            { contentError: 'permission denied' })
        assert.equal(got.skipped, 'permission denied')
    })

    it('does not call a text file binary just because it came off disk', async () => {
        // The tell can misfire; the disk read is what decides. A text file
        // arriving here must come back as text, not as a file part.
        await withFile('notes.txt', Buffer.from('plain text, no funny bytes\n'), async (file) => {
            const got = await resolveContent({ id: '/x/notes.txt', uri: file },
                { contentSkipped: 'Not text' })
            assert.match(got.content, /plain text/)
            assert.equal(got.cachedAt, undefined)
        })
    })
})
