# Bashreactor REST API (BASHR-5)

A versioned JSON API over blocks, pipelines and runs, with token auth in the shape `myself serve`
uses: one admin token from the environment, per-agent tokens that are read or write, stored hashed.
Every route is a call to `@bashreactor/engine` or `@bashreactor/store`; nothing here computes what
those already compute.

## Running it

```bash
bun apps/api/src/main.ts            # or: bun run serve
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | What to listen on. A bad value is a `runtime_missing` refusal to start. |
| `BASHREACTOR_HOME` | `~/.bashreactor` | The one data directory (SPEC 1.4): `runs/` and `home/` for the engine, `store/` for the store, `stage/` for staging, `tokens.json` for the tokens. |
| `BASHREACTOR_ADMIN_TOKEN` | — | The admin token, in the clear. Convenient on a laptop. |
| `BASHREACTOR_ADMIN_TOKEN_SHA256` | — | The same token as its sha256, which is what a deployment should set: the clear text then never reaches a pod spec or a shell history. Wins over the clear text. |
| `BASHREACTOR_VERSION` | the manifest version | What `/healthz` reports. The image sets it to the tag it was built as. |

With no admin token at all the server still starts and still answers `/healthz`, and every `/v1`
route is 503: an unset token is not a reason for a pod to fail its probe.

`GET /healthz` is unauthenticated and answers `{"status":"ok","version":"…"}`. That, and `GET /`
answering 501, is the contract the CI image job probes; both still hold.

## Auth

Send `Authorization: Bearer <token>`. A request that needs more than its token has is refused before
the route runs.

| Access | Who has it |
| --- | --- |
| `read` | any valid token, and the admin token |
| `write` | a write-scope agent token, and the admin token |
| `admin` | the admin token only |

Agent tokens are created over the API (admin only). The secret is random, is stored only as its
sha256, and is returned exactly once, in the body of the `POST` that created it. Revoking removes it
from the in-memory list and the file at once, so the next request with it is 401 — no restart.

## Errors

Every failure is SPEC section 5's error object, from one place (`src/errors.ts`), so no route can
answer differently:

```json
{ "code": "type_mismatch", "message": "input \"lines\": expected integer, got string", "path": "inputs.lines" }
```

| Status | Codes |
| --- | --- |
| 401 | `unauthenticated` |
| 403 | `forbidden` |
| 404 | `run_not_found`, `block_not_found`, `pipeline_not_found`, `token_not_found`, `step_not_found`, `attempt_not_found` |
| 409 | `run_claimed`, `run_not_active`, `run_not_retryable`, `already_exists`, `version_conflict` |
| 422 | every definition and starting code (`pipeline_yaml_invalid`, `pipeline_schema_invalid`, `block_header_malformed`, `block_schema_invalid`, `unknown_*`, `missing_input`, `type_mismatch`, `expression_invalid`, `dependency_cycle`, `file_input_not_found`, `env_missing`) and a request body that does not fit |
| 500 | `internal_error`, `store_migration_failed`, `store_closed` |
| 501 | `not_implemented`, for a route this API does not have |
| 503 | `runtime_missing` (a block runtime binary is missing, or no admin token is configured), `store_locked` |

Two rules that the code table alone cannot say:

- **A validation report is 422 whatever its issue's code.** `POST /v1/pipelines/validate` answers
  200 with every issue; storing a pipeline or starting a run with an invalid one is 422 with the
  first issue as the body, because the request was understood and the document inside it is wrong.
  Looking up a thing that is not there is 404.
- **A request body is an input document**, so an absent field is `missing_input`, an unknown one is
  `unknown_input` and a wrong one is `type_mismatch`, each with `path` naming the field. That is the
  spec's own vocabulary for exactly this, and SPEC 5 has no code of its own for a bad request.

`unauthenticated`, `forbidden`, `token_not_found`, `pipeline_not_found` and `internal_error` are this
API's codes, not the spec's: SPEC section 5 has none for them. They are the open item at the bottom.

## Routes

`read`, `write` and `admin` are the access each needs. `:version` is a number or `latest`.

| Method | Path | Access | Does |
| --- | --- | --- | --- |
| `GET` | `/healthz` | none | `{"status":"ok","version"}` for the deploy probe |
| `GET` | `/v1/whoami` | read | who the token is |
| `GET` | `/v1/tokens` | admin | the agent tokens, without their secrets |
| `POST` | `/v1/tokens` | admin | create one; the secret appears here and nowhere else |
| `DELETE` | `/v1/tokens/:id` | admin | revoke it, effective on the next request |
| `GET` | `/v1/blocks/:name` | read | every version of a block |
| `GET` | `/v1/blocks/:name/:version` | read | one version's metadata |
| `GET` | `/v1/blocks/:name/:version/content` | read | the block's exact bytes |
| `POST` | `/v1/blocks/:name/versions` | write | add a version (same bytes, same version) |
| `GET` | `/v1/pipelines/:name` | read | every version of a pipeline, metadata only |
| `GET` | `/v1/pipelines/:name/:version` | read | one version, with its YAML and parsed form |
| `POST` | `/v1/pipelines/validate` | read | validate YAML, report every issue, create nothing |
| `POST` | `/v1/pipelines/:name/versions` | write | store a version (validated first) |
| `GET` | `/v1/runs` | read | every run, newest first |
| `POST` | `/v1/runs` | write | start a run and drive it in the background |
| `GET` | `/v1/runs/:id` | read | the whole `run.json` |
| `POST` | `/v1/runs/:id/cancel` | write | ask for a cancel (SPEC 4.6) |
| `POST` | `/v1/runs/:id/retry` | write | manual retry of a failed or cancelled run |
| `POST` | `/v1/runs/:id/resume` | write | take up a run left `running` |
| `GET` | `/v1/runs/:id/logs/:step/:attempt` | read | the log from `?offset=`, plus the new offset |

Anything else, including a known path with a method it does not take, is 501 `not_implemented`.

### Examples

```bash
BR=http://localhost:8080
ADMIN=$BASHREACTOR_ADMIN_TOKEN
# the clear text of an agent token, from the POST /v1/tokens that created it
READ=$(jq -r .token <<<"$(curl -s -X POST -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"name":"reader","scope":"read"}' $BR/v1/tokens)")
curl -s $BR/healthz
```

```bash
# who am I
curl -s -H "Authorization: Bearer $ADMIN" $BR/v1/whoami
```

```bash
# an agent that may read and nothing more; the token is shown once, here
curl -s -X POST -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"ci-reader","scope":"read"}' $BR/v1/tokens
```

```bash
curl -s -H "Authorization: Bearer $ADMIN" $BR/v1/tokens
curl -s -X DELETE -H "Authorization: Bearer $ADMIN" $BR/v1/tokens/0f6c0b0e-5007-4ec4-9d0a-0ffbc4d2f6c1
```

```bash
# a block version; the header must declare this same name
curl -s -X POST -H "Authorization: Bearer $WRITE" -H 'content-type: application/json' \
  --data "$(jq -Rs '{content: .}' ./fetch-dataset.sh)" $BR/v1/blocks/fetch-dataset/versions
