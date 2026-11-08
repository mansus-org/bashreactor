# Bashreactor MCP server (BASHR-6)

An MCP server so another agent can browse the block library, edit pipelines, start runs and read
their logs. It is a front for the REST API and nothing else: same token, same scopes, same error
object as `apps/api`. If the API can do it, a tool can do it; if the API says no, the tool says the
same no.

## Running it

```bash
export BASHREACTOR_URL=http://127.0.0.1:8080
export BASHREACTOR_TOKEN=br_...          # optional, see Auth
bun apps/mcp/src/main.ts                 # or: bun run --filter @bashreactor/mcp start
```

```bash
bashreactor mcp listening on :8090/mcp, fronting http://127.0.0.1:8080
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `BASHREACTOR_URL` | — | The API to front, e.g. `http://127.0.0.1:8080`. May carry a path prefix for an API behind a proxy. Required: with no API to call there is nothing to degrade into, so the process refuses to start and names the variable. |
| `BASHREACTOR_TOKEN` | — | The token to spend for a caller that brings none. Absent means every caller must bring its own. |
| `BASHREACTOR_MCP_PORT` | `PORT`, then `8090` | What to listen on. `8090` so it never lands on the API's `8080`. |
| `BASHREACTOR_MCP_PATH` | `/mcp` | The one path that answers MCP. |
| `BASHREACTOR_VERSION` | the manifest version | What `/healthz` and the `initialize` result report. |

`GET /healthz` is unauthenticated and answers
`{"status":"ok","version":"…","api":"<BASHREACTOR_URL>","token":"configured"|"caller-only"}`. It
says nothing about whether the API is up: this server has no state of its own to be degraded by.

Every request logs one line, the same shape the API logs in:

```text
POST /mcp 200 14ms reader:read get_run
POST /mcp 200 3ms reader:read start_run!
```

Who the caller is, what tool the request turned into, and `!` when the tool came back with an
error. A token is never in a log line.

## Transport

Streamable HTTP at `/mcp`, **stateless**: one POST in, one JSON answer out, no `Mcp-Session-Id`, no
stream left open between calls. A pod restart loses nothing, and any replica can answer any request.

It is **its own listener**, not a route inside the API. Two reasons, and the second is the binding
one: BASHR-6 owns `apps/mcp` and nothing else, so mounting inside the API would mean editing
`apps/api`. The other is operational — a front that restarts on its own, scales on its own and can be
taken down while the API keeps serving is easier to run. The URL is configurable either way
(`BASHREACTOR_MCP_PATH`), so a proxy can present the two on one origin.

Each request is answered from the request itself: the server builds a throwaway MCP server for the
caller, answers, and throws it away.

## Auth

The caller's token arrives on the request — `Authorization: Bearer <token>` — and is spent on the
API right there. The server stores no token of its own beyond the one it was configured with, and it
never mints, caches or logs one.

1. The bearer token on the request is used. With none, `BASHREACTOR_TOKEN` is the fallback. With
   neither, the request is refused with `401 unauthenticated` before a tool runs.
2. The server calls `GET /v1/whoami` once per request. That is the only way it knows a scope: the
   API says who the token is, so a revoked token stops being able to write on the very next request
   and this server holds no opinion of its own to be stale about.
3. A tool checks the scope its route needs before it calls anything, and refuses the caller in the
   API's own words. A read token sees every tool and is told what it lacked:

   ```json
   { "code": "forbidden", "message": "token \"reader\" is read-only; the tool start_run needs a write token" }
   ```

   Write tools are never quietly omitted from `tools/list` — an agent has to be able to find out why
   it cannot do something.

Give the agent the least scope it needs. A reader that only browses the library gets a read token;
`create_agent_token` is there for an admin token to hand out more.

## Tools

`read`, `write` and `admin` are what the caller's token needs. Every route `apps/api` offers about
blocks, pipelines, runs and tokens is here; `/healthz` is the server's own probe, not something an
agent calls.

