# The demo: one pipeline, end to end

This directory holds the path a person who has never seen this repo takes to watch a run go all the
way through: store four bash blocks and a pipeline, start a run, follow its logs while it runs, and
read the results. It uses the worked example from
[`docs/examples/`](../docs/examples/README.md), which is the pipeline `docs/SPEC.md` section 7 is
written against, so every number below is checked twice: once here and once by the engine's own
tests.

```
            ┌─> check ───────┐
generate ───┤                ├─> report
            └─> count ───────┘
```

Nothing here is a second copy of that pipeline. The scripts read `docs/examples/` at run time,
because that directory is what `apps/engine/test/engine.test.ts`, `restart.test.ts` and
`packages/core`'s parser tests already read, and `docs/examples/README.md` is the authority on what
a correct run returns. A copy in `examples/` would let the demo pass on bytes nothing else tests,
and it would be a fifth thing to keep in sync.

## Which surface does which step

Four surfaces, one path. Each step is done once, on the surface that fits it, and the others are
named rather than repeated.

| Step | The CLI does it here | The API route behind it | The web screen | The MCP tool |
| --- | --- | --- | --- | --- |
| publish the four blocks | `pipelines validate` | `POST /v1/blocks/:name/versions` | Blocks | `store_block_version` |
| store the pipeline | `pipelines add` | `POST /v1/pipelines/:name/versions` | Pipeline | `store_pipeline_version` |
| start a run | `runs start` | `POST /v1/runs` | Pipeline, Start | `start_run` |
| follow a log while it runs | `runs logs --follow` | `GET /v1/runs/:id/logs/:step/:attempt?offset=` | Runs | `get_run_log` |
| read the results | `runs get` | `GET /v1/runs/:id` | Runs | `get_run` |
| cancel, retry, resume | `runs cancel\|retry\|resume` | the three `POST`s | the run's buttons | `cancel_run`, `retry_run`, `resume_run` |

