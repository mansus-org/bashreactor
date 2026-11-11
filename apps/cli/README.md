# Bashreactor CLI (BASHR-7)

One binary, `bashreactor`, that does everything the REST API does, from a shell, for a person or a
script. It talks to a deployment **over HTTP with a bearer token** and never opens the store or the
engine in-process: the API is the surface that enforces scopes and the only thing that knows where a
remote deployment keeps its runs.

```bash
bun apps/cli/src/bin.ts <command>      # in this repo
```

The package declares `bin: { bashreactor: ./src/bin.ts }`, so whatever installs it gets the name;
the entry point is TypeScript and needs `bun` to run it.

## Connection

A flag beats the environment beats a file, and `whoami` prints which of the three won.

| Setting | Flag | Environment | File |
| --- | --- | --- | --- |
| API URL | `--url` | `BASHREACTOR_URL` | `"url"` in `$BASHREACTOR_HOME/cli.json` |
| Token | `--token` | `BASHREACTOR_TOKEN` | `"token"` in the same file |

`$BASHREACTOR_HOME` defaults to `~/.bashreactor`, the one data directory of SPEC 1.4, so one
variable points the CLI, the API and the engine at the same place. The file is two settings and
nothing else; anything else in it is a usage error rather than a silently ignored key:

```json
{ "url": "https://bashreactor.example", "token": "br_…" }
```

Prefer the environment for a token: a flag shows up in `ps`. `whoami` never prints the whole token,
only enough of it to recognise:

```
$ bashreactor whoami
url    http://127.0.0.1:8080  (from BASHREACTOR_URL)
token  br_044c…d292  (from BASHREACTOR_TOKEN)
name   admin
scope  admin
admin  yes
```

## Commands

Every route in [`apps/api/README.md`](../api/README.md) is a command, and one command is one route.
`read`, `write` and `admin` are the access the API asks for; the CLI does not guess, it sends the
token and passes back whatever the API says.

| Command | Route | Access |
| --- | --- | --- |
| `health` | `GET /healthz` | none |
| `whoami` | `GET /v1/whoami` | read |
| `blocks ls` | `GET /v1/blocks` | read |
| `blocks ls <name>` | `GET /v1/blocks/:name` | read |
| `blocks get <name>` | `GET /v1/blocks/:name/:version` | read |
| `blocks content <name>` | `GET /v1/blocks/:name/:version/content` | read |
| `blocks add <name> <file>` | `POST /v1/blocks/:name/versions` | write |
| `pipelines ls` | `GET /v1/pipelines` | read |
| `pipelines ls <name>` | `GET /v1/pipelines/:name` | read |
| `pipelines get <name>` | `GET /v1/pipelines/:name/:version` | read |
| `pipelines validate <file>` | nothing: the file is checked here | none, or read for a `name@version` |
| `pipelines add <name> <file>` | `POST /v1/pipelines/:name/versions` | write |
| `runs ls` | `GET /v1/runs` | read |
| `runs start <pipeline\|file.yaml>` | `POST /v1/runs` | write |
| `runs get <id>` | `GET /v1/runs/:id` | read |
| `runs cancel <id>` | `POST /v1/runs/:id/cancel` | write |
| `runs retry <id>` | `POST /v1/runs/:id/retry` | write |
| `runs resume <id>` | `POST /v1/runs/:id/resume` | write |
| `runs rm <id>` | `DELETE /v1/runs/:id` | write |
| `runs logs <id> <step>` | `GET /v1/runs/:id/logs/:step/:attempt` | read |
| `disk` | `GET /v1/disk` | read |
| `tokens ls` | `GET /v1/tokens` | admin |
| `tokens add <name> --scope read\|write` | `POST /v1/tokens` | admin |
| `tokens revoke <id>` | `DELETE /v1/tokens/:id` | admin |

There is no command for a route that does not exist: no block or pipeline collection, no artifacts,
no run index over the store. Those are the API's open items, and a command that always answered
empty would be worse than no command.

## Flags

Global, on every command, before or after the command name:

| Flag | Does |
| --- | --- |
| `--json` | print the API's own JSON and nothing else on stdout |
| `--url <url>` | the API to talk to |
| `--token <token>` | the bearer token |
| `--help`, `-h` | the command table, or the one for a command |

On its own, with no command: `bashreactor --version` prints the CLI's version and exits 0, with no URL
and no token configured.

Per command:

