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
| `BASHREACTOR_RETENTION` | off | How long a run that has finished is kept before the server deletes it, as a SPEC 1.3 duration (`7d`, `12h`, `90m`). `off`, `none`, `0` and unset all mean the server never removes a run by itself; a value that does not parse stops the server rather than guessing. Whatever it is, startup says which. |

With no admin token at all the server still starts and still answers `/healthz`, and every `/v1`
route is 503: an unset token is not a reason for a pod to fail its probe.

`GET /healthz` is unauthenticated and answers `{"status":"ok","version":"…"}`. That, and `GET /`
redirecting to `/app/` (where the web UI is mounted in the image), is the contract the CI image job
probes; both still hold.

If the API could not be built at all — a `$BASHREACTOR_HOME` the uid cannot write, a store that will
not open — the server still listens: `/healthz` answers 200 with
`{"status":"degraded","version":"…","problem":"<why>"}` and every other route is 503. A container that
refuses connections is useless to look at, and the probe is all a preview URL gives you (SPEC 1.5).
The image makes that path hard to hit by creating `/data`, owning it by the uid it runs as, and
setting `BASHREACTOR_HOME` to it.

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
| 400 | `bad_request`, a path that is not decodable percent-encoded UTF-8 |
| 401 | `unauthenticated` |
| 403 | `forbidden` |
| 404 | `run_not_found`, `block_not_found`, `pipeline_not_found`, `token_not_found`, `step_not_found`, `attempt_not_found`, `file_not_found`, and `not_found` for a path with no route |
| 405 | `method_not_allowed`, a path this API has with a method it does not take |
| 409 | `run_claimed`, `run_not_active`, `run_not_retryable`, `already_exists`, `version_conflict` |
| 422 | every definition and starting code (`pipeline_yaml_invalid`, `pipeline_schema_invalid`, `block_header_malformed`, `block_schema_invalid`, `unknown_*`, `missing_input`, `type_mismatch`, `expression_invalid`, `dependency_cycle`, `file_input_not_found`, `env_missing`) and a request body that does not fit |
| 500 | `internal_error`, `store_migration_failed`, `store_closed` |
| 501 | `not_implemented`, for a route this task has not built yet |
| 503 | `runtime_missing` (a block runtime binary is missing, no admin token is configured, or the API never started) |

Two rules that the code table alone cannot say:

- **A validation report is 422 whatever its issue's code.** `POST /v1/pipelines/validate` answers
  200 with every issue; storing a pipeline or starting a run with an invalid one is 422 with the
  first issue as the body, because the request was understood and the document inside it is wrong.
  Looking up a thing that is not there is 404.
- **A request body is an input document**, so an absent field is `missing_input`, an unknown one is
  `unknown_input` and a wrong one is `type_mismatch`, each with `path` naming the field. That is the
  spec's own vocabulary for exactly this. `bad_request` is for the request that could not be read as
  written at all, before any document is in it.

Every code here is in SPEC section 5. The ones this API had to invent for failures the other packages
cannot see — `unauthenticated`, `forbidden`, `token_not_found`, `pipeline_not_found`, `not_found`,
`method_not_allowed`, `bad_request`, `internal_error` — are listed there now, so the CLI and the MCP
server print the same word for the same failure. `file_not_found` is the spec's (SPEC 4.10).

## Routes

`read`, `write` and `admin` are the access each needs. `:version` is a number or `latest`.