The CLI drives the scripted path because it is the only surface that can take a pipeline **file** off
your disk: the API has no route that accepts a directory of blocks, so `pipelines validate` and
`pipelines add` publish each `uses: ./x.sh` beside the file into the library and rewrite the
reference to the `name@version` the library answered with (apps/cli/README.md, "A pipeline file on
your disk"). Everything after that is the same four routes from whichever client you prefer.

## The spec's hard cases, and where you see them

All three come from `docs/examples/README.md`. None of them is staged with a fake block: they are
what the real blocks do.

| Hard case | Where it shows |
| --- | --- |
| Exit 75 asks for a retry, and the next attempt resumes from the work directory (SPEC 2.8, 4.1) | Step 2, `generate` attempt 1 stops at line 120 and attempt 2 picks up at 121 |
| Exit 78 never spends the retry budget (SPEC 2.8) | Step 2 with `lines=50`: `check` is `block_fatal` after 1 of its 2 attempts |
| A step is `skipped` while unrelated work carries on (SPEC 4.4) | same run: `report` is `skipped` with no attempts, `count` succeeds |
| A retry wait is a real wait (`SPEC 3.5`) | Step 3's poll shows `generate=waiting_retry` for the pipeline's `delay: 1s` |
| A log is followed by byte offset, not streamed (SPEC 4.8) | Step 3, reading `generate` attempt 1 from byte 42 |
| A run is a directory (SPEC 4.2) | Step 6 |

## What you need

`bun`, `uv`, `bash` 5, `curl`, `jq`. That is SPEC 2.6's list minus the ones every machine has; the
pipeline itself needs no network, because `count-words.sh` declares no Python dependencies and
`render-report.sh` imports nothing.

Everything below runs from the root of the repo. Where a command prints `bashreactor`, either install
the CLI or make it real for your shell first:

```bash
alias bashreactor='bun apps/cli/src/bin.ts'
```

The scripts in this directory call `bun apps/cli/src/bin.ts` directly and need no alias.

## 1. Start the server

One process serves the web UI at `/app` and the API at `/v1`, because that is what the container runs:
`apps/web/src/server.ts` is `apps/api/src/main.ts` with the UI mounted in front of it.

```bash
./examples/serve.sh
```

```
bashreactor demo server
  data dir  /tmp/bashreactor-demo
  web UI    http://127.0.0.1:8080/app
  API       http://127.0.0.1:8080/v1
  token     br_demo_admin

That token is for a server on your own machine and for nothing else. In another terminal:

  export BASHREACTOR_URL=http://127.0.0.1:8080
  export BASHREACTOR_TOKEN=br_demo_admin

Ctrl-C stops the server. The runs stay in the data directory.
bashreactor listening on :8080
```

Open a second terminal for the rest, and tell every client where the server is and who you are:

```bash
export BASHREACTOR_URL=http://127.0.0.1:8080
export BASHREACTOR_TOKEN=br_demo_admin
```

`$BASHREACTOR_HOME` (default `/tmp/bashreactor-demo` here, `~/.bashreactor` everywhere else) is the
one data directory of SPEC 1.4. The CLI, the API and the engine all read it, which is why one variable
points them at the same place.

## 2. The scripted path: the CLI

### Store the blocks and the pipeline

```bash
bashreactor health
bashreactor whoami
bashreactor pipelines validate docs/examples/word-report.yaml
bashreactor pipelines add word-report docs/examples/word-report.yaml
```

```
ok        demo
url    http://127.0.0.1:8080  (from BASHREACTOR_URL)
token  br_dem…dmin  (from BASHREACTOR_TOKEN)
name   admin
scope  admin
admin  yes
published <repo>/docs/examples/generate-corpus.sh as generate-corpus@1
published <repo>/docs/examples/check-corpus.sh as check-corpus@1
published <repo>/docs/examples/count-words.sh as count-words@1
published <repo>/docs/examples/render-report.sh as render-report@1
valid  <repo>/docs/examples/word-report.yaml
stored word-report@1  284add893421
```

The four `published` lines go to stderr, because they are the command telling you what it did on your
behalf, and stdout stays the answer. `validate` checks the pipeline and every block it references and
creates nothing except those block versions; `add` stores the rewritten document as a pipeline
version. Publishing is content-addressed, so running this twice gives `@1` back both times.

Look at what got stored, if you like: `bashreactor pipelines get word-report` prints the YAML with
`uses: generate-corpus@1` where the file says `uses: ./generate-corpus.sh`.

### Run it, and follow a log while it runs

```bash
bashreactor runs start docs/examples/word-report.yaml
```

```
run       20261105T183113Z-f73c5e7c
pipeline  word-report
status    running
created   2026-11-05 19:31:13
finished  -
took      -

STEP      STATUS   ATTEMPTS  NEEDS                 FAILURE
generate  pending  0         -                     -
check     pending  0         generate              -
count     pending  0         generate              -
report    pending  0         generate,check,count  -

inputs
lines  200
seed   7
title  Word report

started <repo>/docs/examples/word-report.yaml
follow it: bashreactor runs logs 20261105T183113Z-f73c5e7c generate --follow
```

`POST /v1/runs` answers 201 as soon as the run exists and the engine drives it in the background, so
a six-hour block never becomes a six-hour request. Take the hint it prints:

```bash
bashreactor runs logs 20261105T183113Z-f73c5e7c generate --follow
```

```
==> attempt 1 <==
attempt 1: 0 of 200 lines already written
attempt 1: stopping after 120 lines, asking for a retry
==> attempt 2 <==
attempt 2: 120 of 200 lines already written
attempt 2: corpus finished
next offset 71
run 20261105T183113Z-f73c5e7c succeeded
```

That is the first hard case. `generate` was told `interrupt_at: 120`, so attempt 1 wrote 120 lines into
its work directory and exited 75, which is `EX_TEMPFAIL` and means *retry me* (SPEC 2.8). The step is
not final until the retry finishes, so `--follow` kept reading until it was.

A step's log is its attempts' logs in order (SPEC 4.8), which is what `--follow` gives you: attempt 1
read to its last byte, then the next attempt from byte 0. The lines the reader adds — the
`==> attempt N <==` marker at each boundary, `next offset` and `run ...` — are notes on stderr, so
`--follow > corpus.txt` still writes nothing but what the block wrote, and `next offset` is the byte
cursor *within the last attempt*. `--attempt 1` reads one attempt on its own and prints no markers.

Following a step that has not started yet is a wait, not an error: a step whose dependency is still
running has no attempt, and `--follow` polls until it has one, or until the step or the run goes
final. And if the step you are following fails while the run is still going, `--follow` exits 1 and
names the step, because the run has not decided anything yet.

### Wait for it and read the results

If you would rather not follow anything, `--wait` polls until the run is final and exits with its
status, which is what a CI step wants:

```bash
bashreactor runs start docs/examples/word-report.yaml --wait; echo "exit $?"
```

```
run       20261105T183113Z-f73c5e7c
pipeline  word-report
status    succeeded
created   2026-11-05 19:31:13
finished  2026-11-05 19:31:14
took      2s

STEP      STATUS     ATTEMPTS  NEEDS                 FAILURE
generate  succeeded  2         -                     -
check     succeeded  1         generate              -
count     succeeded  1         generate              -
report    succeeded  1         generate,check,count  -

inputs
lines  200
seed   7
title  Word report

outputs
report       steps/report/attempts/1/outputs/report
total_words  1300
exit 0
```

`generate` spent two of its three attempts. The two logs say why, and they are the second half of the
first hard case:

```bash
bashreactor runs logs <run-id> generate --attempt 1
bashreactor runs logs <run-id> generate --attempt 2
```

```
attempt 1: 0 of 200 lines already written
attempt 1: stopping after 120 lines, asking for a retry
next offset 98
attempt 2: 120 of 200 lines already written
attempt 2: corpus finished
next offset 71
```

Attempt 2 started from the top of the same script, in the same work directory, found 120 lines already
written, and carried on. Attempt 1's outputs directory is empty: a failed attempt's files are kept for
debugging and never published (SPEC 2.5).

`total_words` 1300 and the report's bytes are exactly what
[`docs/examples/README.md`](../docs/examples/README.md) says they are. `examples/demo.sh` checks
that, and the sha256 of every artifact, on every run.

### The gate, and the other two hard cases

```bash
bashreactor runs start docs/examples/word-report.yaml --input lines=50 --wait; echo "exit $?"
```

```
run       20261105T182553Z-7ba91461
pipeline  word-report
status    failed
created   2026-11-05 19:25:53
finished  2026-11-05 19:25:53
took      0s

STEP      STATUS     ATTEMPTS  NEEDS                 FAILURE
generate  succeeded  1         -                     -
check     failed     1         generate              block_fatal: block_fatal
count     succeeded  1         generate              -
report    skipped    0         generate,check,count  -

inputs
lines  50
seed   7
title  Word report
exit 1
```

Read that table slowly, because it is three rules at once:

- `generate` succeeded in one attempt. `interrupt_at` is 120 and the run only wanted 50 lines, so it
  never stopped. A retry is a response to a failure, not a ritual.
- `check` exited 78, which is *do not bother*: another attempt would read the same short file. Its
  `retry` says `max_attempts: 2` and spent one of them. That is the retry budget not being wasted.
- `report` `needs: [check]`, so it is `skipped` with no attempts and no bound inputs. `count` needs
  nothing from `check`, so it ran and published its outputs anyway. Failure takes down what depended
  on it and leaves everything else alone (SPEC 4.4).

```bash
bashreactor runs logs <run-id> check --attempt 1
```

```
check-corpus: 50 lines, need at least 100
next offset 42
```

A failed run you waited for exits 1, so a script notices. `--json` prints the API's own document
instead of the table, which is what you want in a pipeline:

```bash
bashreactor runs get <run-id> --json | jq -c '.status, .outputs'
```

```
"failed"
null
```

## 3. The machine-readable path: the API

The same objects through `curl` and `jq`, which is the shape an agent or a CI job takes. Nothing here
repeats step 2: this path starts its **own** run, with inputs as real JSON values, and it is where the
offset cursor gets shown.

```bash
BR=http://127.0.0.1:8080
ADMIN=$BASHREACTOR_TOKEN
curl -s $BR/healthz
curl -s -H "authorization: Bearer $ADMIN" $BR/v1/whoami
```

```
{"status":"ok","version":"demo"}
{"name":"admin","scope":"admin","admin":true}
```

`/healthz` needs no token and answers even when the API could not build itself, because a probe that
refuses connections tells nobody anything (SPEC 1.5).

### What the CLI left in the library

```bash
curl -s -H "authorization: Bearer $ADMIN" $BR/v1/blocks/generate-corpus | jq '{name, latest, sha256: .versions[-1].sha256}'
curl -s -H "authorization: Bearer $ADMIN" $BR/v1/pipelines/word-report/latest | jq -r .yaml | grep uses:
```

```
{
  "name": "generate-corpus",
  "latest": 1,
  "sha256": "fd1d4b48454effe1f55ba32926c114317909f20479b16cec300246a707e10e8c"
}
    uses: generate-corpus@1
    uses: check-corpus@1
    uses: count-words@1
    uses: render-report@1
```

There is no route that lists every block or every pipeline, so a client has to know a name. That is a
known gap in BASHR-5 (`packages/store` has no `listBlockNames()`), and the web UI has the same
limitation for the same reason: it opens a pipeline by name too.

### Start a run of the stored pipeline

```bash
curl -s -X POST -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"pipeline":"word-report","inputs":{"lines":300,"seed":11,"title":"Other"}}' \
  $BR/v1/runs | jq '{id, status, steps: (.steps | to_entries | map("\(.key): \(.value.status)"))}'
```

```
{
  "id": "20261105T183218Z-4b0661fd",
  "status": "running",
  "steps": [
    "generate: pending",
    "check: pending",
    "count: pending",
    "report: pending"
  ]
}
```

`lines` is the integer 300 here, not the string `"300"`: over the API and MCP, values are checked with
the literal rule (SPEC 3.3). On the CLI the same thing is `--input lines=300`, read with the text form.

### Poll it

```bash
ID=20261105T183218Z-4b0661fd
curl -s -H "authorization: Bearer $ADMIN" $BR/v1/runs/$ID | jq -r '"\(.status)  \(.steps | to_entries | map("\(.key)=\(.value.status)") | join(" "))"'
```

```
running  generate=waiting_retry check=pending count=pending report=pending
```

```
succeeded  generate=succeeded check=succeeded count=succeeded report=succeeded
```

There is no websocket and no callback: `GET /v1/runs/:id` is the whole of it, and its answer is
`run.json`. The `waiting_retry` you may catch is the pipeline's `delay: 1s` being a real wait, written
into `run.json` so a restart honours it too.

### Follow a log by byte offset

```bash
curl -s -H "authorization: Bearer $ADMIN" "$BR/v1/runs/$ID/logs/generate/1?offset=0"
curl -s -H "authorization: Bearer $ADMIN" "$BR/v1/runs/$ID/logs/generate/1?offset=42" | jq '{offset, next_offset, text}'
```

```
{
  "run": "20261105T183218Z-4b0661fd",
  "step": "generate",
  "attempt": 1,
  "offset": 0,
  "next_offset": 98,
  "truncated": false,
  "text": "attempt 1: 0 of 300 lines already written\nattempt 1: stopping after 120 lines, asking for a retry\n"
}
{
  "offset": 42,
  "next_offset": 98,
  "text": "attempt 1: stopping after 120 lines, asking for a retry\n"
}
```

The cursor is a byte offset into that attempt's log file (SPEC 4.8). Read from 0, keep `next_offset`,
ask again, get only what is new. The CLI's `--follow` and the web UI's log pane use this same cursor,
which is what makes following a run that has been going for six hours one small request per interval
instead of a re-read of everything.

### The results

```bash
curl -s -H "authorization: Bearer $ADMIN" $BR/v1/runs/$ID | jq '{status, inputs, outputs}'
```

```
{
  "status": "succeeded",
  "inputs": { "lines": 300, "seed": 11, "title": "Other" },
  "outputs": {
    "report": "steps/report/attempts/1/outputs/report",
    "total_words": 1950
  }
}
```

`total_words` 1950 and the title `Other: 300 lines` are the third scenario in
`docs/examples/README.md`. The title is the pipeline's template, `"${{ inputs.title }}: ${{
steps.generate.outputs.line_count }} lines"`, bound once when the step first became eligible and stored
in `run.json`.