| Flag | On | Does |
| --- | --- | --- |
| `--version <n\|latest>` | `blocks get`, `blocks content`, `pipelines get`, `runs start` | which version; the default is `latest` |
| `--pipeline <name>` | `runs ls` | only runs of that pipeline |
| `--status <s>[,<s>…]` | `runs ls` | only runs with any of these statuses: `running`, `succeeded`, `failed`, `cancelled` |
| `--since <instant>` | `runs ls` | only runs created at or after a UTC instant such as `2026-11-11T00:00:00Z` |
| `--limit <n>` | `runs ls` | how many runs to ask for; the default is 100 and the most is 500 |
| `--input <name>=<value>` | `runs start` | a run input, repeatable; read with the text form of SPEC 1.2 against the type the pipeline declares |
| `--wait` | `runs start` | poll until the run is final, and exit with its status |
| `--attempt <n>` | `runs logs` | which attempt to read; the default is the step's last one, and `--follow` without it reads them all, in order |
| `--offset <n>` | `runs logs` | the byte offset to start at; the default is 0 |
| `--follow` | `runs logs` | keep reading until the step or the run is final; exit 1 unless the step succeeded |
| `--interval <ms>` | `runs logs --follow`, `runs start --wait` | how long between polls; the default is 1000 |
| `--scope read\|write` | `tokens add` | what the token may do |

## Two output modes, chosen once

The default is for a person: aligned columns, no colour, no spinner, dates in local time, and a run
id that is never shortened, because it is the thing you copy into the next command.

```
$ bashreactor runs ls
RUN                        PIPELINE     VERSION  STATUS     STEPS  CREATED              FINISHED             TOOK
20261105T152616Z-4458ce1b  word-report  v3       succeeded  4/4    2026-11-05 16:26:16  2026-11-05 16:26:17  2s
```

`VERSION` is the stored pipeline version the run started from, or `-` for a run started from YAML
that was not stored. `STEPS` is `succeeded/total`.

`runs ls` takes the API's own filters, and they combine:

```bash
bashreactor runs ls --pipeline word-report --status failed,running
bashreactor runs ls --since 2026-11-11T00:00:00Z --limit 50
```

The values are passed through as query parameters, not checked a second time here: a malformed one
is the API's `type_mismatch` at exit 1, with the parameter as its `path`.

`--json` prints the API's own JSON, verbatim, one object or an array, one line, so `jq` works and
nothing is reformatted:

```
$ bashreactor runs get 20261105T152616Z-4458ce1b --json | jq -c '.status, .outputs'
"succeeded"
{"report":"steps/report/attempts/1/outputs/report","total_words":1950}
```

The mode is picked at the top of a command and a command cannot print both: `Printer.emit(value, human)`
either hands back the value or runs the human rendering, never both. Two routes are not JSON on the
wire and say so:

- `blocks content` writes the block's bytes to stdout, byte for byte. Under `--json` it prints
  `{name, version, sha256, content}`, with `version` resolved to a number even when you asked for
  `latest`.
- `runs logs --follow --json` prints one JSON object per chunk, newline-delimited, each with its own
  `attempt`, `offset` and `next_offset` — which is how a JSON reader is told an attempt has begun.

Notes about what a command did on your behalf (publishing a block, the next log offset) go to
stderr in both modes, so stdout stays the answer.

## Errors and exit codes

One function formats a failure, so no command can drift. A failure is docs/SPEC.md section 5's error
object — `code`, `message`, and `path`/`file` when present — on stderr and nothing else. Under
`--json` that object is the whole of stdout, so a script reads a failure and a success the same way.

```
$ bashreactor runs start word-report --input lines=abc   # the command line was wrong
{"code":"type_mismatch","message":"inputs.lines: not an integer","path":"inputs.lines"}
$ echo $?
2
$ bashreactor runs get 20261104T101500Z-3fa9c2d1         # the API said no
{"code":"run_not_found","message":"run \"20261104T101500Z-3fa9c2d1\" does not exist"}
$ echo $?
1
```

| Code | When |
| --- | --- |
| 0 | it ran |
| 1 | the API refused: its own code and message, passed through untouched. Also a run that ended `failed` or `cancelled` when you asked to wait for it or follow it, an invalid pipeline from `pipelines validate`, and a degraded `/healthz` |
| 2 | the command line was wrong: unknown command or flag, missing argument, a file that is not there, an `--input` value that does not fit the declared type, no URL or token configured, a config file that is not readable |

A wrong token and a wrong argument are visibly different: the first is the API's `unauthenticated`
at exit 1, the second is `invalid_argument` at exit 2 with nothing sent.

