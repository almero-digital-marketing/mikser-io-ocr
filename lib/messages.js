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
// The AI SDK normalizes provider-specific block shapes — what we hand
// it as `{ type: 'file', data: <Buffer>, mimeType: '...' }` becomes
// `input_file` for OpenAI, an attachment for Anthropic, etc.

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

        if (mime?.startsWith('image/')) {
            return [{
                role: 'user',
                content: [
                    { type: 'text', text: userPrompt },
                    { type: 'image', image: bytes, mimeType: mime },
                ],
            }]
        }

        // Default: ship as a generic file block. AI SDK routes this to
        // input_file / attachment depending on provider. PDFs land here.
        return [{
            role: 'user',
            content: [
                { type: 'text', text: userPrompt },
                { type: 'file', data: bytes, mimeType: mime ?? 'application/octet-stream' },
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