`GET /v1/runs` lists every run, newest first, if you want the short version of all of this.

## 4. The same run in the browser

Open <http://127.0.0.1:8080/app>. The first screen is the token gate: the server address is prefilled
with the page's own origin, and you paste `br_demo_admin` as the token. It goes out as
`Authorization: Bearer` on every call and is kept in the browser only.

Three screens, and all of them read the same `/v1` routes you just called by hand:

| Screen | What to look at |
| --- | --- |
| `/app/pipeline` | Type `word-report` into Open. The graph is drawn from the YAML, never stored beside it, so the two cannot disagree. The Problems panel is `POST /v1/pipelines/validate`. Start is `POST /v1/runs`. |
| `/app/runs` | Every run, newest first. Open the failed one and the graph shows `check` failed and `report` skipped while `count` finished: statuses are 1-bit signs, not colours. The log pane follows one attempt by byte offset, with Follow and Pause, and the run's own Cancel, Retry and Resume buttons are the three POSTs. |
| `/app/blocks` | Open `generate-corpus`. The contract shown is the block's own header, read out of the stored bytes. |

There is no README for `apps/web` yet, so if you want to know how a screen works, the entry point is
`apps/web/src/server.ts` (how it mounts) and `apps/web/src/client/` (`app.ts` is the shell and the
gate, `runs.ts` the run screen, `blocks.ts` the library, `editor.ts` the pipeline).

