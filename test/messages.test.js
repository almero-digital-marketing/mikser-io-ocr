// The binary path, asserted against the AI SDK itself rather than by eye.
//
// `lib/messages.js` built its file part with `mimeType`, the AI SDK 4 field
// name. It was renamed to `mediaType` in SDK 5 — and this package declared
// support for 5 and 6. So the binary path had never worked on any version it
// claimed: every PDF failed, and the error pointed at the document rather
// than at the code.
//
// There was no test that sent a binary at all. A shape assertion alone would
// be worth little, so the PDF case feeds the built message to a real
// generateObject with a mock model: if the SDK would refuse the prompt,
// the test fails the same way production did.
//
// That round-trip does NOT work for images, and the reason is worth knowing:
// the SDK sniffs magic bytes, so a PNG comes back `mediaType: image/png`
// whatever we put on the part — even the old broken `image` + `mimeType`
// shape. Sniffing is what let the image branch degrade in silence. The
// image case is therefore asserted on the message we build.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { generateObject } from 'ai'

import { buildMessages } from '../lib/messages.js'

// The smallest thing that is recognisably a PDF — enough that `mimeFor` sees
// a .pdf and the bytes are real, without carrying a binary fixture in git.
const PDF = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
    + '2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

async function withCached(name, bytes, fn) {
    const dir = await mkdtemp(path.join(tmpdir(), 'ocr-messages-'))
    try {
        const cachedAt = path.join(dir, name)
        await writeFile(cachedAt, bytes)
        return await fn(cachedAt)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

// Hand the message to the SDK and report the binary part as the model would
// receive it. The mock class name tracks the major, so pick whichever exists.
async function throughTheSdk(messages) {
    const aiTest = await import('ai/test')
    const Mock = aiTest.MockLanguageModelV4 ?? aiTest.MockLanguageModelV3 ?? aiTest.MockLanguageModelV2
    let prompt = null
    const model = new Mock({
        doGenerate: async (options) => {
            prompt = options.prompt
            return {
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                content: [{ type: 'text', text: '{"ok":true}' }],
                warnings: [],
            }
        },
    })
    await generateObject({ model, schema: z.object({ ok: z.boolean() }), messages })
    return prompt?.[0]?.content?.find(part => part.type === 'file')
}

function binaryPart(messages) {
    assert.equal(messages.length, 1, 'the binary path builds one user message')
    return messages[0].content.at(-1)
}

describe('the binary path builds a part the AI SDK accepts', () => {
    it('sends a PDF the SDK does not refuse, as application/pdf', async () => {
        await withCached('report.pdf', PDF, async (cachedAt) => {
            const messages = await buildMessages({
                entity: { id: '/files/report.pdf' },
                contentResult: { cachedAt },
                prompt: 'extract',
            })
            // The call that used to throw InvalidPromptError on ai@5, 6 and 7
            // alike. Nothing is sniffable here, so the mediaType is ours.
            const part = await throughTheSdk(messages)
            assert.ok(part, 'the binary never reached the model')
            assert.equal(part.mediaType, 'application/pdf',
                `wrong or missing mediaType: ${JSON.stringify(part)}`)
        })
    })

    it('names the file, since the provider shows it to the model', async () => {
        await withCached('0245316370_190826.pdf', PDF, async (cachedAt) => {
            const messages = await buildMessages({
                entity: { id: '/files/0245316370_190826.pdf' },
                contentResult: { cachedAt },
            })
            assert.equal(binaryPart(messages).filename, '0245316370_190826.pdf')
        })
    })

    it('sends an image as a file part too, keeping its specific type', async () => {
        // Not a round-trip: see the header. An `image` part with `mimeType`
        // was never refused, it was accepted with the declared type discarded,
        // so a JPEG travelled as whatever the sniffer made of it. ai@7
        // deprecates the `image` part outright in favour of a file part with
        // an image/* mediaType, which is the one shape 5, 6 and 7 all take.
        await withCached('scan.png', PNG, async (cachedAt) => {
            const messages = await buildMessages({
                entity: { id: '/files/scan.png' },
                contentResult: { cachedAt },
            })
            const part = binaryPart(messages)
            assert.equal(part.type, 'file', 'images go as file parts, not image parts')
            assert.equal(part.mediaType, 'image/png')
            assert.ok(Buffer.isBuffer(part.data), 'a file part carries `data`')
        })
    })

    it('never builds a part carrying the SDK 4 field name', async () => {
        // Cheap, and it is the rename itself. The next one will not announce
        // itself either.
        await withCached('report.pdf', PDF, async (cachedAt) => {
            const messages = await buildMessages({
                entity: { id: '/files/report.pdf' },
                contentResult: { cachedAt },
            })
            for (const part of messages[0].content) {
                assert.ok(!('mimeType' in part),
                    `mimeType is an AI SDK 4 field: ${JSON.stringify(part)}`)
            }
        })
    })
})