Every code it prints is in SPEC 5. `invalid_argument` is its own, for a command line that was wrong
before anyone was asked; a server that is not there at all is `api_unreachable`, the same code the
MCP server and the web UI print for it, and not `runtime_missing`, which is the engine saying a
runtime binary is missing. Everything else is the API's answer, passed through unchanged.

## Logs

A log is per attempt and is followed by byte offset (SPEC 4.8), which is what the API exposes and
what this CLI uses. A read prints the bytes from the offset and tells you the offset to come back
with:

```bash
bashreactor runs logs 20261105T152616Z-4458ce1b generate --attempt 1 --offset 47
```

```
pt 1: stopping after 120 lines, asking for a retry
next offset 98
```

`--follow` polls by offset until the step reaches a final status, or the run does. A step's log is
its attempts' logs in order (SPEC 4.8), so follow reads them that way: it drains the attempt it is
on, marks the next one with `==> attempt N <==` on stderr and starts it at byte 0. `--attempt` pins
one attempt and reads only that one, markers included. A step that has no attempt yet has not
started, so follow waits rather than taking the API's `attempt_not_found`. The exit code is 0 when
the step you followed succeeded and 1 when it ended any other way, even when the run around it is
still `running` and has decided nothing yet. There is no websocket: the offset is the cursor, and a
follower that dies loses nothing.

## Long runs

`runs start` returns as soon as the API answers 201, prints the run id and how to follow it, and
leaves. A six-hour block does not get to hold your terminal.

```
$ bashreactor runs start word-report --input lines=300
run       20261105T152616Z-4458ce1b
pipeline  word-report
status    running
…
follow it: bashreactor runs logs 20261105T152616Z-4458ce1b generate --follow
```

If you did want to wait, `--wait` polls until the run is final and its exit code is the run's
status, which is what a CI step wants.

## Room on the server

A run directory is never trimmed, so it is removed whole or it is still there: `runs rm <id>` deletes
one and everything it wrote, and answers `run_claimed` if an engine is still writing into it — cancel
it first. `disk` says how much room the server has left to write in, and exits 1 when it says `low`,
so a cron can watch it without reading prose:

```
$ bashreactor disk
path   /tmp/bashr42-disk.BmOQ4j
free   411 GB of 937 GB
used   525 GB  (56%)
runs/  22 KB
low    no
```

Keep the two kinds of number apart. `free` and `used` are the filesystem the server sits on, which on a
cluster is often the node's whole disk rather than the volume that was asked for; `runs/` is the run
directories and nothing else, and it is the one to watch against whatever size the deployment gave.