## 5. The same run from an agent: MCP

The MCP server is a front for the API and nothing else: same token, same scopes, same error object. It
listens on its own port.

```bash
export BASHREACTOR_MCP_PORT=8090
bun apps/mcp/src/main.ts
```

```
bashreactor mcp listening on :8090/mcp, fronting http://127.0.0.1:8080
```

```bash
curl -s http://127.0.0.1:8090/healthz
curl -s -X POST http://127.0.0.1:8090/mcp \
  -H "authorization: Bearer $BASHREACTOR_TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_run_log","arguments":{"id":"20261105T183218Z-4b0661fd","step":"generate","attempt":1,"offset":0}}}' |
  jq -r '.result.content[0].text' | jq '{next_offset, text}'
```

```
{"status":"ok","version":"0.0.0","api":"http://127.0.0.1:8080","token":"configured"}
{
  "next_offset": 98,
  "text": "attempt 1: 0 of 300 lines already written\nattempt 1: stopping after 120 lines, asking for a retry\n"
}
```

The tools for the path above are `whoami`, `list_block_versions`, `get_block_content`,
`list_pipeline_versions`, `get_pipeline_version`, `validate_pipeline`, `list_runs`, `get_run` and
`get_run_log` for reading, and `store_block_version`, `store_pipeline_version`, `start_run`,
`cancel_run`, `retry_run` and `resume_run` for writing. `examples/mcp-demo.sh` calls the read ones
against the runs the other scripts made.

