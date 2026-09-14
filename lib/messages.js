// Build multi-modal messages for AI SDK's generateObject from an
// entity + the result of readEntityContent. Three input families:
//
//   - Text content already in hand (entity.content set, or fs / gdrive
//     text fetch returned { content }). One text block carrying both
//     the extraction prompt and the source body.
//   - Binary cached on disk (gdrive/notion/s3 mirrored a PDF/image to
//     runtime/<provider>-cache/<file>). Read the bytes, encode as
//     base64, ship as `file` / `image` content block per the OpenAI
//     Responses-style multi-modal shape AI SDK exposes.
//   - Nothing extractable. Returns null; caller skips the entity.
//
// The AI SDK normalizes provider-specific block shapes — what we hand it as
// `{ type: 'file', data: <Buffer>, mediaType: '...' }` becomes `input_file`
// for OpenAI, an attachment for Anthropic, etc.
//
// `mediaType`, and it matters: the field was `mimeType` in AI SDK 4 and this
// package never updated it, while declaring support for 5 and 6. Measured
// against the real SDK on every major it claims plus the current one:
//
//   ai@5  file + mimeType  -> InvalidPromptError
//   ai@6  file + mimeType  -> InvalidPromptError
//   ai@7  file + mimeType  -> InvalidPromptError
//
// So the binary path had never worked on any supported version. `mediaType`
// is REQUIRED on a FilePart, so the old shape both passed an unknown key and
// omitted a required one.
//
// Everything goes as a `file` part, images included. An `image` part with
// `mimeType` was not rejected — it was accepted with the type thrown away
// (`mediaType=image/*` on 6, `image` on 7), so a JPEG travelled as a generic
// image and nothing said so. ai@7 deprecates the `image` part outright in
// favour of a file part with an `image/*` mediaType, and that shape is
// accepted by 5, 6 and 7 alike.

import { readFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_PROMPT = 'Extract structured data from this source matching the provided schema. Use null for any field that is genuinely not present rather than inferring from context.'

const IMAGE_EXT_TO_MIME = {
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
}

export async function buildMessages({ entity, contentResult, prompt, extraInstruction }) {
    const base = prompt ?? DEFAULT_PROMPT
    const userPrompt = extraInstruction ? `${base}\n\n${extraInstruction}` : base

    // Text path — content is in hand.
    if (typeof contentResult?.content === 'string') {
        return [{
            role: 'user',
            content: [
                { type: 'text', text: userPrompt },
                { type: 'text', text: `--- Source content ---\n${contentResult.content}` },
            ],
        }]
    }

    // Binary path — provider mirrored to a local cache file.
    if (contentResult?.cachedAt) {
        const bytes = await readFile(contentResult.cachedAt)
        const mime = mimeFor(entity, contentResult.cachedAt)

        // One shape for every binary. The SDK routes a file part to
        // input_file / attachment / image per provider, reading the
        // mediaType — so an image needs no branch of its own, and taking one
        // would mean using a part type ai@7 has deprecated.
        return [{
            role: 'user',
            content: [
                { type: 'text', text: userPrompt },
                {
                    type: 'file',
                    data: bytes,
                    mediaType: mime ?? 'application/octet-stream',
                    // Providers surface this to the model, and a report named
                    // `0245316370_190826.pdf` says more about what it is than
                    // `file` does.
                    filename: path.basename(contentResult.cachedAt),
                },
            ],
        }]
    }

    return null
}

function mimeFor(entity, cachePath) {
    if (entity?.meta?.driveMimeType && !entity.meta.driveMimeType.startsWith('application/vnd.google-apps.')) {
        return entity.meta.driveMimeType
    }
    const ext = path.extname(cachePath).toLowerCase()
    if (ext === '.pdf')  return 'application/pdf'
    if (IMAGE_EXT_TO_MIME[ext]) return IMAGE_EXT_TO_MIME[ext]
    return null
}
