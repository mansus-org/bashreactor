# Ingest URLs into a file of embeddings

Give the pipeline some URLs. It reads each page, splits the text into overlapping word windows, embeds
every window and writes one JSONL file. Whatever comes next (a vector database, an agent that saves
chunks into a memory tool) reads that file. Nothing here searches, and nothing here is a database.

```
urls ─> fetch-pages ─> chunk-pages ─> embed-chunks ─> embeddings (JSONL) + manifest (JSON)
```

It grew out of the throwaway test in [`docs/verification/`](../../docs/VERIFICATION-2026-11-06.md) and
keeps what that test found good: the work directory carries cached vectors across a retry (SPEC 4.1),
a permanent failure exits 78 and a dead network exits 75 (SPEC 2.8).

## Run it

You need `bun`, `uv`, `bash` 5, `curl`, `jq` (SPEC 2.6), and a Python 3.10 or newer that uv can run.
The blocks use the standard library only, so on Alpine uv fetches a musl Python on first use and no
wheel is involved.

The key is read from the **server's** environment, never from an input, because inputs are written to
`run.json`. Start the server with it set, then start a run from another shell:

```bash
export EMBEDDINGS_API_KEY=...            # empty is fine for a route that needs no key
bash examples/serve.sh                   # prints the URL and token it listens with

export BASHREACTOR_URL=http://127.0.0.1:8080 BASHREACTOR_TOKEN=br_demo_admin
bun apps/cli/src/bin.ts runs start examples/ingest/ingest-urls.yaml --wait \
  --input $'urls=https://www.rfc-editor.org/rfc/rfc2119.txt\nhttps://www.gnu.org/philosophy/free-sw.html'
```

The files are in the run directory, under `steps/embed/attempts/<n>/outputs/`, and `runs get <id>`
prints their paths as the run's `embeddings` and `manifest` outputs.

If the variable is unset the server refuses the run before it creates anything: `env_missing`, naming
`EMBEDDINGS_API_KEY`. The block checks too and exits 78, in case it is started some other way.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `urls` | required | One URL per line. Blank lines and lines starting with `#` are ignored; repeats are dropped. A `string` is capped at 64 KiB by SPEC 1.2, which is several hundred URLs. |
| `chunk_words` | `120` | Words per chunk. |
| `overlap` | `24` | How many of a chunk's last words open the next one. Must be below `chunk_words`. |
| `endpoint` | `https://litellm.cloudpunk.org/v1/embeddings` | Any OpenAI-compatible embeddings route. |
| `model` | `text-embedding-3-small` | 1536 dimensions. |
| `batch` | `16` | Chunks per request. |

## What each page becomes

- HTML: `script`, `style`, `nav`, `header`, `footer`, `aside`, `form`, hidden elements and elements
  whose class or id is a furniture word (`menu`, `sidebar`, `cookie`, ...) are dropped. If the page
  has a `main` or `article` with at least 50 words, only that is kept. Otherwise everything visible is.
- `text/*` and JSON: kept as text.
- Anything else (PDF, images): reported as failed, `content type ... is not text`.
- A page with fewer than 20 readable words is reported as failed rather than embedded as noise.

## Failures

| What happened | What the run does |
| --- | --- |
| 404, 403, any 4xx except 408/425/429, a bad URL, a non-text page, an empty page | That URL is `failed` in the manifest with the reason. The others carry on. It is not retried. |
| A timeout, a refused connection, 408/425/429, any 5xx | `fetch` reads the rest, then exits 75. The retry fetches only the URLs that are not cached yet. 3 attempts. |
| Every URL failed | `fetch` exits 78, and its log has one line per URL with the reason. |
| The embeddings route answers 429 or 5xx, or is unreachable | `embed` exits 75. The retry embeds only the chunks it has no vector for. |
| The route answers another 4xx (bad key, unknown model) | `embed` exits 78 with the status. The response body is never printed. |

If a URL keeps failing on the network through all 3 attempts, `fetch` fails and the run stops; the
URLs read so far are in its work directory, and `runs retry` picks up from them.

## The output interface

Two files. **`embeddings`** is the data: JSON Lines, UTF-8, one object per chunk, in the order the
URLs were given and then chunk order.

```json
{"id":"https://www.rfc-editor.org/rfc/rfc2119.txt#0","url":"https://www.rfc-editor.org/rfc/rfc2119.txt","index":0,"text":"Network Working Group S. Bradner ...","model":"text-embedding-3-small","dim":1536,"embedding":[0.0184,0.0702,0.0673,"... 1533 more numbers"]}
```

| Field | Type | |
| --- | --- | --- |
| `id` | string | `<url>#<index>`. The same URL, text and chunk settings give the same id, so upsert on it. |
| `url` | string | The URL as it was given, not the one after redirects. |
| `index` | integer | Position of the chunk in its page, from 0. |
| `text` | string | The chunk, words joined by single spaces. This is what was embedded. |
| `model` | string | The model that made `embedding`. |
| `dim` | integer | `embedding.length`. |
| `embedding` | array of numbers | The vector, as the route returned it. Not normalised: normalise, or use cosine. |

`model` and `dim` are on every line so the file means something on its own and two files can be
concatenated. Check that they agree before you mix vectors.

**`manifest`** is one small JSON document about the run, so a consumer knows what is missing without
scanning the data:

```json
{
  "format": 1,
  "model": "text-embedding-3-small",
  "dim": 1536,
  "chunks": 29,
  "urls_ok": 2,
  "urls_failed": 1,
  "urls": [
    {"url": "https://www.rfc-editor.org/rfc/rfc2119.txt", "status": "ok", "reason": "", "http": 200, "words": 640, "chunks": 4},
    {"url": "https://www.rfc-editor.org/rfc/does-not-exist.txt", "status": "failed", "reason": "http 404", "http": 404, "words": 0, "chunks": 0}
  ]
}
```

`urls` is in the order given, one entry per URL. `status` is `ok` or `failed`; `http` is null when the
failure had no status. `format` goes up if a field's meaning ever changes.

Reading it takes no library:

```bash
jq -c '{id, dim}' embeddings
jq '.urls[] | select(.status == "failed")' manifest
```

The pipeline's outputs `chunks`, `dim`, `urls_ok` and `urls_failed` repeat the counts for a caller
that only reads `run.json`.

## Test

`ingest.test.ts` runs the real engine against a fake site and a fake embeddings route on localhost, so
it needs no network and no key. It covers two good URLs and one 404, resuming after an embedding
failure (each chunk is paid for once), a missing key, an empty key, and a run where every URL fails.
It also checks that the key text appears in no file of the run directory, and that the nearest chunk
to a question comes from the page about it.

## Not done here

The production pod has no key. How it gets one is a deployment decision, outside this directory.