Scopes are the API's, enforced by the API. Hand an agent a read token and a write tool answers in the
API's own words, with the tool still listed so the agent can find out why:

```json
{"code":"forbidden","message":"token \"demo-reader\" is read-only; the tool start_run needs a write token"}
```

Point your MCP client at it with the shape most clients take:

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

## 6. The run on disk

A run is a directory, and it is the source of truth for that run (SPEC 4.2). Nothing else needs to be
running for you to read it:

```bash
find /tmp/bashreactor-demo/runs/<run-id> -maxdepth 3 | sed "s|/tmp/bashreactor-demo/runs/<run-id>|.|" | sort
```

```
./blocks
./blocks/4bdce194faaa24d90cffe423d2789f888b47d1c83d9fdc4162f09636a0221ef8.sh
./blocks/9051ff6dfeeb62d8f866710913ca0a14f0f61d6e50b78e3c8e5c23244d7e4cc1.sh
./blocks/989e042a8c64af1482bb04dba013df781b089a653b88587d0ee248c42cd37fc5.sh
./blocks/fd1d4b48454effe1f55ba32926c114317909f20479b16cec300246a707e10e8c.sh
./inputs
./pipeline.yaml
./run.json
./steps
./steps/check
./steps/check/attempts
./steps/check/work
./steps/count
./steps/count/attempts
./steps/count/work
./steps/generate
./steps/generate/attempts
./steps/generate/work
./steps/report
./steps/report/attempts
./steps/report/work
```