| Tool | Needs | Route | Gives you |
| --- | --- | --- | --- |
| `whoami` | read | `GET /v1/whoami` | Which token this is, and its scope |
| `list_blocks` | read | `GET /v1/blocks` | Every block name, with its latest version and how many there are |
| `list_block_versions` | read | `GET /v1/blocks/:name` | Every version of one block |
| `get_block_version` | read | `GET /v1/blocks/:name/:version` | One version's metadata |
| `get_block_content` | read | `GET /v1/blocks/:name/:version/content` | The block's bytes, header and all — its contract |
| `list_pipelines` | read | `GET /v1/pipelines` | Every stored pipeline name, with its latest version and how many there are |
| `list_pipeline_versions` | read | `GET /v1/pipelines/:name` | Every version of one pipeline |
| `get_pipeline_version` | read | `GET /v1/pipelines/:name/:version` | One version, with its YAML and parsed form |
| `validate_pipeline` | read | `POST /v1/pipelines/validate` | Every rule a document breaks, and nothing created |
| `list_runs` | read | `GET /v1/runs` | Every run, newest first |
| `get_run` | read | `GET /v1/runs/:id` | The whole `run.json` |
| `get_run_log` | read | `GET /v1/runs/:id/logs/:step/:attempt?offset=` | One attempt's log from a byte offset |
| `list_run_files` | read | `GET /v1/runs/:id/files` | What the run wrote, by output name and by step, with sizes |
| `store_block_version` | write | `POST /v1/blocks/:name/versions` | A new block version |
| `store_pipeline_version` | write | `POST /v1/pipelines/:name/versions` | A new pipeline version, validated first |
| `start_run` | write | `POST /v1/runs` | `201` and a run that has not run yet |
| `cancel_run` | write | `POST /v1/runs/:id/cancel` | `202` and a run on its way down |
| `retry_run` | write | `POST /v1/runs/:id/retry` | `200` or `202` for a failed or cancelled run |
| `resume_run` | write | `POST /v1/runs/:id/resume` | `200` or `202` for a run left `running` by a dead engine |
| `list_agent_tokens` | admin | `GET /v1/tokens` | The agent tokens, without their secrets |
| `create_agent_token` | admin | `POST /v1/tokens` | A new token, shown once |
| `revoke_agent_token` | admin | `DELETE /v1/tokens/:id` | A token that stops working now |

The three token tools are here so that everything the API offers is reachable, and they are gated on
the admin token: a read or write agent token is refused before the call is made. An agent that is
not meant to hand out credentials never can, because its token is not the admin one.

A tool's text is the API's JSON response body, unchanged, so what an agent reads is what `curl`
printed. Two exceptions: `get_block_content` wraps bytes the API answers as a plain file
(`{name, version, sha256, content}`), and the four run operations carry the HTTP status the API used
(`{status, run}`), because `201`, `202` and `200` mean different things to the caller.

### Long runs

`start_run` answers `201` with the run as created and every step `pending`; the engine drives it in
the background, so a six-hour block never becomes a six-hour MCP call. `retry` and `resume` mirror
the API's grace: if the operation fails fast or finishes inside it, the answer is the run (`200`);
otherwise it is `202` with the run as last seen. Either way the answer is `poll get_run`, and the
instructions string says so before anyone has to discover it.

### Following a log

`get_run_log` takes a byte offset and returns `{offset, next_offset, truncated, text}`. Start at 0,
pass `next_offset` back, get only what is new. That is the same cursor the CLI and the web UI use,
and it is what makes polling a run that has been going for hours cheap.

### A run's files are listed here and downloaded with the CLI

`list_run_files` answers the manifest: the run's declared outputs that are files, and for every step
and attempt its outputs, its log and its work directory, each with a run-relative path and a size.
That is a JSON document and it fits a tool result.

There is deliberately **no tool for the bytes**. `GET /v1/runs/:id/file` and
`GET /v1/runs/:id/archive` answer binary, and a run's embeddings file or work directory is routinely
hundreds of megabytes; base64-ing that into a text result would spend the context window on it and
still leave the caller with a file to reassemble. Get the bytes with the CLI, which streams them to
disk:

```bash
bashreactor runs files <run id>                       # the same manifest this tool returns
bashreactor runs download <run id> steps/embed/attempts/1/outputs/embeddings.jsonl
bashreactor runs archive <run id> -o run.tar.gz
```

The same rules apply whoever asks: paths are run-relative, a path that escapes the run directory or
passes through a symlink is `file_not_found`, and a running run's files may be partial.

## Errors