| Method | Path | Access | Does |
| --- | --- | --- | --- |
| `GET` | `/healthz` | none | `{"status":"ok","version"}` for the deploy probe, `{"status":"degraded",…}` if the API never started |
| `GET` | `/v1/whoami` | read | who the token is |
| `GET` | `/v1/disk` | read | the filesystem under `$BASHREACTOR_HOME`: `path`, `total_bytes`, `used_bytes`, `free_bytes`, `low`, and `runs_bytes` for the run directories alone |
| `GET` | `/v1/tokens` | admin | the agent tokens, without their secrets |
| `POST` | `/v1/tokens` | admin | create one; the secret appears here and nowhere else |
| `DELETE` | `/v1/tokens/:id` | admin | revoke it, effective on the next request |
| `GET` | `/v1/blocks/:name` | read | every version of a block |
| `GET` | `/v1/blocks/:name/:version` | read | one version's metadata |
| `GET` | `/v1/blocks/:name/:version/content` | read | the block's exact bytes |
| `POST` | `/v1/blocks/:name/versions` | write | add a version (`content`, or `content_b64`); same bytes, same version |
| `GET` | `/v1/pipelines/:name` | read | every version of a pipeline, metadata only |
| `GET` | `/v1/pipelines/:name/:version` | read | one version, with its YAML and parsed form |
| `POST` | `/v1/pipelines/validate` | read | validate YAML, report every issue, create nothing |
| `POST` | `/v1/pipelines/:name/versions` | write | store a version (validated first) |
| `GET` | `/v1/runs` | read | one page of runs, newest first; `?limit=` and `?cursor=`, `X-Next-Cursor` when there is more |
| `POST` | `/v1/runs` | write | start a run and drive it in the background |
| `GET` | `/v1/runs/:id` | read | the whole `run.json` |
| `POST` | `/v1/runs/:id/cancel` | write | ask for a cancel (SPEC 4.6) |
| `POST` | `/v1/runs/:id/retry` | write | manual retry of a failed or cancelled run |
| `POST` | `/v1/runs/:id/resume` | write | take up a run left `running` |
| `GET` | `/v1/runs/:id/logs/:step/:attempt` | read | the log from `?offset=`, plus the new offset |
| `GET` | `/v1/runs/:id/files` | read | what the run wrote: its file outputs, and each step's outputs, log and work, with sizes |
| `GET` | `/v1/runs/:id/file?path=` | read | one of those files, streamed, as an attachment |
| `GET` | `/v1/runs/:id/archive` | read | the run, one step or one attempt as tar.gz |
| `DELETE` | `/v1/runs/:id` | write | remove a finished run and everything it wrote; `run_claimed` while an engine holds it |

A path this API does not have is 404 `not_found`; a path it does have, with a method it does not take,
is 405 `method_not_allowed` naming the methods it takes. `GET /` is not a route: it redirects to
`/app/`, where the image mounts the web UI.

An id in a path is checked before it is used: a run id must match SPEC 4.2's shape
(`20261104T101500Z-3fa9c2d1`) and a block or pipeline name must match SPEC 1.1's, because the engine
and the store join both straight into a path. A name that cannot be one is 404 for a run and 422 for
a block or pipeline, whose name is part of the document being created.

A block version is filed under the name its header declares, and the header's name need not be the
filename (SPEC 2.3) — the route only refuses a body that declares something other than the name in
its path. The bytes are what the version is (SPEC 2), so `content_b64` carries a file whose body is
not valid UTF-8 whole, where `content` is text and can only carry what UTF-8 can hold. The header
must be valid UTF-8 either way (SPEC 2.2).

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
# one page of twenty, and the page after it: the cursor is the last id of the page before it
curl -s -D - -o /dev/null -H "Authorization: Bearer $READ" "$BR/v1/runs?limit=20" | grep -i x-next-cursor
curl -s -H "Authorization: Bearer $READ" "$BR/v1/runs?limit=20&cursor=20261104T101500Z-3fa9c2d1"
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

```bash
# what a run wrote, then one file of it, then the whole run as tar.gz
RUN=20261104T101500Z-3fa9c2d1
curl -s -H "Authorization: Bearer $READ" $BR/v1/runs/$RUN/files
curl -s -H "Authorization: Bearer $READ" \
  --url-query "path=steps/embed/attempts/1/outputs/embeddings.jsonl" -O -J $BR/v1/runs/$RUN/file
curl -s -H "Authorization: Bearer $READ" -o "$RUN.tar.gz" $BR/v1/runs/$RUN/archive
# one step, or one attempt of it
curl -s -H "Authorization: Bearer $READ" -o embed.tar.gz --url-query step=embed $BR/v1/runs/$RUN/archive
curl -s -H "Authorization: Bearer $READ" -o embed1.tar.gz --url-query step=embed --url-query attempt=1 $BR/v1/runs/$RUN/archive
```

```bash
# how full the volume is, and one run gone for good
# {"path":"/data","total_bytes":1005921779712,"used_bytes":564133601280,"free_bytes":441788178432,"low":false,"runs_bytes":22452}
curl -s -H "Authorization: Bearer $READ" $BR/v1/disk
curl -s -X DELETE -H "Authorization: Bearer $WRITE" $BR/v1/runs/$RUN
# -> 200 {"deleted":"…"}; 409 run_claimed if a run is still writing into it
```

## Room to write in

`$BASHREACTOR_HOME` is a volume of a fixed size and a run never stops writing to it, so there are two
routes about that and neither of them is `/healthz`.

`GET /v1/disk` is the number: the filesystem under the data directory, with `low` true once free space
is under 64 MiB. It is a read route and not the probe on purpose — a full volume is not something a
restart fixes, and a probe that fails there takes a pod out of rotation with a run mid-flight to report
something that was already true. A filesystem that will not answer (`statvfs` failed, so most often a
mount that is not there) is 503 `runtime_missing`, never a zero: a volume that did not mount is not a
full one.