`pipeline.yaml` and `blocks/<sha256>.sh` are snapshots, so editing a block never changes a run that has
already started. `steps/generate/work/` is the directory attempt 2 resumed from. `run.json` is
everything the API, the CLI and the UI show. Deleting a run means deleting its directory.

## 7. The three scripts, if you would rather not type

With `BASHREACTOR_URL` and `BASHREACTOR_TOKEN` set:

```bash
./examples/demo.sh       # the CLI path, and every number checked
./examples/api-demo.sh   # the API path
./examples/mcp-demo.sh   # the MCP tools, against the runs those two made
```

Each one prints `ok` or `MISMATCH` per assertion and exits non-zero if anything differs from
`docs/examples/README.md`. A mismatch is a bug in this repo, not something to work around. They are
run by `examples/demo.test.ts`, which is part of `bun run check`, so they cannot quietly rot. That
test is typechecked with `bunx tsc -p examples`, because the root `typecheck` script only walks
`packages/*` and `apps/*` and `examples/` is not a workspace.

## Against the live deployment

`https://bashreactor.mansus.org/healthz` does not answer, and that is the cluster-side blocker already
written up in `/home/nixos/Projects/bashreactor-orchestration/ARGOCD.md`. The evidence, as of this
writing:

```bash
curl -sS -D - -o - http://bashreactor.mansus.org/healthz
echo | openssl s_client -connect bashreactor.mansus.org:443 -servername bashreactor.mansus.org 2>/dev/null | openssl x509 -noout -subject
```

```
HTTP/1.1 404 Not Found
404 page not found
subject=CN=TRAEFIK DEFAULT CERT
```

The name resolves (116.203.141.167), Traefik answers, and it has no router for this host and no
certificate for it. That is Argo CD's side, not the repo's:

- The image **is** built and pushed. The `deploy` workflow on `main` (`688121f`) finished
  `build-and-push: success` and pushed `ghcr.io/mansus-org/bashreactor:sha-688121f` and `:latest`.
- The `image` CI job on `main` passed, which means the container starts, answers `/healthz` with its
  version, keeps `/` at 501, runs as uid 10001, and has every SPEC 2.6 binary on its `PATH`.
- The package is not readable anonymously (`GET https://ghcr.io/v2/mansus-org/bashreactor/tags/list`
  is 401), which is the second thing ARGOCD.md says to check once an Application exists.
- `.k3s/values.yaml` still matches what the merged server needs, so nothing here was changed:
  `persistence.mountPath: /data` plus `env.BASHREACTOR_HOME: /data` for the one data directory,
  `podSecurityContext.fsGroup: 10001` for the uid the image runs as, `healthCheck.path: /healthz`,
  `port: 8080`. All four were checked against the image and the running server, not assumed.

Two things the deploy will still need before the demo can run against a URL, neither of which is
something `examples/` may fix:

1. **No admin token is set on the deployment.** With none, `/healthz` answers ok and every `/v1` route
   answers 503 `runtime_missing` naming the variable, which is deliberate (SPEC 1.5). Verified
   locally: `{"code":"runtime_missing","message":"the API is disabled: set BASHREACTOR_ADMIN_TOKEN or
   BASHREACTOR_ADMIN_TOKEN_SHA256 on the server"}`. Someone has to put `BASHREACTOR_ADMIN_TOKEN_SHA256`
   in the pod from a secret before the live URL can store a pipeline, and that is a platform decision
   about where a secret lives, not a guess to make from a values file.