curl -s -H "Authorization: Bearer $READ" $BR/v1/blocks/fetch-dataset          # every version
curl -s -H "Authorization: Bearer $READ" $BR/v1/blocks/fetch-dataset/latest   # one version
curl -s -H "Authorization: Bearer $READ" $BR/v1/blocks/fetch-dataset/3/content # the bytes
```

```bash
# check a pipeline before storing it: 200 with every issue, never an error
curl -s -X POST -H "Authorization: Bearer $READ" -H 'content-type: application/json' \
  --data "$(jq -Rs '{yaml: .}' ./word-report.yaml)" $BR/v1/pipelines/validate

curl -s -X POST -H "Authorization: Bearer $WRITE" -H 'content-type: application/json' \
  --data "$(jq -Rs '{yaml: .}' ./word-report.yaml)" $BR/v1/pipelines/word-report/versions
curl -s -H "Authorization: Bearer $READ" $BR/v1/pipelines/word-report
curl -s -H "Authorization: Bearer $READ" $BR/v1/pipelines/word-report/latest
```

```bash
# start a run of a stored pipeline (or of raw YAML with "yaml" instead of "pipeline");
# "version" is optional and means the latest version when absent
curl -s -X POST -H "Authorization: Bearer $WRITE" -H 'content-type: application/json' \
  -d '{"pipeline":"word-report","version":2,"inputs":{"lines":200}}' $BR/v1/runs