The four sizes are the *filesystem*'s, which is not always the volume: a `local-path` PVC is a directory
on the node and enforces no size, so `total_bytes` there is the node's disk and `low` fires late. That
is what `runs_bytes` is for — the bytes under `runs/`, counted by walking them, and nothing else — the
only number on the route that is about this server's own data. The walk is one `stat` per file and it
follows no symlink, so a block cannot plant a link out of the run directory to make the number lie; the
cost is paid on a route nobody polls at speed.

`DELETE /v1/runs/:id` is the removal, and `BASHREACTOR_RETENTION` is the same call on a timer — hourly,
starting at boot, for runs that reached a final status and have been finished longer than the window.
A run that is `running` or `waiting`, one with no `finished_at`, and one with a live claim are all kept,
and one directory that will not go does not stop the pass. The default is off, because a run directory is
the only copy of what a pipeline produced; the server says "retention is off" at startup so that the
default is a decision somebody made rather than a thing nobody noticed.

## Reading a run's files, and what that cannot reach

`files`, `file` and `archive` answer about one directory: `$BASHREACTOR_HOME/runs/<run id>/`. Paths
are run-relative — the strings SPEC 4.2 documents — and every one of them goes through one helper
(`src/run-files.ts`), so the three routes cannot disagree about what is reachable.

- A path is refused when it is empty, starts with `/`, contains a NUL, or has a segment that is empty,
  `.` or `..`. The check runs on the decoded string, so `..`, `%2e%2e%2f`, `..%2f` and a double
  encoding are the same refusal.
- **A symlink is never followed, in a download or in an archive.** A block is arbitrary bash and can
  leave a link at `tokens.json`, at the store, or at another run's directory; every component of a
  path is read with `lstat` from the run directory down and a link anywhere in it is `file_not_found`.
  The manifest lists a link with `"kind": "link"` and no size, so planting one cannot hide it, and the
  archive skips links and reports how many in `x-run-skipped`.
- A download is `content-disposition: attachment` with `content-type: application/octet-stream` and
  `x-content-type-options: nosniff`, whatever the file's name or bytes say. A block can write an HTML
  file, and one served inline from the API's origin is a script that runs as the API.
- Files stream from `Bun.file` and the tar is piped through `CompressionStream("gzip")`; neither is
  ever assembled in memory, because a run's embeddings file can be larger than the pod's whole limit.
- A running run is still writing, so its files may be partial: the manifest says `partial: true`, and
  a download carries `x-run-partial: true`. A finished run's files are final.

An unknown run, step or attempt is the same 404 the log route gives. A path with no file behind it is
`file_not_found`; a path that names a directory is `bad_request` telling you to use the archive.

## How the run list is paged

`GET /v1/runs` answers with a page, never with the history. The id is a timestamp to the second
(SPEC 4.2), so it is the whole ordering: the server lists the run directories, sorts the ids newest
first, and reads the `run.json` of the page it chose and nothing else. Reading every run to throw all
but a page away made one request cost what the whole history does, and nothing bounded it.

- `?limit=` is how many the page holds. Absent, empty or `0` is 100; more than 500 is clamped to 500;
  something that is not a count is 422 `type_mismatch`.
- `?cursor=` is the last id of the page before this one. Absent or unparseable starts at the newest.
- `X-Next-Cursor` is sent when there is a page below this one, and it is the id to pass as `?cursor=`
  to get it. Absent means you are at the bottom.

The body is unchanged: an array of `{id, pipeline, status, created_at, finished_at,
cancel_requested_at}`, newest first. A client that used to be handed everything is handed the newest
page, and stops when the header is absent.

Two things follow from the cursor being an id rather than an offset, and both are the point:

- A run that arrives while you are paging does not shift the page under you, because the walk is
  against ids and not against positions.
- A run the server cannot read does not wedge the walk. A directory that is not a run id is not a
  run, and a run whose `run.json` is missing or cannot be parsed is left out of the body, logged, and
  still moves the cursor along — one bad file is not allowed to be a listing that never answers.

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
does. `test/startup.test.ts` pins the other half of that contract: a server whose API could not be
built still binds the socket and says why at `/healthz`. The run tests build an engine whose `PATH`
has every binary SPEC 2.6 demands, so they do not depend on what happens to be installed.
`test/delete-run.test.ts` and `test/disk.test.ts` go through the socket too, because both are about a
directory and a filesystem rather than about a handler, and `test/retention.test.ts` runs the sweep
against an engine of records with the clock held still.

## Open items

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