2. **Nothing runs the MCP server in the image.** `Dockerfile` ships one process (`bun server.js`), and
   apps/mcp/README.md says the same. Step 5 is local until someone decides whether MCP gets its own
   container or a second process in the first.

Once the Application exists and syncs, the browser step becomes <https://bashreactor.mansus.org/app>
and the CLI and API steps work against `https://bashreactor.mansus.org` unchanged, because every
client here only ever needed a URL and a token.

## Troubleshooting

**`runtime_missing` when the server starts, or the first block will not run.** SPEC 2.6 makes an engine
refuse to start unless `bash`, `uv`, `bun`, `awk`, `curl`, `grep`, `gzip`, `jq`, `sed`, `tar` and
coreutils resolve on its `PATH`. `command -v uv bun jq` names the one that is missing.

**`failed to bind` on 8080.** Something else has the port. `PORT=8081 ./examples/serve.sh`, and
re-export `BASHREACTOR_URL` to match. The scripts read both variables and never hardcode a port.

**`unauthenticated` at exit 1.** The token the server was started with and the one your shell has are
not the same. `bashreactor whoami` prints which URL and token won and where each came from: a flag
beats the environment beats `$BASHREACTOR_HOME/cli.json`. If you have a `cli.json` from an older
server, the environment wins, so this bites in the other direction only when the variables are unset.

**`attempt_not_found` from `runs logs` right after `runs start`.** The step had not started yet, and a
single read needs an attempt to read: the engine creates `attempts/1/` when the step starts (SPEC
4.4), so a step whose dependency is still running has none. `--follow` is the answer — it waits for
the step to have an attempt and keeps reading until the step or the run is final. `--wait` avoids it
altogether. `--attempt 2` before a retry has started still answers this, and should: that attempt does
not exist yet.

**`block_not_found` when starting a pipeline through `curl`.** The API resolves `uses` against its own
staging directory, not your disk, and has no route that takes a directory of blocks. Publish the
blocks and store the pipeline first (step 2), then start it by name. This is the API's open item, not a
mistake in the command.

**`run_claimed` from `runs resume`.** An engine is already driving that run. The server resumes every
run still marked `running` when it starts, so a run left behind by a dead process is usually picked up
before you ask.

**`run_not_active` from `runs resume`.** The run has finished. Resume is only for a run left `running`
by an engine that died (SPEC 4.7). To go through a failed run again, use `runs retry`, which reuses the
same snapshots and the same work directories and starts the failed, skipped and cancelled steps over.

**You stopped the server mid-run and the run is stuck at `running`.** Start the server again: it takes
up every run still marked `running` before it serves anything, stops any block process the old one left
alive, and marks the interrupted attempt. That is SPEC 4.7, and it is the reason the data directory is
a volume in production and not an `emptyDir`.

**`uv` reaches for the network on the first run.** `count-words.sh` declares no dependencies, so it
needs none as long as a suitable Python is on `PATH`. If your `uv` has to download a Python first, that
is a one-time fetch into `$BASHREACTOR_HOME/home`, which is the cache every later run reuses.

**The demo's runs pile up.** `$BASHREACTOR_HOME/runs/` grows until you delete it. Deleting a run means
deleting its directory; nothing else is keeping an index of them.

## What this demo does not cover

- A cancel, and a timeout. Both are exercised by the engine's own tests; neither is a case
  `docs/examples/README.md` fixes expected results for, so there was nothing honest to compare to.
- A resume after a real engine death, as a scripted step. `apps/engine/test/restart.test.ts` does this
  with a real second process. Doing it from the outside means killing the server between two commands,
  which is a demo you watch, not one you script.
- Artifacts over HTTP. There is no route for them: nothing publishes run files into the store yet, so a
  route would answer empty. Step 6 reads them off the disk instead, which is where they are.
- A list of every block or pipeline, on any surface. See step 3.