What removes runs by itself is `BASHREACTOR_RETENTION` on the server (apps/api/README.md, "Room to
write in"), off by default; the CLI never deletes anything it was not told to.

## A pipeline file on your disk

SPEC 3.4 resolves `uses: ./count-words.sh` against the directory holding the pipeline file, and the
API stages the YAML it is given into a directory of its own (apps/api/README.md, "Staging"), so a
relative reference from your laptop points at nothing there. The API has no route that takes a
directory, so `runs start` and `pipelines add` close the gap with the two routes that do exist: they
publish each block beside the file into the library and rewrite the reference to the `name@version`
the library answered with. The references are found by parsing the file, not by matching lines, so
`uses: "./x.sh"` and `a: { uses: ./x.sh }` are as good as the bare form (SPEC 3.1). Only the scalar
after `uses:` is replaced; every other byte of the file, comments, blank lines and the quoting of
every other value included, is sent as it was. A block is published under the name its header
declares, which SPEC 2.3 says need not be the filename.

The consequence is worth stating: what gets stored or started is the rewritten document, so a run
records `count-words@2` rather than `./count-words.sh`. The command says what it published, on
stderr:

```
$ bashreactor pipelines add word-report docs/examples/word-report.yaml
published docs/examples/generate-corpus.sh as generate-corpus@1
published docs/examples/check-corpus.sh as check-corpus@1
published docs/examples/count-words.sh as count-words@1
published docs/examples/render-report.sh as render-report@1
stored word-report@1  9f2c1a7d3b04
```

`pipelines validate` does none of this. SPEC 3.9 says validation "runs over the pipeline and the
headers of all blocks it references, and creates nothing", so it is checked here, over the file on
your disk, with the same validator the engine runs: a `uses: ./block.sh` is read from beside the
file and a `name@version` is read from the library with one GET. That needs no write token, and a
file whose blocks are all beside it needs no token at all.

```
$ bashreactor pipelines validate docs/examples/word-report.yaml
valid  docs/examples/word-report.yaml
```

A pipeline that already uses library references is sent untouched by `add` and `runs start`. A
`uses:` whose file is not there is left alone, so the answer is the engine's own `block_not_found`
and not a message invented here.

## Worked example

The pipeline of [`docs/examples/`](../../docs/examples/README.md), from a clean deployment. The
server is the one from `apps/api` (`bun apps/api/src/main.ts`), and the CLI is told where it is and
who it is:

```bash
export BASHREACTOR_URL=http://127.0.0.1:8080
export BASHREACTOR_TOKEN=$BASHREACTOR_ADMIN_TOKEN

bashreactor pipelines validate docs/examples/word-report.yaml
# valid  docs/examples/word-report.yaml        (nothing is published: SPEC 3.9)

bashreactor runs start docs/examples/word-report.yaml --input lines=300 --input seed=11 --input title=Other
```

```
run       20261105T152616Z-4458ce1b
pipeline  word-report
status    running
created   2026-11-05 16:26:16
finished  -
took      -

STEP      STATUS   ATTEMPTS  NEEDS                 FAILURE
generate  pending  0         -                     -
check     pending  0         generate              -
count     pending  0         generate              -
report    pending  0         generate,check,count  -

inputs
lines  300
seed   11
title  Other

started docs/examples/word-report.yaml
follow it: bashreactor runs logs 20261105T152616Z-4458ce1b generate --follow
```

Follow the first step. Attempt 1 stops at line 120 and asks for a retry (SPEC 2.8, exit 75), so the
step is not final until attempt 2 has carried on from the work directory; `--follow` keeps reading
until it is:

```bash
bashreactor runs logs 20261105T152616Z-4458ce1b generate --follow
```

```
==> attempt 1 <==
attempt 1: 0 of 300 lines already written
attempt 1: stopping after 120 lines, asking for a retry
==> attempt 2 <==
attempt 2: 120 of 300 lines already written
attempt 2: corpus finished
next offset 71
run 20261105T152616Z-4458ce1b running
```

The run is still going, because `generate` is only one of four steps, and the step you followed
succeeded, so the exit code is 0. Follow the last one, and when it is final the run is final, so the
exit code is the run's:

```bash
bashreactor runs logs 20261105T152616Z-4458ce1b report --follow; echo $?
```

```
==> attempt 1 <==
render-report: 157 bytes
next offset 25
run 20261105T152616Z-4458ce1b succeeded
0
```

And the whole thing, for a person or for `jq`:

```bash
bashreactor runs get 20261105T152616Z-4458ce1b
```

```
run       20261105T152616Z-4458ce1b
pipeline  word-report
status    succeeded
created   2026-11-05 16:26:16
finished  2026-11-05 16:26:17
took      2s

STEP      STATUS     ATTEMPTS  NEEDS                 FAILURE
generate  succeeded  2         -                     -
check     succeeded  1         generate              -
count     succeeded  1         generate              -
report    succeeded  1         generate,check,count  -

inputs
lines  300
seed   11
title  Other

outputs
report       steps/report/attempts/1/outputs/report
total_words  1950
```

```bash
bashreactor runs get 20261105T152616Z-4458ce1b --json | jq -c '.outputs'
# {"report":"steps/report/attempts/1/outputs/report","total_words":1950}
```

## Tests

`bun test` in this package. Every test runs `apps/cli/src/bin.ts` as a real subprocess against a
real API over a real socket, started the way `apps/api/test/server.test.ts` starts it, and asserts
on stdout, stderr and the exit code. The environment of every run is built from nothing, so a
developer's own `BASHREACTOR_URL` or `~/.bashreactor/cli.json` cannot decide what a test sees.

The server is started as a subprocess rather than imported, because importing `@bashreactor/api`
from this package would put the API, the engine and the store on the CLI's import graph — the one
thing this task must not do.

## Open items

- **A pipeline directory needs one route.** `POST /v1/pipelines` that took the file and its blocks
  would let the CLI stop publishing and rewriting (see "A pipeline file on your disk"). The engine
  taking a block resolver, which apps/api already lists, is the same gap from the other side.
- **No `bashreactor config` command.** The config file is read, never written: `tokens add` prints a
  token and leaves it to you to put it in the file. Writing it needs a decision about a file that
  holds a secret (its mode, and where it goes when `BASHREACTOR_HOME` is a volume).
- **`--follow` is a poll.** The offset cursor makes it correct and it costs one request per interval;
  a websocket would need the API to have one first.