# -> 201 and the run as created, with every step pending; it runs in the background

curl -s -H "Authorization: Bearer $READ" $BR/v1/runs
curl -s -H "Authorization: Bearer $READ" $BR/v1/runs/20261104T101500Z-3fa9c2d1
```

```bash
# follow a step's log by byte offset: the next chunk and the offset to come back with
curl -s -H "Authorization: Bearer $READ" \
  "$BR/v1/runs/20261104T101500Z-3fa9c2d1/logs/generate/1?offset=0"
# {"run":"…","step":"generate","attempt":1,"offset":0,"next_offset":184,"truncated":false,"text":"…"}
```

```bash
curl -s -X POST -H "Authorization: Bearer $WRITE" $BR/v1/runs/20261104T101500Z-3fa9c2d1/cancel
curl -s -X POST -H "Authorization: Bearer $WRITE" $BR/v1/runs/20261104T101500Z-3fa9c2d1/retry
curl -s -X POST -H "Authorization: Bearer $WRITE" $BR/v1/runs/20261104T101500Z-3fa9c2d1/resume
```

## How a run is started, and why it is not waited for

`POST /v1/runs` validates the pipeline, calls `engine.start`, answers 201 with the run as created,
and drives it in the background. A block can run for six hours; a request cannot. `retry` and
`resume` are given a short grace (`settleMs`, 250 ms) to fail fast or finish: if they do, the answer
is the run itself, and otherwise it is 202 Accepted with the run as last seen. Poll
`GET /v1/runs/:id` after that.

At startup the server calls `resume` on every run still marked `running` and skips the ones another
engine holds (SPEC 4.7), so a rollout picks jobs up rather than stranding them. On SIGTERM the server
stops and exits; runs left `running` are picked up by the next process, which stops any block process
still alive from the previous one.

## Staging: how a library block reaches the engine

The engine resolves `uses` as a path next to the pipeline file it is given and has no block library
of its own — a `name@version` reference is `block_not_found` there — while the library lives in
`packages/store`, which the engine must not need (SPEC 4.2). So `src/staging.ts` writes the pipeline
into a throwaway directory under `$BASHREACTOR_HOME/stage`, drops the bytes of every library block
beside it, and rewrites those `uses` to `./name@version`. The engine then snapshots everything into
the run directory and the staging directory is deleted.

A pipeline with no library reference is staged byte for byte. One with a library reference is staged
as the same document re-emitted in JSON, which is valid YAML and cannot change a value on the way.
The stored pipeline version always keeps the YAML exactly as it was written; only the snapshot inside
the run directory is re-emitted.

## Tests

`bun test` in this package. Every route is called through the HTTP entry point with a `Request`, and
`test/server.test.ts` runs `main.ts` as a real process over a real socket, the way the CI image job
does. The run tests build an engine whose `PATH` has every binary SPEC 2.6 demands, so they do not
depend on what happens to be installed.

## Open items

- **SPEC 5 needs codes** for `unauthenticated`, `forbidden`, `pipeline_not_found`, `token_not_found`
  and `internal_error`. Until it has them this API answers with its own, listed above.
- **The engine should take a block resolver.** Then `src/staging.ts` and its JSON re-emission go
  away and a library reference resolves the way the spec describes it.
- **No route lists every block or every pipeline.** `packages/store` has no `listBlockNames()` or
  `listPipelineNames()`, and this task may not add one. `GET /v1/blocks/:name` lists the versions of
  one block; a collection route needs those two store functions first.
- **The store's run index, logs and artifacts are not exposed.** The engine writes runs to its run
  directory and nothing writes them into the store yet, so a route over `store.listRuns` or
  `store.listArtifacts` would always answer empty. That is the engine↔store reconciliation task, and
  the API reads runs and logs from the engine until then.
- **Artifacts have no route**, for the same reason: nothing publishes them into the store yet.
- A cancel, retry or resume whose engine is a *different* process is left as the spec describes it:
  the file in the run directory, applied by whoever holds the claim.