Whatever the API answers, the tool surfaces: SPEC section 5's error object with its `code`,
`message`, `path` and `file`, as the text of a tool result with `isError` set.

```json
{ "code": "type_mismatch", "message": "steps.count.with.top: expected integer, got string", "path": "steps.count.with.top" }
```

A `422` stays a `422`'s `type_mismatch`; a `run_not_active` stays `run_not_active`. Nothing is
flattened into "something went wrong", because the caller acts on `code`.

Arguments are checked here before anything is called, with the same three codes the API uses for a
request body: an absent field is `missing_input`, an unknown one is `unknown_input`, a wrong one is
`type_mismatch`, each with the field as its `path`.

Every code here is in SPEC section 5. `unauthenticated`, `forbidden` and `internal_error` are the
API's, reused for the same reasons and with the same meanings, so all three surfaces agree. The one
this server has to carry itself is `api_unreachable`, for the failure the API cannot answer for: it
is not answering at all. A tool that cannot reach it says so rather than pretending.

A tool name that does not exist is a JSON-RPC error, not a tool error: that is a broken client, not
a Bashreactor problem.

## Client config

The shape most MCP clients take — Claude Desktop, Cursor, and anything else that speaks streamable
HTTP:

```json
{
  "mcpServers": {
    "bashreactor": {
      "type": "http",
      "url": "http://127.0.0.1:8090/mcp",
      "headers": { "Authorization": "Bearer br_your_write_token" }
    }
  }
}
```

Without a header, or with a client that cannot send one, set `BASHREACTOR_TOKEN` on the server and
every caller shares it. The token goes in a header and never in the URL: a URL ends up in logs,
shell history and crash reports, and a secret there is a secret leaked.

Or drive it by hand:

```bash
curl -s -X POST http://127.0.0.1:8090/mcp \
  -H "Authorization: Bearer $BR_TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Tests

`bun test` in this package. Every tool is called through the MCP endpoint over a real socket, against
a real API server on a real socket, against an engine and a store on a throwaway directory — nothing
in the suite calls a tool function directly, because the only arrangement that would catch this
server reaching past the API is one where it cannot.

- `read-tools.test.ts`, `write-tools.test.ts` — every tool, both directions.
- `auth.test.ts` — no token, a bad token, a revoked token, a read token refused every write tool by
  name and by scope, a write token refused the admin ones.
- `errors.test.ts` — the spec's error object through from the API for every failure it can produce,
  and the API unreachable.
- `runs.test.ts` — a run that outlives the call, a log followed while it is being written, and the
  `202` path of a retry.
- `server.test.ts` — the `initialize` result, the tool table, statelessness, the probe.
- `process.test.ts` — `src/main.ts` as a real process: its probe, its refusal to start without an
  API, and a client over its socket.

## Decisions this package made

- **Its own listener, stateless, one `whoami` per request.** Written down above, because the task
  left the choice open.
- **The low-level `Server` from the SDK, not `McpServer`.** The high-level one takes zod shapes and
  answers a bad argument with its own sentence; this server owes the caller the spec's error object
  for that too. Arguments are described once in `src/args.ts`, which produces both the JSON Schema a
  client sees and the check every call goes through.
- **No `outputSchema`, no `structuredContent`.** Every result is text, and it is the API's JSON. One
  shape for nineteen tools, and nothing for a client to disagree about.
- **`get_block_content` is a tool of its own.** A block's contract is its header, and
  `get_block_version` does not contain it; folding the bytes into every metadata read would make the
  cheap call expensive.
- **`api_unreachable`**, the one code for a server that is not there, shared with the CLI and the
  web UI now that SPEC 5 lists it.

## Open

- **A successful `resume_run` is not exercised.** It needs a run left `running` by an engine that
  died, which is the engine's restart test to stage. The suite covers what the API honestly answers
  instead: `run_claimed` for a run being driven, `run_not_active` for one that finished.
- **SPEC 5 still has no codes** for `unauthenticated`, `forbidden`, `pipeline_not_found`,
  `token_not_found` or `internal_error`. All three surfaces are waiting on the same line in the spec.
- **Nothing runs the MCP server in the image.** `Dockerfile` and `.k3s/` are BASHR-2's and BASHR-9's;
  adding a second container, or a second process in the first, is theirs to place.
