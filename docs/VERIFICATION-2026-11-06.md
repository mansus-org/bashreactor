# Verification report, 2026-11-06

Commit verified: `cb6b238` on `main` (merge of PR #20). This worktree was 9 commits behind and was
fast-forwarded; it had no local commits.

Two things were checked. First, that the repo is what it claims to be: suite, the three scripted
demos, auth, the runtime contract. Second, that Bashreactor can carry a job it was never used for:
a real RAG ingestion (fetch an article, chunk it, embed it, store it in a vector index, search it).
The pipeline for that is in [`docs/verification/`](verification/) and it runs unmodified.

Everything in the first part passed. The ingestion ran, and the interesting part is what it exposed
about failure handling: five runs, five different ways to break, and the engine did the right thing
in four of them.

## 1. The suite and the demos

| Check | Result |
| --- | --- |
| `bun run lint` (oxlint, `--deny-warnings`) | clean |
| `bun run typecheck` (TypeScript 7.0.2, strict) | clean |
| `bun test` | 356 pass, 0 fail, 1574 assertions, 40 files, 31 s |
| `bun run build` | bundles `dist/server.js` |
| `examples/demo.sh` (CLI path) | 30 `ok`, 0 `MISMATCH`, exit 0 |
| `examples/api-demo.sh` (curl path) | matched `docs/examples/README.md` |
| `examples/mcp-demo.sh` (MCP path) | matched the API path, 19 tools, one per route |

`demo.sh` re-checks the two worked-example runs byte for byte, including the sha256 of every
published file and the mode `0444` on the published `report`. It is a real assertion script, not a
smoke test: run it with a `BASHREACTOR_HOME` that does not match the server's and it prints
`MISMATCH` for every path it cannot find. That is how it caught my own mistake on the first try.

Auth, checked by hand against a live server:

- A `read` token reads runs and is refused every write with `forbidden` and a sentence naming the
  scope. Same through the MCP server, refused before the request leaves it.
- `tokens revoke <id>` takes the UUID from `tokens ls`, not the name. After revoking, the secret
  returns `unauthenticated` on its next request.
- With no admin token set, `/healthz` answers and `/v1` returns 503.

## 2. The ingestion test

Five blocks and one pipeline, in `docs/verification/`:

| Block | What it does |
| --- | --- |
| `fetch-article.sh` | `curl` a Wikipedia article, extract the body paragraphs with Python through `uv`. 404 exits 78, a dead network exits 75. |
| `chunk-text.sh` | Word windows with overlap, one JSON object per line. |
| `embed-chunks.sh` | POST batches to an OpenAI-compatible `/v1/embeddings` route. Caches each vector in the work directory as it goes. |
| `ingest-vectors.sh` | Writes a SQLite file: `meta` plus `chunks(i, words, text, embedding BLOB)` as little-endian float32. |
| `search-vectors.sh` | Embeds the query, cosine over every row, returns the top k. |

Embeddings came from `qwen3-embedding-0.6b` on the local NPU server, 1024 dimensions. No cloud key,
no new dependency in the repo: the blocks use `curl`, `uv` and Python's standard library, which is
exactly the toolset SPEC 2.6 promises. SQLite is the vector database, and for 25 rows a full scan in
Python is the honest choice.

The pipeline is `ingest-article.yaml`: `fetch -> chunk -> embed -> index -> search`, with `index`
needing `fetch`, `chunk` and `embed`, and `search` needing `index`.

### It works

The first run, defaults, end to end in 2 seconds:

```
fetch   succeeded  1     chunk   succeeded  1     embed   succeeded  1
index   succeeded  1     search  succeeded  1

rows 5   dim 1024   chunks 5   title "Vector database"   top_score 0.599736
```

The index is sound, and `check-index.py` proves it from outside the run rather than trusting the
step that built it:

- every row is 1024 finite float32 components;
- re-embedding each row's own text against the endpoint gives the stored vector back: worst cosine
  across all 25 rows printed as **1.000000** to six places, so no row is misaligned or filled with
  noise;
- pairwise similarity across chunks runs 0.3748 to 0.8641, so it is not one vector repeated.

Retrieval is semantic, not keyword. "Why does exact nearest neighbour search degrade in high
dimensional spaces?" returns, as its top chunk, the paragraph about the curse of dimensionality
(0.7602). "How does a k-d tree split space to answer range queries?" returns the paragraph that
begins "space into two regions containing half of the points of the parent region" (0.7386).

### The five ways it was broken, and what the engine did

| Run | What was done | What the engine did |
| --- | --- | --- |
| `20261106T185511Z-016c2d69` | Embeddings endpoint answers 500 on request 2 of 7. | Attempt 1 embedded 4 chunks, exited 75, `retry_requested`. Attempt 2 logged `21 not yet embedded` and finished. 2 of 3 attempts spent. |
| `20261106T185657Z-e1416bd5` | `kill -9` the server while `embed` was at 23 of 25. | Next server marked attempt 1 `interrupted` / `engine restart`, stopped the orphaned block, ran attempt 2, which logged `2 not yet embedded`. Run succeeded. |
| `20261106T185819Z-a752e64b` | A URL that 404s. | `fetch` exited 78, `block_fatal`, one attempt of the three it was given. `chunk`, `embed`, `index`, `search` all `skipped`. |
| `20261106T185832Z-4037dcd8` | `runs cancel` mid-embed. | SIGTERM reached the process group: `uv` and its Python child were both gone, no orphans. Attempt `cancelled`. `runs retry` resumed from the 5 cached vectors and succeeded. |
| `20261106T190028Z-21696a25` | `kill -TERM` the server mid-embed. | See finding 1. The next server recovered it the same way as the crash. |

The claim that mattered most here, SPEC 4.1 ("a step that was cut off starts again from the top, and
only what it saved in the work directory carries over"), is what saved real work in three of these
five runs. Not a fake checkpoint: real vectors from a real model, paid for once.

Two smaller contract details held up too. A failed attempt's outputs directory is empty and was
never visible to a later step (SPEC 2.5). Published `file` outputs are mode `0444`, and
`search-vectors.sh` opens the database read-only through the path it was handed.

## 3. Findings

**1. The runtime check happens at the first run, not at startup.** SPEC 2.6 says an engine "MUST
check at startup that each of these resolves on `PATH`, and refuse to start with `runtime_missing`
otherwise". `checkRuntime` exists and is correct, but `ensureRuntime()` is only called from
`Engine.start()` (`apps/engine/src/engine.ts:111`). With `jq` removed from the server's `PATH`,
`/healthz` answered `{"status":"ok"}` and the refusal only arrived as a 503 on `POST /v1/runs`:

```
{"code":"runtime_missing","message":"missing on PATH: jq"}
```

The error is typed and names the binary, which is good. The timing is not: a container built without
`jq` reports healthy to a Kubernetes probe and stays healthy until someone starts a run. That is the
exact case SPEC 1.5's degraded mode exists for. Either check at startup and go degraded, or fix the
spec's wording. Worth deciding before the preview-deploy URLs at `bashreactor-pr-*.mansus.org` are
trusted to mean anything.

**2. Graceful shutdown is not what SPEC 4.7 describes, and the branch that fixes it is unmerged.**
`bashr/17-graceful-shutdown` is not an ancestor of `main`. On SIGTERM the server stops, closes and
exits. It does not mark its running attempts `interrupted` and does not delete `lock`. After
`kill -TERM` mid-embed:

```
run.json  status running, embed running, attempt 1 running (a pid that no longer exists)
lock      present, holding a dead pid
```

The next server fixes it on startup, exactly as it does after a `SIGKILL`, and the run finished
correctly. So no run is lost. The problem is the window in between, where the data directory
describes a run that is not happening. The spec's three shutdown steps are written down and
`bashr/17` implements them; it just has not been merged.

**3. `runs retry` and `runs resume` have no `--wait`, while `runs start` does.** A script that
retries a run has to poll `run.json` by hand. `demo.sh` already writes that poll for `runs start`,
so the flag exists in the codebase and is not general. Small, but it is the difference between a
one-line retry and a loop.

**4. `tokens revoke` refuses a name with a misleading error.** Given the name it prints
`token "verifier-read" does not exist`, when the token does exist and the command simply wants the
UUID. `tokens ls` prints both. A message that said "revoke takes the id from `tokens ls`" would
save the next person the guess.

**5. The engine is the least tested package in the repo.** By file count: core 3, store 1, engine 2,
api 10, mcp 8, cli 7, web 3. The engine is where scheduling, retries, cancellation, claiming and
resume live, and it has `engine.test.ts` and `restart.test.ts`. The restart test does cover the
hard path, and everything I exercised by hand behaved. But the package with the most ways to be wrong
has the fewest tests written against it, and the ingestion above had to be done by hand to find out
what `restart.test.ts` does not say.

**6. Not a bug, worth knowing.** A step shows `attempts_used: 0` while its first attempt runs. That
is SPEC 4.5 read literally ("an attempt that ends `succeeded` or `failed` adds 1"), and it is why an
interrupted attempt costs no budget. It does mean the CLI prints `0` in the ATTEMPTS column for a
step that is visibly running.

## 4. Not verified

- **The Dockerfile and the k8s manifests.** No container runtime on this machine: `docker info`
  fails. The image build and `.k3s/values.yaml` were read, not run.
- **The web UI in a browser.** The server serves `/app` (200, the right title) and every screen's
  logic is unit-tested, but I did not drive the UI. The screenshots in `README.md` are documented
  honestly, with the commit they were captured at and what each one does not show.
- **Multi-engine contention.** SPEC 4.7 lists two accepted gaps here and I did not test them.

## 5. Reproducing the ingestion

```bash
export BASHREACTOR_URL=http://127.0.0.1:8080
export BASHREACTOR_TOKEN=br_demo_admin
bun apps/cli/src/bin.ts runs start docs/verification/ingest-article.yaml --wait
```

It needs an OpenAI-compatible embeddings route. The default in the YAML is
`http://127.0.0.1:8731/v1/embeddings` with `qwen3-embedding-0.6b`; pass `--input endpoint=... --input
model=...` for another one. `check-index.py` takes the `db` path from the run directory and re-checks
it. `proxy.py` injects failures and `slow.py` adds a second of latency per request, which is how the
kill-and-resume runs above were made interruptible.
