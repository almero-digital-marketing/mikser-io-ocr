# mikser-io-ocr

Schema-driven OCR + structured-data extraction for [mikser-io](https://github.com/almero-digital-marketing/mikser-io). Drop a folder of PDFs / scanned images / plain-text docs into the catalog (via [documents](https://github.com/almero-digital-marketing/mikser-io), [mikser-io-provider-gdrive](https://github.com/almero-digital-marketing/mikser-io-provider-gdrive), or any other source); declare a [zod](https://zod.dev) schema describing what you want out of them; this plugin walks the catalog at `onProcess`, fires a multi-modal model call, and populates `entity.meta` with the validated structured data.

The "OCR" in the name is the operator-mental-model verb. The plugin actually does OCR-and-structure as one call via modern multi-modal models (OpenAI `gpt-4o-mini`, Anthropic Claude Sonnet, Google Gemini, etc., dispatched through the [Vercel AI SDK](https://sdk.vercel.ai)). Pure-text input works too — same dispatch, same schema-constrained output, no image step.

```
documents / files / drive entities arrive in the catalog
   │
   ▼
onProcess → for each new/updated entity:
   │
   ▼
match? — first glob in options.match against entity.id wins
   │
   ▼
resolveSchema(spec) — name string OR direct zod object
   │
   ▼
schema.safeParse(entity.meta) already passes? → skip (no LLM call)
   │
   ▼
readEntityContent(entity) — provider dispatch (fs / gdrive / ...)
   ├─ text  → { content }
   └─ binary → { contentSkipped, cachedAt: <path> } — provider mirrored the file
   │
   ▼
generateObject({ model, schema, messages }) — provider-agnostic via AI SDK
   │
   ▼
entity.meta = { ...entity.meta, ...result } — auto-persisted by the journal
```

## Install

```bash
npm install mikser-io-ocr ai @ai-sdk/openai zod
```

**The `ai` version and the provider package have to be the same generation.**
They are versioned separately and their `latest` tags move together, so mixing
them fails at the first call rather than at install:

```
UnsupportedModelVersionError: Unsupported model version v4 for provider
"anthropic.messages" ... AI SDK 5 only supports specification version "v2"
```

The command above is right when both resolve to `latest` (currently `ai@7` with
`@ai-sdk/*@4`). If you pin `ai` to an older major, pin the provider to the
matching dist-tag rather than `latest`:

| `ai` | provider packages |
|---|---|
| `ai@7` (latest) | `@ai-sdk/openai@latest` — the 4.x generation |
| `ai@6` | `npm install @ai-sdk/openai@ai-v6` — the 3.x generation |
| `ai@5` | `npm install @ai-sdk/openai@ai-v5` |

Peer dependencies — pick the provider package matching your model choice:

| Provider | Package |
|---|---|
| OpenAI | `@ai-sdk/openai` |
| Anthropic | `@ai-sdk/anthropic` |
| Google Gemini | `@ai-sdk/google` |
| Ollama / OpenAI-compatible | `@ai-sdk/openai-compatible` |
| Any other AI-SDK provider | the corresponding `@ai-sdk/<provider>` package |

The plugin doesn't care which one — it just calls `generateObject({ model: <whatever-you-passed> })`.

## Setting up a model provider (one-time)

### OpenAI (most common)

1. Sign up at https://platform.openai.com and add a payment method.
2. **API keys** → **Create new secret key**. Copy it — you only see it once.
3. Export the key:
   ```bash
   export OPENAI_API_KEY=sk-...
   ```
4. Pick a model. `gpt-4o-mini` is the right default for v1 — multi-modal (handles PDFs and images), schema-constrained output, ~10× cheaper than `gpt-4o`. Use `gpt-4o` if accuracy on hard scans matters more than cost.

### Anthropic

1. Sign up at https://console.anthropic.com, add a payment method.
2. **API Keys** → **Create Key**.
3. Export:
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```
4. Multi-modal models: `claude-3-5-sonnet-latest` (slower, higher quality), `claude-3-5-haiku-latest` (faster, cheaper).

### Local / offline (Ollama)

1. Install Ollama at https://ollama.com, pull a multi-modal model:
   ```bash
   ollama pull llama3.2-vision
   ```
2. No API key needed; Ollama serves on `localhost:11434`.

Vision capabilities on local models are weaker than the cloud providers; for production OCR-from-scan workflows, the hosted models are the realistic choice. Local makes sense for "extract from already-OCR'd text" or for dev iteration without burning quota.

## Configure

The plugin accepts schemas two ways. Pick whichever fits the rest of your project:

### Option 1 — schema by name (via mikser-io-schemas)

Drop your schemas into `schemas/<name>.js` and let [mikser-io-schemas](https://github.com/almero-digital-marketing/mikser-io-schemas) own the registry:

```js
// schemas/invoice.js
import { z } from 'zod'
export default z.object({
    vendor: z.string(),
    amount: z.number(),
    date:   z.string().datetime(),
    lineItems: z.array(z.object({
        description: z.string(),
        quantity:    z.number(),
        unitPrice:   z.number(),
    })).default([]),
})
```

```js
// mikser.config.js
import { documents, frontMatter } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
import { schemas } from 'mikser-io-schemas'
import { ocr }     from 'mikser-io-ocr'
import { openai }  from '@ai-sdk/openai'

export default {
    plugins: [
        documents(),
        frontMatter(),
        layouts(),
        schemas({                                  // MUST come before ocr()
            schemaKey: 'meta.layout',
        }),
        ocr({
            model: openai('gpt-4o-mini'),
            match: {
                '/documents/invoices/**/*.pdf': 'invoice',     // ← by NAME
                '/documents/receipts/**/*.png': 'receipt',
            },
        }),
    ],
}
```

Pros: schemas live in one canonical place; adding a new entity type means dropping `schemas/<name>.js` and using the name in `ocr({match: ...})`, [mikser-io-schemas](https://github.com/almero-digital-marketing/mikser-io-schemas) (validation + .d.ts gen), and any future consumer.

### Option 2 — schema by direct import

Skip the schemas plugin and import the zod object straight into the config:

```js
import { documents } from 'mikser-io'
import { ocr }       from 'mikser-io-ocr'
import { openai }    from '@ai-sdk/openai'
import { z }         from 'zod'

const invoiceSchema = z.object({
    vendor: z.string(),
    amount: z.number(),
    date:   z.string().datetime(),
})

export default {
    plugins: [
        documents(),
        ocr({
            model: openai('gpt-4o-mini'),
            match: {
                '/documents/invoices/**/*.pdf': invoiceSchema,   // ← by IMPORT
            },
        }),
    ],
}
```

Pros: no schemas folder; useful when the schema is computed or composed at config time (`z.discriminatedUnion([...])`, `baseSchema.extend({...})`).

Both modes work simultaneously in one `match` map — strings get resolved by name, objects pass through directly.

## How it decides whether to call the LLM

Three conditions; all must be true to fire:

1. **Glob match.** `entity.id` matches a pattern in `options.match`. First match wins (deterministic insertion-order).
2. **`safeParse` fails.** `schema.safeParse(entity.meta)` returns `success: false`. Already-validated entities don't burn tokens on re-runs.
3. **The ledger has no answer.** See below — this is the gate that survives a catalog wipe.
4. **Content available.** `readEntityContent(entity)` returns either `{ content: <text> }` or `{ cachedAt: <local path> }`. A local binary is read from `entity.uri`; anything genuinely unreadable is skipped **with a warning naming the entity, the pattern it matched and the reason**.

This means warm builds — second `mikser` run on the same Drive folder, no changes — call the LLM **zero times**. Only entities whose meta is incomplete relative to the schema get processed.

## The extraction ledger

Condition 2 is free and correct, and it holds exactly as long as the catalog
does. mikser wipes the catalog on any config change — the files are the source
of truth, the catalog is a derived cache — so without a ledger, editing a
comment in `mikser.config.js` sends every matched document back to the model.
At eight PDFs that is two minutes and a few cents; at a thousand documents it
is a thousand model calls because someone touched an unrelated line.

So a successful extraction is recorded in mikser's **durable store**
(`mikser.data.sqlite` in the working folder), which the cache wipe does not
touch. A document is read once per version of itself and never again.

**It is not written to `out/`,** deliberately: if your sources are customer
records and `out/` is served, anything derived from them carries the same
constraint. Keep `mikser.data.sqlite` out of source control and out of your
deploy's delete set.

Every distinct question keeps its **own** row: the key is
`(id, schema_hash, model, prompt_hash)`. So comparing two prompts is run A,
run B, compare, keep the better — and going back to A costs nothing, because
A's answers were never overwritten. `keep` (default 5) bounds how many
answers one document accumulates, dropping the oldest first.

A stored result is used only when **all** of these still match:

| What | Why |
| --- | --- |
| the document's content | `entity.checksum` — the hash mikser's import gate already computed, so this is exact and costs no extra read. Falls back to size + mtime when an entity arrives without one, and caches nothing at all when it can identify neither. |
| the schema | A different shape is a different question. |
| the model and provider | `openai:gpt-4o-mini` → `openai:gpt-4o` re-reads. |
| the effective prompt | Invisible from the source file, and it changes the answer. |

On by default. `ocr({ cache: false })` turns it off — the old behaviour, where
every catalog wipe re-reads everything.

## A sequence of questions about one entity

A match value may be an ordered list of **steps**, each with its own schema,
its own prompt and its own ledger row:

```js
ocr({
    model: MODEL(),
    match: {
        '/skincheck/Janus/**/*.pdf': [
            { name: 'report', schema: janusReport, prompt: JANUS_PROMPT },
            { name: 'notes', schema: findingNotes, source: false,
              prompt: (entity) => `${NOTES_PROMPT}
                  Измервания: ${JSON.stringify(entity.meta.measures)}
                  Находки: ${entity.meta.findings.join('\n')}` },
        ],
    },
})
```

Steps run **in order within one entity** — a later step reads what the
earlier ones left on `entity.meta` — while `concurrency` applies across
entities, which is where the independence actually is.

- **`prompt` may be a function of the entity.** A derived question is derived
  from something. A string prompt is resolved before any document is seen, so
  every match gets the same question; a function gets the entity with each
  earlier step's answer already merged.

- **`source: false`** asks about what earlier steps put on meta rather than
  about the document. Re-attaching a 4 MB PDF to ask about a hundred bytes of
  JSON already in hand pays for the whole thing twice.

- **`name` is the identity**, and is required in a sequence. It goes into the
  ledger key, so steps are numbered by name rather than by position —
  reordering the array must not discard paid-for answers. An unnamed step in
  a sequence is refused rather than guessed at.

**Steps that are not model calls stay in your pipeline.** This does not try
to absorb ordinary code. If deriving findings from measurements is code —
and it should be, if asking the model gave five findings one run and two the
next from identical input — keep it as a plugin between two `ocr()` phases.

**A step whose inputs are not ready skips quietly.** Return `null` from the
prompt function and the step is skipped at debug level, to be picked up on
the next cycle, exactly as an unsatisfied schema already is. A prompt
function that *throws* is reported as a warning instead: reading
`meta.findings.join()` before findings exists is the accidental way to say
"not ready", but it is also exactly what a typo looks like.

Each step caches on its own key, `(id, step, schema, model, prompt)`, over
the **resolved** prompt. So editing a late step's prompt re-runs that step
and leaves the expensive first reading alone — and `keep` is a budget *per
step*, so iterating on a cheap late question cannot age out the answer that
actually opened the PDF.

> The name stopped fitting once a match became a conversation. `extract` is
> exported as an alias of `ocr` — same implementation, better word. `ocr`
> is not going anywhere.

## Concurrency and retries

Four documents are extracted at once by default (`concurrency: 4`). The
per-document work is independent — a read, a provider call, a write — and at
~50s per report a thousand reports is ~14 hours serially, on a cold rebuild
that any config change triggers.

Four is meant to sit under a default provider tier rather than trip its rate
limit. Raise it when you know your budget; set `concurrency: 1` for strictly
serial extraction. A provider that does start refusing has `retries` with
jittered backoff in front of it.

Internally this is three passes — gather, extract concurrently, apply —
because mikser's journal persists an entity by diffing it when the loop body
for that entry completes. Mapping over the journal concurrently pulls the
next entry before any body has finished, so **every** mutation is silently
dropped (measured: 0 of 6 survived at concurrency 2). Extraction therefore
happens off the journal and is applied in a second walk.

`retries` (default 2) covers the failures that are not the document's fault.
Measured across a day of runs with an unchanged prompt and schema, a
*different* report failed on each run and every one succeeded when re-run
untouched. Two failure kinds, treated differently:

- a **thrown** provider or JSON error is transient — retried up to `retries`
  times with a jittered backoff;
- an **envelope** reporting `success: false` is the model deliberately saying
  it cannot read the document. That is an answer, not a fault, and an
  unreadable scan gives it every time at full price — so it is retried once
  at most, however high `retries` goes.

## When the model can't read the source

A strict schema is a trap: `generateObject` *forces* the model to return a value for every required field, so when the source is illegible, blank, the wrong kind of document, or corrupted, the model fabricates values to satisfy the schema — and the garbage lands on `entity.meta` looking like a real extraction. Nothing signals that anything went wrong.

So the plugin doesn't hand the model your bare schema. It wraps it in a success/error envelope:

```js
{ success: boolean, error: string | null, data: <your schema> | null }
```

and appends an instruction telling the model to set `success: false` with a reason in `error` (leaving `data` null) rather than guess. `data` is only required when `success` is true, so the failure branch needs no fabrication.

On a failed extraction the plugin **writes nothing** to `entity.meta` and logs a warning naming the entity, the pattern, and the model's reason:

```
ocr: /documents/invoices/blurry-scan.pdf — model could not extract (pattern /documents/invoices/**): the image is too low-resolution to read the line items
```

There's no separate error store. The entity simply stays unsatisfied — which [mikser-io-schemas](https://github.com/almero-digital-marketing/mikser-io-schemas) already surfaces as a pending/broken entity (e.g. the `mikser://schemas/pending` resource). One source of truth for "this didn't extract": the schema-validation surface you already have. A `success: true` result that somehow carries null data is treated as a failure too — a partial extraction never reaches the catalog.

The envelope and instruction are automatic; nothing to configure. Your `prompt` (plugin-level or per-match) still drives *what* to extract — the failure instruction is appended on top of it.

## Multi-modal input

The plugin auto-detects the source modality from what the provider's `read()` returned:

| `readEntityContent` result | Message shape sent to `generateObject` |
|---|---|
| `{ content: <utf8 text> }` | `[{ role: 'user', content: [{type:'text'}, {type:'text', text: source}] }]` |
| `{ cachedAt: <PDF path> }` | `[{ role: 'user', content: [{type:'text'}, {type:'file', data: <bytes>, mimeType: 'application/pdf'}] }]` |
| `{ cachedAt: <image path> }` (`.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`) | `[{ role: 'user', content: [{type:'text'}, {type:'image', image: <bytes>, mimeType}] }]` |

AI SDK normalizes these into provider-specific shapes (OpenAI `input_file` / `input_image`, Anthropic attachments, etc.).

## Options reference

```js
ocr({
    // Remember a successful extraction in the durable store, so a catalog
    // wipe does not send every document back to the model. Default true;
    // see "The extraction ledger" above.
    cache: true,

    // How many answers to keep per document before the oldest is dropped.
    // Default 5. Set 0 to keep every answer a document ever produced.
    keep: 5,

    // How many extractions to run at once. Default 4. Size it to your
    // provider's rate limit; 1 is strictly serial.
    concurrency: 4,

    // Attempts after the first when a call FAILS. Default 2. A thrown
    // provider/JSON error gets all of them; an envelope saying the model
    // cannot read the document gets one at most, however high this goes.
    retries: 2,

    // REQUIRED. AI SDK model factory result.
    //   openai('gpt-4o-mini')        — OpenAI
    //   anthropic('claude-3-5-sonnet-latest') — Anthropic
    //   google('gemini-1.5-flash')   — Google
    //   custom providers — anything matching AI SDK's LanguageModelV2 interface
    model: openai('gpt-4o-mini'),

    // REQUIRED. Glob → schema map. A match value is one of:
    //   - a string  → schema name, looked up via runtime.options.schemas.lookup
    //   - a zod object → used directly
    //   - { schema, prompt } → schema (string | zod) plus a per-pattern
    //                          prompt that overrides the plugin-level one
    // First glob that fires against the entity id wins (first-wins,
    // like mikser-io-layouts' autoLayouts).
    match: {
        '/documents/invoices/**/*.pdf': 'invoice',          // default prompt
        '/documents/contracts/**/*':    contractSchema,     // default prompt
        '/documents/receipts/**/*.jpg': {                   // per-pattern prompt
            schema: 'receipt',
            prompt: 'Extract line items. The summed items must equal the printed total.',
        },
    },

    // OPTIONAL. The default extraction prompt for every pattern that
    // doesn't set its own. Precedence: a per-match `prompt` (above) →
    // this plugin-level `prompt` → the built-in default ("Extract
    // structured data from this source matching the provided schema.
    // Use null for any field that is genuinely not present rather than
    // inferring from context.").
    prompt: 'Extract invoice data. Treat empty cells as null, not 0.',

    // OPTIONAL. Anything passed here is spread into the generateObject
    // call as-is. Use for: temperature, top_p, providerOptions, etc.
    generateObjectOptions: {
        temperature: 0,                          // deterministic
        providerOptions: {
            openai: { reasoningEffort: 'low' },
        },
    },
})
```

## End-to-end demo: PDF → CSV invoice round-trip

The format-liberation pitch in mikser's 9.0 plan: PDFs into the catalog, structured data extracted, rendered to a CSV the accountant can pull from a synced folder.

```js
// mikser.config.js
import { documents, frontMatter } from 'mikser-io'
import { providerGdrive } from 'mikser-io-provider-gdrive'
import { schemas }        from 'mikser-io-schemas'
import { ocr }            from 'mikser-io-ocr'
import { openai }         from '@ai-sdk/openai'

export default {
    plugins: [
        documents(),
        frontMatter(),

        // 1. Sync PDFs from a shared Drive folder
        providerGdrive({
            auth: { keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS },
            folders: [{
                folderId:   process.env.DRIVE_INVOICES_FOLDER,
                collection: 'documents',
                prefix:     '/drive/invoices/',
            }],
        }),

        // 2. Schemas folder owns the invoice shape
        schemas({ schemaKey: 'meta.layout' }),

        // 3. OCR extracts structured data per-entity
        ocr({
            model: openai('gpt-4o-mini'),
            match: {
                '/drive/invoices/**/*.pdf': 'invoice',
            },
        }),

        // 4. (later — mikser-io-render-csv when it ships) — aggregate
        //    entity.meta into a CSV file
    ],
}
```

Run:

```bash
export OPENAI_API_KEY=sk-...
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
export DRIVE_INVOICES_FOLDER=0Bz...
mikser --watch
```

What happens:
- Drive folder gets walked. 47 PDFs become entities with `uri = gdrive://<fileId>/q1-acme.pdf`.
- OCR's `onProcess` sees the new entities. Each PDF matches `'/drive/invoices/**/*.pdf'` → resolves `'invoice'` → `safeParse({}) fails` → `readEntityContent` (gdrive provider mirrors the binary to `runtime/gdrive-cache/<fileId>.pdf`) → `generateObject` with the PDF as a file block → meta populated.
- On the next watch tick: no changes → `safeParse` passes → zero LLM calls.
- Edit a PDF in Drive: change propagates via `drive.changes.list` → entity reappears in journal → `safeParse` fails (or just runs again) → LLM call → updated meta.

The catalog now holds 47 typed invoice entities. Query them via `mikser_query_entities` MCP tool, render them through a `render-csv` layout for the accountant, vectorize them via `mikser-io-vector` for "find invoices similar to this one" — every downstream plugin sees them as ordinary entities with valid meta.

## Troubleshooting

### `ocr: schema "invoice" not registered`

The plugin tried a name lookup but `schemas()` either isn't in `plugins[]` or it didn't load a file at `schemas/invoice.js`. Two fixes:

- Add `schemas({...})` to `plugins[]` **before** `ocr({...})` (factory call order matters because schemas plugin exposes the lookup surface at factory-eval time).
- Or pass the schema directly via import instead of by name.

### `ocr: no model configured`

`ocr({model: ...})` is required. Pass the result of an AI SDK provider call (`openai('gpt-4o-mini')`, etc.).

### `generateObject failed: Cannot find module '@ai-sdk/openai'`

You imported from `@ai-sdk/openai` in your config but didn't install the package. `npm install @ai-sdk/openai`.

### `generateObject failed: 401 Incorrect API key provided`

Provider authentication. Verify `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` is exported in the same shell that runs `mikser`.

### `generateObject failed: 429 Too Many Requests`

Provider rate-limited. Options:
- Drop to a smaller model (`gpt-4o` → `gpt-4o-mini`, `claude-3-5-sonnet` → `claude-3-5-haiku`) to reduce per-call cost and increase TPM headroom.
- Add `temperature: 0` and a tight prompt to reduce retry rate.
- Add an explicit pause between cycles via mikser's watch interval — only relevant during cold-start when many entities all need extraction at once.

### `ocr: <id> — model could not extract (pattern ...): <reason>`

The model reported it couldn't process the source (see [When the model can't read the source](#when-the-model-cant-read-the-source)). Nothing was written to `entity.meta`; the entity stays unsatisfied. The reason comes from the model — common causes:
- Scanned PDF too low-resolution for the vision model. Re-scan at higher DPI.
- Source is encrypted/password-protected. The provider can return it but the model can't parse it.
- Source is the wrong kind of document for the schema (a cover letter matched by an `invoices/**` glob). Tighten the match pattern.
- Source is in a language the model handles poorly. Try a stronger model (`gpt-4o`, `claude-3-5-sonnet`).

This is the *intended* path for a genuinely unreadable source — far better than the pre-1.2.0 behavior where the model fabricated values to satisfy the schema and the garbage looked like a real extraction.

### Same entity gets re-extracted on every cycle

`safeParse(entity.meta)` keeps failing — usually because:
- The schema has `z.string().datetime()` and the model returned a date in a slightly different format. Loosen to `z.string()` if exact-ISO isn't required, or `.refine(s => !!Date.parse(s))` for "any parseable date."
- A required field genuinely isn't extractable from the source. Make it optional in the schema or accept that this entity will keep getting re-processed each cycle.

The trace log line (`ocr: <id> already satisfies schema, skipping`) confirms safeParse passing; absence of it on subsequent runs means the schema is still rejecting whatever the model returned.

## What this plugin is NOT

- **A pipeline substrate over providers.** That's AI SDK's job. `ocr` just calls `generateObject`.
- **A schema registry.** Use [mikser-io-schemas](https://github.com/almero-digital-marketing/mikser-io-schemas) for the registry; ocr looks up by name OR accepts direct imports.
- **A source plugin.** Entities arrive via `documents` / `files` / `mikser-io-provider-gdrive` / etc. ocr is purely a consumer.
- **A real-time OCR endpoint.** It's lifecycle-driven (`onProcess`), runs once per cycle per changed entity. For interactive "extract from this image right now," call AI SDK's `generateObject` directly.

## License

MIT
