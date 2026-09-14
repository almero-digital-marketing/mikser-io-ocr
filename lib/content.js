// Turning whatever the engine hands back into something buildMessages can
// use — and saying so out loud when it cannot.
//
// readEntityContent has four answers, and ocr understood one and a half:
//
//   { content }        text, ready to go
//   { cachedAt }       a provider mirrored a binary to disk
//   { contentSkipped } the bytes are local and binary; read entity.uri
//   { contentError }   it failed, with a reason
//
// `contentSkipped` was the gap. A PDF catalogued with sources() — which is
// how you catalogue a file that must NOT be copied into out/, since out/ is
// served — produced exactly that, buildMessages returned null, and the skip
// was logged at trace. Reported as: eight reports, OCR pass finished in
// 11 ms, every page rendered empty, build green. A pass that does nothing
// and reports success is the worst of the failure modes.
//
// The reason core gives is a good one — the bytes are binary, read the file
// directly at entity.uri — and ocr threw it away. It is a local path, and a
// path on disk is all the binary branch needs, so this reads it instead of
// skipping.
//
// The other half is `content: true` on a binary source. The bytes go
// through `bytes.toString('utf8')` before ocr ever sees them, so what
// arrives is a 4 MB string of mangled PDF and the text branch ships it as a
// prompt. The provider answers "Your input exceeds the context window of
// this model" — an error naming the document, so the reader goes and looks
// at the PDF rather than at the config. Lossy decoding leaves U+FFFD
// behind, which is the evidence that the string was never text; when the
// file is still on disk we go back to the bytes.

import { readFile } from 'node:fs/promises'
import { isLocalUri, looksTextual } from 'mikser-io'

// A decoded-binary tell. U+FFFD is what `toString('utf8')` leaves where a
// byte sequence was not valid UTF-8, and a NUL does not belong in text a
// model is meant to read. Either is enough to go back to the bytes — a
// document that genuinely contains a replacement character still reads as
// text, and the disk check below is what decides the outcome.
export function looksDecodedBinary(content) {
    return typeof content === 'string' && /[\uFFFD\u0000]/.test(content)
}

// Returns { content } | { cachedAt } | { skipped: <reason> }.
//
// `cachedAt` is the binary branch's input and it is just a path, so a local
// source file serves the same purpose as a provider's mirror.
export async function resolveContent(entity, contentResult) {
    if (contentResult?.cachedAt) return { cachedAt: contentResult.cachedAt }

    const local = entity?.uri && isLocalUri(entity.uri)

    // Text in hand — unless it is mangled binary and the real bytes are
    // still reachable.
    if (typeof contentResult?.content === 'string') {
        if (!looksDecodedBinary(contentResult.content)) return { content: contentResult.content }
        if (!local) {
            return { skipped: 'content decoded as UTF-8 but the bytes are binary, and the source is not a '
                + 'local file — set `content: false` on the source so the bytes are not decoded' }
        }
        return await fromDisk(entity.uri, 'content decoded as UTF-8 but the bytes are binary')
    }

    // Core already looked, found binary, and said where the bytes are.
    if (contentResult?.contentSkipped) {
        if (!local) return { skipped: contentResult.contentSkipped }
        return await fromDisk(entity.uri, contentResult.contentSkipped)
    }

    if (contentResult?.contentError) return { skipped: contentResult.contentError }
    return { skipped: 'no content, and no local source uri to read it from' }
}

async function fromDisk(uri, why) {
    try {
        // Confirm it really is binary before handing a path to the binary
        // branch. A text file arriving here means the tell above misfired,
        // and shipping text as a file part would be the wrong shape.
        const bytes = await readFile(uri)
        if (looksTextual(bytes.subarray(0, 512))) return { content: bytes.toString('utf8') }
        return { cachedAt: uri }
    } catch (err) {
        return { skipped: `${why}, and re-reading ${uri} failed: ${err.message}` }
    }
}
