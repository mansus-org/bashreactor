# Bashreactor specification (BASHR-1)

Version 1. This is the source of truth for the block format, the pipeline YAML and how an engine
runs them. Everything else in the repo follows it. If a task needs a decision that is not here, make
the decision and write it here.

MUST and MUST NOT are binding. Lines starting with *Rejected:* record the option not taken and why.

The worked example in [`docs/examples/`](examples/README.md) follows this document line by line, and
the engine's tests run it.

Contents:

1. [Shared definitions](#1-shared-definitions)
2. [Block format](#2-block-format)
3. [Pipeline YAML](#3-pipeline-yaml)
4. [Execution](#4-execution)
5. [Errors](#5-errors)
6. [Out of scope for version 1](#6-out-of-scope-for-version-1)
7. [Worked example](#7-worked-example)

---

## 1. Shared definitions

### 1.1 Names

| Thing | Regex |
| --- | --- |
| Block name, pipeline name | `^[a-z][a-z0-9-]{0,63}$` |
| Input name, output name, step id | `^[a-z][a-z0-9_]{0,63}$` |

Input and output names are lowercase only, so turning them into uppercase env var names can never
make two of them collide.

### 1.2 Types

Every input and output has exactly one of six types.

| Type | Holds | How it reaches a script | Size limit |
| --- | --- | --- | --- |
| `string` | UTF-8 text without NUL | the text | 64 KiB |
| `integer` | a whole number between -(2^53 - 1) and 2^53 - 1 | decimal digits | n/a |
| `number` | a finite IEEE 754 double | decimal text | n/a |
| `boolean` | true or false | `true` or `false` | n/a |
| `json` | any JSON value | compact JSON text | 64 KiB |
| `file` | a regular file of any size and content | the absolute path to it | none |

There is no null, no list type and no directory type. A list is `json`. A directory is a tarball in
a `file`. A block that has nothing to report writes an empty string, `[]` or an empty file.

*Rejected: a `dir` type.* A directory cannot be made read-only or measured by one `lstat`, and `tar`
is always available.
*Rejected: a null value.* Every consumer of every output would have to handle it.

**Rendering** turns a value into the text a script sees in its environment:

| Type | Rendering |
| --- | --- |
| `string` | the string itself |
| `integer`, `number` | ECMAScript `String(value)`: `1.50` renders as `1.5`, `1e21` as `1e+21` |
| `boolean` | `true` or `false` |
| `json` | ECMAScript `JSON.stringify(value)`: no whitespace, key order preserved |
| `file` | the absolute path of the file |

**Text form** is how a value is read from bytes. It applies to output files
([section 2.5](#25-outputs)) and to `--input name=value` on the CLI. First remove one trailing `\n`
if there is one (only one, and not a `\r`). Then:

| Type | The remaining bytes must be | Value |
| --- | --- | --- |
| `string` | valid UTF-8, no NUL, at most 65536 bytes | the text; empty is valid |
| `integer` | `^-?(0\|[1-9][0-9]*)$`, and within the integer range | the number |
| `number` | `^-?(0\|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`, and finite as a double | the number |
| `boolean` | exactly `true` or `false` | the boolean |
| `json` | at most 65536 bytes that `JSON.parse` accepts | the parsed value |
| `file` | not applicable, see [section 2.5](#25-outputs) | |

Removing one trailing newline means `echo 42 > "$OUTPUT_X"` and `printf 42 > "$OUTPUT_X"` mean the
same.

**Literal rule** is how a value written in YAML is checked against a type. YAML numbers are compared
by value, so `5.0` is an acceptable integer.

| Type | Accepted YAML value |
| --- | --- |
| `string` | a YAML string. `5` is rejected: quote it as `"5"` |
| `integer` | a YAML number for which `Number.isSafeInteger` is true |
| `number` | a finite YAML number |
| `boolean` | a YAML boolean |
| `json` | any value representable in JSON, including null |
| `file` | none. A `file` value cannot be written in YAML |

*Rejected: coercing YAML scalars to strings as GitHub Actions does.* `version: 1.10` would silently
reach the script as `1.1`.

### 1.3 Durations

A duration is a YAML string matching `^([0-9]+d)?([0-9]+h)?([0-9]+m)?([0-9]+s)?$` and not empty. For
example `90s`, `1h30m`, `2d`. A day is 86400 seconds. The units must appear in this order.

*Rejected: bare integers of seconds.* `timeout: 3600` does not say its unit in the file.

### 1.4 Data directory

All engine state lives under `$BASHREACTOR_HOME`, default `~/.bashreactor`. In production this MUST
be a persistent volume, because resuming after a restart depends on it.

A container image MUST create that directory, hand it to the uid the image runs as, and set
`$BASHREACTOR_HOME` to it. A uid with no entry in `/etc/passwd` has no home to fall back on, and the
default then resolves to a path it cannot create.

*Rejected: starting anyway without a writable data directory.* Every route would fail on its first
write. The server degrades instead, [section 1.5](#15-health).

### 1.5 Health

`GET /healthz` is unauthenticated and answers 200 with `{"status":"ok","version":"<version>"}`, the
version being `$BASHREACTOR_VERSION` where that is set.

A server that could not build itself — a data directory it cannot write, a store that will not open —
MUST still listen: `/healthz` then answers 200 with
`{"status":"degraded","version":"<version>","problem":"<message>"}` and every other route answers 503
with the [section 5](#5-errors) error object. The probe is the only window a preview deployment gets
into a container that will not come up, and a refused connection tells nobody anything.

*Rejected: a failing status on a degraded `/healthz`.* The reason is in the body, and a probe that
hides its body is not worth having.

`/healthz` is readiness and nothing else. It MUST NOT report free disk: a full volume is not something
a restart fixes, and pulling a pod out of rotation with a run mid-flight to say something that was
already true is worse than the problem. The number is `GET /v1/disk`,
[section 4.11](#411-keeping-a-run-and-letting-it-go).

---

## 2. Block format

A block is a single bash file. It runs with plain `bash`, it needs no execute bit and it has no
sidecar files.

*Rejected: a block as a directory.* Versioning would need a tree hash, and a heredoc already holds
the Python or TypeScript in the file ([section 2.7](#27-calling-uv-and-bun)).

The identity of a block version is the SHA-256 of the file's exact bytes.

### 2.1 Where the declaration sits

The declaration is a YAML document inside a comment header at the very top of the file:

```bash
#!/usr/bin/env bash
# ---
# name: fetch-dataset
# description: Download a dataset and report its size.
# inputs:
#   url:
#     type: string
#     description: Where to download from.
#   attempts:
#     type: integer
#     default: 3
# outputs:
#   dataset:
#     type: file
#   bytes:
#     type: integer
# ---

curl --fail --silent --show-error --retry "$INPUT_ATTEMPTS" --output "$OUTPUT_DATASET" "$INPUT_URL"
wc -c < "$OUTPUT_DATASET" > "$OUTPUT_BYTES"
```

Because the header is comments, the file is valid bash with no processing.

*Rejected: a sidecar `block.yaml`.* The two files drift, and a block stops being one thing to copy.
*Rejected: `# @input name type default` annotations.* That is a second grammar to specify, and
defaults for `json` do not fit on it.
*Rejected: declaring with bash variables.* Reading the declaration would mean running untrusted
code.

### 2.2 How the header is parsed

Parsing never executes the file. Split the bytes on `\n` and apply these steps:

1. Line 1 MUST be exactly `#!/usr/bin/env bash`.
2. Line 2 MUST be exactly `# ---`.
3. Starting at line 3, take lines until the first line that is exactly `# ---`. If there is no such
   line, the header is malformed.
4. Each line taken MUST be exactly `#` (which becomes an empty line) or start with `# ` (which is
   removed). Anything else is malformed.
5. Join the results with `\n` and parse them under the YAML rules of
   [section 3.1](#31-parsing). The result MUST be a mapping.

The header must be valid UTF-8. The rest of the file is opaque bytes. A file with CRLF line endings
fails step 1.

Any failure here is `block_header_malformed`.

### 2.3 Header schema

| Key | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `name` | block name | yes | | Shown in the UI. Need not match the filename. |
| `description` | string | no | `""` | One line for people and agents. |
| `inputs` | mapping of input name to input | no | `{}` | |
| `outputs` | mapping of output name to output | no | `{}` | |

An **input** is a mapping:

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `type` | one of the six types | yes | |
| `description` | string | no | |
| `default` | a value of `type` under the literal rule | no | Having a `default` is what makes an input optional. |

An input of type `file` MUST NOT have a `default`.

An **output** is a mapping:

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `type` | one of the six types | yes | |
| `description` | string | no | |

Every declared output is required. The declaration order of inputs and outputs is preserved, and
the UI shows them in that order.

Anything else is `block_schema_invalid`: an unknown key at any level, a value of the wrong type, a
name that does not match its regex, a `default` that fails the literal rule, a `file` input with a
`default`, or `inputs:` left empty (YAML reads that as null, not as an empty mapping).

### 2.4 How inputs reach the script

Inputs arrive as **environment variables only**. Each declared input is set as
`INPUT_<NAME>`, where `<NAME>` is the input name in uppercase, to the rendering of its value. A
`file` input holds the absolute path.

Every declared input is always set, with its default if the pipeline did not provide it, and the
script runs under `set -u`, so a typo stops the script rather than reading an empty string.

Bash scripts MUST quote them: `"$INPUT_URL"`. Python and TypeScript read them from the environment,
and MUST NOT splice them into a heredoc.

Linux limits one environment string to 128 KiB. So:

- a rendered `string` or `json` value MUST be at most 65536 bytes,
- all rendered inputs of a step together MUST be at most 1 MiB.

Breaking either fails the step with `input_too_large` before it starts. Large data belongs in a
`file`.

*Rejected: inputs as files.* Every script would start with `$(cat ...)`, which is also where trailing
newlines get lost.
*Rejected: both env and files.* Two sources of truth for one value, and the 128 KiB limit stays
for whoever uses env.

### 2.5 Outputs

Stdout and stderr are logs and carry no values. Each output is **one file**.

For each declared output, the engine sets `OUTPUT_<NAME>` to an absolute path inside the attempt's
outputs directory, which exists and is empty when the script starts. The file itself does not exist
yet. The script creates it:

```bash
echo 42 > "$OUTPUT_BYTES"
mv dataset.tar "$OUTPUT_DATASET"
```

The outputs directory and the work directory are on one filesystem, so `mv` is a rename.

The engine reads output files only after the script has exited 0. It looks at them in declaration
order, and the first failure decides the code:

1. If the path does not exist, the attempt fails with `output_missing`.
2. If `lstat` does not report a regular file, the attempt fails with `output_invalid`. Symlinks and
   directories are invalid, because an artifact must live inside the run.
3. For any type except `file`, parse the bytes with the text form of
   [section 1.2](#12-types). A value over the size limit fails with `output_too_large`. Any other
   parse failure is `output_invalid`.

**Publishing is all or nothing.** If every output is valid, all of them become visible to later
steps at once, and each `file` output is set to mode `0444`. If any is not valid, none are published.

**Partial output.** After a failed, timed out, cancelled or interrupted attempt the files stay in
that attempt's directory for debugging, and they are never published and never visible to another
step. Each attempt starts with a new, empty outputs directory. Work that should survive into the
next attempt belongs in the work directory ([section 2.6](#26-runtime-contract)).

Files in the outputs directory that were not declared are ignored.

A published `file` is passed to later steps by path, not copied, so a many-gigabyte artifact costs
nothing to pass along. A block MUST NOT change an input file; mode `0444` catches accidents and is
not a security boundary.

*Rejected: one `$GITHUB_OUTPUT`-style `key=value` file.* Multi-line values need a delimiter syntax,
and there is no way to write a many-gigabyte value.
*Rejected: printing a JSON object on the last line of stdout.* Any tool that prints to stdout can
corrupt it, and logs stop being logs.

### 2.6 Runtime contract

**Interpreter.** The engine starts this exact command, using the first `bash` on its own `PATH`:

```
bash -euo pipefail <path of the block's snapshot>
```

There are no further arguments. The shebang is not used, so the file needs no execute bit.

*Rejected: leaving `set -euo pipefail` to each author.* A block that forgets it reports success after
a failed command, hours later. A block can still say `set +e` where it wants to.

**Process.** The script is the leader of a new session and process group (`setsid`). Its process
group id is its pid. The engine waits on it.

**Stdin** is `/dev/null`.

**Stdout and stderr** are both the attempt's log file, inherited directly as file descriptors 1 and 2
([section 4.8](#48-logs)).

**Cwd** is the step's work directory, `steps/<step id>/work/` inside the run. It is created empty the
first time the step starts and **survives every retry and every engine restart** of that step. This is
how a long block resumes: it writes its progress in cwd and looks for it on start. A block that needs
a clean start on every attempt clears cwd itself. Work directories of different steps are separate.

*Rejected: a fresh cwd per attempt plus a separate checkpoint directory.* Two directories to learn,
when `curl -C -` and `rsync --partial` just work if cwd persists.

**Environment.** The engine does not inherit its environment into the script. The script sees exactly
these variables and no others:

| Variable | Value |
| --- | --- |
| `PATH` | the engine's own `PATH`, verbatim |
| `HOME` | `$BASHREACTOR_HOME/home`, created if missing, shared by all runs |
| `TMPDIR` | `tmp/` in the attempt's directory, created empty, deleted when the attempt ends |
| `LANG`, `LC_ALL` | `C.UTF-8` |
| `TZ` | `UTC` |
| `PYTHONUNBUFFERED` | `1`, because Python block-buffers a log file and live logs would lag by hours |
| `NO_COLOR` | `1` |
| `BR_RUN_ID` | the run id |
| `BR_STEP_ID` | the step id |
| `BR_ATTEMPT` | the attempt number, starting at 1, see [section 4.5](#45-retries) |
| `INPUT_<NAME>` | one per declared input |
| `OUTPUT_<NAME>` | one per declared output |
| anything in `pass_env` | copied from the engine's environment ([section 3.4](#34-step)) |

`HOME` is the persistent cache location: uv and bun keep downloads under it, so they are reused across
runs and across restarts. Blocks MUST NOT keep state in `HOME`.

*Rejected: inheriting the engine's environment.* API tokens would leak into every block.
*Rejected: the engine's own `HOME`.* It exposes the engine's credentials, and in a container it is not
on a volume.

**Secrets** reach a block through `pass_env` only. Inputs are recorded in `run.json` in clear text, so
a secret MUST NOT be passed as an input.

**What is on `PATH`.** A server MUST check, at startup and before it serves anything, that each of
these resolves on the `PATH` it will hand a block, and answer `runtime_missing` if any of them does
not:

`bash` (5 or newer), `uv`, `bun`, `awk`, `curl`, `grep`, `gzip`, `jq`, `sed`, `tar`, and coreutils, which
the check takes to be present if `cat`, `mv` and `wc` are.

The refusal takes the [section 1.5](#15-health) form rather than an exit: the process binds its
socket anyway, `/healthz` answers `degraded` with the missing binaries named in `problem`, and every
other route answers 503 `runtime_missing`. A container that refuses the connection tells the
orchestrator nothing and the person reading the probe nothing either; one that says `degraded` says
which package its image is short. The check is made once per process and is not repeated, so the fix
is a new container, not a repaired one. An engine checks the same list again when it is asked to start
a run: that is what catches a runtime that went away after the process came up, and what covers an
engine built with no server in front of it.

`python3` and `node` are not guaranteed. A block that needs them goes through uv or bun.

*Rejected: a fixed PATH such as `/usr/bin:/bin`.* It does not exist on NixOS.
*Rejected: exiting the process when a runtime is missing.* Section 1.5: the probe is the only window a
preview deployment gets into a container that will not come up, and an exit spends it.

### 2.7 Calling uv and bun

A block is always bash. Python and TypeScript sit inside it as a **quoted heredoc**, so bash expands
nothing, and the interpreter reads the program from stdin. These two forms are the contract, and the
worked example uses them:

```bash
uv run --quiet --no-project --script - <<'PY'
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests==2.32.3"]
# ///
import os
import requests
open(os.environ["OUTPUT_STATUS"], "w").write(str(requests.get(os.environ["INPUT_URL"]).status_code))
PY
```

```bash
bun run - <<'TS'
import isOdd from "is-odd@3.0.1";
await Bun.write(process.env.OUTPUT_ODD!, String(isOdd(Number(process.env.INPUT_N!))));
TS
```

- **Python.** The interpreter is whichever one uv picks for `requires-python`, which a block MUST
  state. `--script` makes uv read dependencies from the inline
  [PEP 723](https://peps.python.org/pep-0723/) comment and build a throwaway environment.
  `--no-project` stops uv from looking for a `pyproject.toml` in cwd. `--quiet` keeps uv's own progress
  out of the log.
- **TypeScript and JavaScript.** The interpreter is the `bun` on `PATH`. Packages are imported with
  an exact version in the specifier, and bun installs them on first use. There is no `package.json`.
- Both inherit cwd, the log file and the whole environment, including `INPUT_*`, `OUTPUT_*` and `BR_*`.
  Their stdin is the program, so they cannot read anything else from it. Both run in the block's process
  group, so a timeout reaches them.
- Both pass the program's exit code through, and `set -e` then ends the block with that same code. So
  `sys.exit(75)` and `process.exit(75)` ask for a retry ([section 2.8](#28-exit-codes-and-errors)).
- Steps may need the network the first time a dependency appears. The cache in `HOME` serves it after
  that. A block with no dependencies needs no network, provided a suitable Python is on `PATH`.

Pin dependencies to exact versions, because a retry after a restart may run days after attempt 1.

*Rejected: `python3` or `node` directly.* There would be no dependency story and no version control.
*Rejected: sidecar `.py` and `.ts` files beside the block.* A block is one file
([section 2](#2-block-format)).

### 2.8 Exit codes and errors

When the script (the process group leader) ends, the attempt ends. The first row that matches decides
the outcome:

| # | Condition | Attempt status | Code | Can retry |
| --- | --- | --- | --- | --- |
| 1 | A cancel reached this attempt before the script ended | `cancelled` | `cancelled` | no |
| 2 | The `timeout` expired before the script ended | `failed` | `timeout` | yes |
| 3 | The script died from a signal | `failed` | `killed_by_signal` | yes |
| 4 | Exit 75 | `failed` | `retry_requested` | yes |
| 5 | Exit 78 | `failed` | `block_fatal` | no |
| 6 | Any other non-zero exit | `failed` | `exit_nonzero` | yes |
| 7 | Exit 0, and an output is not valid | `failed` | `output_missing`, `output_invalid` or `output_too_large` | no |
| 8 | Exit 0, and every output is valid | `succeeded` | | |

Exit 75 is `EX_TEMPFAIL` from `sysexits.h` and is how a block says **"retry me"**. Exit 78 is how a
block says **"do not bother"**: bad input, or a condition another attempt cannot fix. Other non-zero
exits mean an unexpected failure and are retried, because the pipeline author asked for that by
setting `max_attempts`. Output failures are not retried, because a block that exits 0 with the wrong
outputs has a bug, and repeating it could waste hours.

A child killed by a signal, while bash lives on to report it, is an ordinary exit `128+n` and falls
under row 6. Row 3 applies only when the bash process itself died from a signal.

Retry is only ever possible while the budget lasts. Exit 75 with `max_attempts: 1` fails the step with
`retry_requested`.

An engine restart is not an attempt outcome; see [section 4.7](#47-restart-and-resume).

*Rejected: writing "retry" to a status file.* A process that crashed cannot write a file, and exit
codes already work through `uv`, `bun` and `set -e`.

### 2.9 What a timeout kills

When a step's `timeout` expires or a run is cancelled:

1. The engine sends SIGTERM to the process group (`kill(-pgid, SIGTERM)`).
2. It waits up to `kill_grace`.
3. If the leader is still running, it sends SIGKILL to the process group.

So the timeout reaches bash, `uv`, Python, `bun` and all their children. A block MAY `trap` TERM to
save progress in cwd within `kill_grace`. SIGTERM goes to the foreground child as well, and bash runs the
trap only once that child has ended.

Once SIGTERM has been sent, the script's exit code decides nothing, even if it exits 0. A cancel that
arrives while a timeout is already in its grace period still makes the attempt `cancelled`, by row 1 of
[section 2.8](#28-exit-codes-and-errors).

**Whenever the leader ends, for any reason**, the engine at once sends SIGKILL to the process group,
so stray background children do not outlive the attempt. A block that wants to wait for a background
job calls `wait`.

The kill does not reach a process that left the group (`setsid`, a daemon), and it does not reach
remote work the block started. Blocks MUST NOT leave the group.

*Rejected: cgroups.* They need privileges that the container and a laptop do not have.

---

## 3. Pipeline YAML

The shape follows GitHub Actions: a mapping of steps with `uses`, `needs` and `with`, and `${{ }}`
expressions.

### 3.1 Parsing

- The file is UTF-8 and holds one YAML 1.2 document, read with the core schema. So `yes` is a string
  and there are no timestamps.
- A duplicate mapping key is an error. The parser MUST detect it and MUST NOT let the last one win.
- Mapping order is preserved, and "declaration order" below means this order.
- Merge keys (`<<`) are not supported. `<<` is an unknown key, and so an error.
- Unknown keys are an error at every level. There is no `x-` escape. Comments are the way to annotate.

An implementation MUST use a parser that does this. The `yaml` npm package does, when called as
`parse(text, { version: "1.2", schema: "core", merge: false })`. `Bun.YAML` does not (checked on bun
1.3.13): it lets the last duplicate key win, returns an array for several documents, applies `<<`, and
turns `with: {a: ${{ x }}}` into garbage with no error.

An expression needs no quotes in block style (`lines: ${{ inputs.lines }}`). It MUST be quoted inside a
flow mapping, or if the value contains `: ` (`title: "${{ inputs.a }}: ${{ inputs.b }}"`), because plain
YAML rejects those.

Any YAML syntax error, multiple documents, or duplicate key in a pipeline is
`pipeline_yaml_invalid`. Block headers obey the same rules, and there the code is
`block_header_malformed`.

### 3.2 Top level

The smallest valid pipeline:

```yaml
name: hello
steps:
  greet:
    uses: ./greet.sh
```

| Key | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `name` | pipeline name | yes | | |
| `description` | string | no | `""` | |
| `max_parallel` | integer, 1 or more | no | `4` | The most steps of one run in `running` at the same time. |
| `inputs` | mapping of input name to input | no | `{}` | What a run is given ([section 3.3](#33-pipeline-inputs)). |
| `steps` | mapping of step id to step, at least one | yes | | [Section 3.4](#34-step). |
| `outputs` | mapping of output name to expression | no | `{}` | What a run returns ([section 3.8](#38-pipeline-outputs)). |

*Rejected: `steps` as a list of objects with an `id`.* A mapping is GitHub's `jobs` shape and makes
duplicate ids a parse error instead of one more rule.
*Rejected: an `on:` trigger.* A run is started by the CLI, the API or an agent.

### 3.3 Pipeline inputs

Each entry has exactly the same schema as a block input ([section 2.3](#23-header-schema)): `type`,
`description`, `default`, with the same rule that a `file` input has no default.

A run is started with a mapping of input name to value:

- Over the API and MCP, it is a JSON object, and values are checked with the literal rule.
- On the CLI, `--input name=value` is read with the text form.
- For a `file` input the value is a path to a regular file on the engine's filesystem. Over the API and
  MCP it MUST be absolute. The CLI makes a relative one absolute against its own cwd. The engine copies
  the file to `inputs/<name>` in the run at mode `0444`, so the run does not depend on the original.

Before any run exists, the engine rejects an unknown name with `unknown_input`, an absent input with no
default with `missing_input`, a wrong value with `type_mismatch`, and a path that is not a regular file
with `file_input_not_found`. The `path` of each of these errors is `inputs.<name>`.

### 3.4 Step

```yaml
steps:
  report:
    name: Render the report
    uses: ./render-report.sh
    needs: [check]
    with:
      title: "${{ inputs.title }}: ${{ steps.generate.outputs.line_count }} lines"
      counts: ${{ steps.count.outputs.counts }}
    pass_env: [SSL_CERT_FILE]
    timeout: 10m
    kill_grace: 30s
    retry:
      max_attempts: 3
      delay: 1m
```

The mapping key is the step id.

| Key | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `name` | string | no | the step id | Display name. |
| `uses` | block reference | yes | | The block to run, [below](#block-references). |
| `needs` | list of step ids, no repeats | no | `[]` | Steps that must succeed first, whether or not data flows from them. |
| `with` | mapping of input name to value or expression | no | `{}` | The block's inputs, [section 3.7](#37-binding-with-to-block-inputs). |
| `pass_env` | list of env var names, no repeats | no | `[]` | Variables copied from the engine's environment into this step. |
| `timeout` | duration, above zero | no | `24h` | The limit for **one attempt**. |
| `kill_grace` | duration | no | `30s` | Time between SIGTERM and SIGKILL. |
| `retry` | retry | no | `{max_attempts: 1}` | [Section 3.5](#35-retry). |

Every attempt has a timeout, so nothing can hang forever. A job longer than a day sets a longer one.

*Rejected: a timeout that spans all attempts.* The last attempt's budget would depend on how the
earlier ones went.

Names in `pass_env` MUST match `^[A-Za-z_][A-Za-z0-9_]*$`. They MUST NOT start with `BR_`, `INPUT_`,
`OUTPUT_` or `BASHREACTOR_` (those four prefixes are compared case-insensitively), and MUST NOT be
`PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `TZ`, `PYTHONUNBUFFERED`, `NO_COLOR` or `PORT`. The
`BASHREACTOR_` prefix is the server's own namespace, and `PORT` is its own configuration: whatever
the server reads out of its environment, admin and scoped tokens included, is never inheritable by a
step. A name that is not set in the engine's environment fails with `env_missing`. This is
checked before the run is created, so a missing token does not surface hours in, and again before each
attempt, because the engine may have restarted with a different environment. Only names are ever
recorded, never values.

#### Block references

`uses` takes one of two forms:

| Form | Regex | Resolved by |
| --- | --- | --- |
| Path | `^\.\.?/` | A path relative to the directory holding the pipeline file. |
| Library | `^[a-z][a-z0-9-]{0,63}@[1-9][0-9]*$` | The block library in `packages/store`: block name and version number. |

Anything else, including an absolute path, is `pipeline_schema_invalid`. A library reference always
names a version. A reference that cannot be resolved, or an engine with no library configured, gives
`block_not_found`. For a library reference, the `name` in the header MUST equal the name in the
reference. Otherwise the code is `block_schema_invalid`.

The library numbers versions per block name, starting at 1. A new version exists only if the SHA-256
differs from the latest one.

*Rejected: floating references such as `name@latest`.* A pipeline would change meaning when somebody
else edits a block.

### 3.5 Retry

| Key | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `max_attempts` | integer, 1 or more | no | `1` | Attempts that may count against the budget, the first one included. |
| `delay` | duration | no | `30s` | Wait before the first retry. |
| `backoff` | number, 1 or more | no | `2` | Each later wait is multiplied by this. |
| `max_delay` | duration, not below `delay` | no | the larger of `1h` and `delay` | The longest wait. |

After the `k`-th counted failure the wait is `min(max_delay, delay * backoff^(k-1))`, with no jitter.

*Rejected: jitter.* Retries here are per step in one run, and a wait that can be predicted is easier to
read in a run view and to test.
*Rejected: a `retry.on` list of causes.* [Section 2.8](#28-exit-codes-and-errors) already sorts causes
into retryable or not, and a block has exit 78 when it knows better.

### 3.6 Expressions

An expression is one of two references and nothing else, with no functions or operators:

```
${{ inputs.<input name> }}
${{ steps.<step id>.outputs.<output name> }}
```

The exact regex, with spaces and tabs allowed inside the braces:

```
\$\{\{[ \t]*(inputs\.[a-z][a-z0-9_]{0,63}|steps\.[a-z][a-z0-9_]{0,63}\.outputs\.[a-z][a-z0-9_]{0,63})[ \t]*\}\}
```

Expressions are read in two places only: the top-level string values of `with`, and the values of the
top-level `outputs`. Everywhere else `${{` is plain text. That includes strings nested inside a `json`
literal, and `default` values.

In the places where they are read, every `${{` MUST start a match of the regex. Otherwise the code is
`expression_invalid`. There is no escape syntax: to pass the literal text `${{` to a block, make it the
`default` of an input or a run input.

*Rejected: functions, conditionals and arithmetic.* That needs a small language in core, and a bash
block can already compute whatever it needs.
*Rejected: expressions in `timeout`, `uses` and the like.* They would make the graph and limits unknown
until the run reaches them.

A value in `with` has one of three shapes:

| Shape | Definition |
| --- | --- |
| Literal | Not a string, or a string with no `${{` |
| Whole | A string that is exactly one expression, nothing before or after |
| Template | A string with at least one expression and anything else |

### 3.7 Binding `with` to block inputs

Types are checked at validation, before anything runs, using the block headers.

- A **literal** is checked with the literal rule against the input's type.
- A **whole** expression of source type S may target input type T if:
  - S and T are the same, or
  - S is `integer` and T is `number`, or
  - T is `string` and S is `integer`, `number` or `boolean`. The value becomes its rendering.
- A **template** has type `string`, so T MUST be `string`. Each expression in it MUST have source type
  `string`, `integer`, `number` or `boolean`, and each is replaced by its rendering. There is no way
  to embed a `json` or `file` value in a template.

Anything else is `type_mismatch`.

*Rejected: allowing `file` to `string`, so a script receives a path as text.* Only the input type tells
the engine and the UI that a value is a file.

Binding happens once, when the step first becomes eligible to start, and its result is stored in
`run.json`. Retries and restarts reuse it. A block input absent from `with` takes its `default`. All
values are then checked against the limits in [section 2.4](#24-how-inputs-reach-the-script).

**Dependencies.** The effective dependencies of a step are its `needs` plus every step named by an
expression in its `with`. So a forgotten `needs` can never make a value unavailable. `needs` is only
required for ordering when no data flows, as with `report` and `check` in the worked example.

*Rejected: GitHub's rule that a referenced job must also be in `needs`.* A rule whose only effect is to
produce an error for something the engine can work out.

### 3.8 Pipeline outputs

Each value in the top-level `outputs` MUST be a whole expression of the form
`steps.<step id>.outputs.<output name>`, otherwise `expression_invalid`. Its type is the source's type.
They add no dependencies, because they are computed once the run has succeeded, and stored in
`run.json`. A run that did not succeed has `outputs: null`.

Each step's outputs are also available individually, whatever the run's status is.

### 3.9 What is invalid

Validation runs over the pipeline and the headers of all blocks it references, and creates nothing.
It reports **every** rule that is broken, not only the first. A rule that depends on something already
broken (for example a type check on a step whose block did not load) is not evaluated.

| Rule | Code | `path` points to |
| --- | --- | --- |
| The file is not one valid YAML document, or has a duplicate key | `pipeline_yaml_invalid` | absent |
| A key is unknown, required and absent, or of the wrong type, at any level | `pipeline_schema_invalid` | the key |
| A name, step id, or `pass_env` entry breaks its rule | `pipeline_schema_invalid` | the key |
| A duration does not match, `timeout` is zero, or `max_delay` is below `delay` | `pipeline_schema_invalid` | the key |
| `max_parallel`, `max_attempts` or `backoff` is below 1 | `pipeline_schema_invalid` | the key |
| `needs` or `pass_env` has a repeat, or `steps` is empty | `pipeline_schema_invalid` | the key |
| A `default` fails the literal rule, or a `file` input has a `default` | `pipeline_schema_invalid` | the `default` key |
| `uses` matches neither form | `pipeline_schema_invalid` | `steps.<id>.uses` |
| `uses` cannot be resolved | `block_not_found` | `steps.<id>.uses` |
| The block's header cannot be read | `block_header_malformed` | `steps.<id>.uses` |
| The block's header breaks its schema | `block_schema_invalid` | `steps.<id>.uses` |
| `needs` names an undeclared step | `unknown_step` | `steps.<id>.needs.<index>` |
| An expression names an undeclared step | `unknown_step` | the `with` or `outputs` key |
| An expression names an undeclared pipeline input | `unknown_input` | the `with` key |
| An expression names an output the step's block does not declare | `unknown_output` | the `with` or `outputs` key |
| A `with` key is not an input of the block | `unknown_input` | `steps.<id>.with.<key>` |
| A block input with no default is absent from `with` | `missing_input` | `steps.<id>.with.<input>` |
| A `${{` that does not start a valid expression | `expression_invalid` | the `with` or `outputs` key |
| A top-level `outputs` value is not a whole `steps.` expression | `expression_invalid` | `outputs.<name>` |
| A type does not fit, per [section 3.7](#37-binding-with-to-block-inputs) | `type_mismatch` | `steps.<id>.with.<key>` |
| The effective dependencies form a cycle, including a step on itself. One error per strongly connected component | `dependency_cycle` | `steps.<id>.needs`, for the component's first step in declaration order |

---

## 4. Execution

### 4.1 What "resumable" means

An engine can die at any moment and a new one continues the run. The guarantees are:

- A step that succeeded is never run again.
- **A block runs at least once**, not exactly once. An attempt cut off by a restart is started again
  from the top, in the same work directory. So blocks MUST be safe to re-run, and a block with hours of
  work SHOULD save progress in its work directory.

*Rejected: reattaching to a running process after a restart.* A deploy replaces the pod, so the process
is gone anyway. Even on a surviving host an engine cannot `waitpid` a process it did not start, and a
per-step shim to record the exit code adds a new way to fail.

### 4.2 Run directory

A run lives entirely in one directory, and it is the source of truth for that run:

```
$BASHREACTOR_HOME/
  home/                                  HOME of every block
  runs/<run id>/
    run.json                             all state, section 4.9
    lock                                 who is driving this run, section 4.7
    cancel.request                       exists if somebody asked to cancel, section 4.6
    pipeline.yaml                        snapshot, exact bytes
    blocks/<sha256>.sh                   snapshot of each block, exact bytes
    inputs/<name>                        copies of file inputs of the run
    steps/<step id>/
      work/                              cwd of every attempt of this step
      attempts/<n>/
        log                              stdout and stderr of this attempt
        outputs/<output name>            what the block wrote
        tmp/                             TMPDIR, deleted when the attempt ends
```

A run id is the UTC start time and 8 random hex digits, matching `^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$`, for
example `20261104T101500Z-3fa9c2d1`. It sorts by time and needs no library.

Nothing is deleted from a run directory except `tmp/`. Deleting a run means deleting the directory,
whole, and only the engine does it — [section 4.11](#411-keeping-a-run-and-letting-it-go).

**Snapshots.** Starting, resuming and retrying a run read only the snapshots, never the original
pipeline or block files. Editing a block does not affect runs already started.

`packages/store` may index or mirror this data, and it stores the block library. It MUST NOT be needed
to resume a run, and the engine does not depend on it.

### 4.3 Starting a run

1. Validate the pipeline ([section 3.9](#39-what-is-invalid)).
2. Check the run inputs ([section 3.3](#33-pipeline-inputs)).
3. Check every `pass_env` name is set (`env_missing`).
4. Assemble the run directory at `runs/.tmp-<run id>`, including the `lock`
   ([section 4.7](#47-restart-and-resume)), and a `run.json` with status `running` and every step
   `pending`.
5. Rename it to `runs/<run id>`.

A failure in steps 1 to 3 returns errors and creates nothing. Directories named `.tmp-*` are garbage
from a crash and are ignored.

*Rejected: creating a `failed` run for an invalid pipeline.* An invalid pipeline never ran, and the
errors go to whoever asked.

### 4.4 Scheduling and step status

A step is **eligible** when it is `pending`, or `waiting_retry` with `next_attempt_at` in the past, and
all its effective dependencies are `succeeded`. Whenever anything changes, the engine starts eligible
steps in declaration order until `max_parallel` steps are `running`. A step in `waiting_retry` does not
take a slot.

| Step status | Meaning | Next |
| --- | --- | --- |
| `pending` | Not started, or interrupted by a restart | `running`, `skipped`, `failed`, `cancelled` |
| `running` | Has a live attempt | `succeeded`, `failed`, `waiting_retry`, `pending`, `cancelled` |
| `waiting_retry` | A retry is due at `next_attempt_at` | `running`, `cancelled` |
| `succeeded` | Outputs published | final |
| `failed` | Failed for good | final, until a manual retry |
| `skipped` | A dependency did not succeed | final, until a manual retry |
| `cancelled` | Stopped by a cancel | final, until a manual retry |

To start a step:

1. On its first start, bind `with`. If this fails with `input_too_large`, the step goes straight to
   `failed` with no attempt.
2. Check `pass_env`. If this fails with `env_missing`, the step goes straight to `failed` with no
   attempt.
3. Create `attempts/<n>/` with `outputs/`, `tmp/` and an empty `log`, and `work/` if missing.
4. Write `run.json` with the attempt `running` and `pid: null`.
5. Spawn. If the spawn itself fails, the attempt and the step are `failed` with `spawn_failed`.
6. Write `run.json` with `pid` and `pid_start`, where `pid_start` is field 22 of `/proc/<pid>/stat`.

When the script ends:

1. Send SIGKILL to the process group.
2. Delete `tmp/`.
3. Decide the outcome ([section 2.8](#28-exit-codes-and-errors)), which reads the outputs.
4. On success, set file outputs to `0444`.
5. Write `run.json`.

An engine that dies anywhere before the last write leaves an attempt that restart treats as
interrupted, which is why a block runs at least once.

**Failure.** When a step fails, every `pending` step that depends on it, directly or not, becomes
`skipped` at once. Steps that do not depend on it carry on, including new ones that become
eligible. The run ends when every step is final:

| Every step final, and | Run status |
| --- | --- |
| all are `succeeded` | `succeeded` |
| `cancel_requested_at` is set, and not all are `succeeded` | `cancelled` |
| otherwise | `failed` |

*Rejected: GitHub's fail-fast, cancelling everything else on the first failure.* It would throw away
hours of unrelated, healthy work.

### 4.5 Retries

Each step counts `attempts_used`. An attempt that ends `succeeded` or `failed` adds 1. One that ends
`interrupted` or `cancelled` adds nothing.

So the count is of attempts that have *ended*, not of attempts that have started: a step whose first
attempt is running reads `attempts_used: 0` with that attempt already in `attempts`, `running`, and
every client prints that `0` for a step you can see working. It is not a bug, and it is what makes an
interrupted or cancelled attempt cost no budget.

When an attempt fails with a code that can retry ([section 2.8](#28-exit-codes-and-errors)) and
`attempts_used < max_attempts`, the step goes to `waiting_retry`, with `next_attempt_at` computed by
[section 3.5](#35-retry) and written to `run.json`, so a restart honours the wait. It is cleared when the
next attempt starts. Otherwise the step goes to `failed`, and takes its `failure` from that attempt.

Attempt numbers `n` start at 1 and go up by 1 for each attempt the step ever has, whatever happened to
the previous one. They never reset. `BR_ATTEMPT` is this number. So `BR_ATTEMPT` above 1 means an earlier
attempt existed and cwd may hold its leftovers.

### 4.6 Cancel and manual retry

**Cancel.** Whoever holds the claim on the run ([section 4.7](#47-restart-and-resume)) does this:

1. Set `cancel_requested_at`. This survives a restart.
2. Set every `pending` and `waiting_retry` step to `cancelled`.
3. Stop every running attempt as in [section 2.9](#29-what-a-timeout-kills). The attempt and the step
   become `cancelled`.

A process that does not hold the claim creates the empty file `cancel.request` in the run directory
instead. The holder MUST look for that file at least once per second, and deletes it after step 1. If
no engine holds the claim, the next one to resume the run acts on the file. Cancelling a run that is not
`running` is `run_not_active`.

*Rejected: a socket or other IPC to the engine.* A local CLI and a server would each need their own, and
a file works for both.

**Manual retry.** Allowed on a run that is `failed` or `cancelled`, otherwise `run_not_retryable`. It
claims the run and then, in one write to `run.json`:

- Sets every `failed`, `skipped` and `cancelled` step to `pending`, with `with`, `failure` and
  `next_attempt_at` cleared and `attempts_used` set to 0.
- Sets the run to `running`, and clears `cancel_requested_at` and `finished_at`.
- Deletes `cancel.request` if there is one.

`succeeded` steps stay as they are. Attempt numbers continue, the old attempts stay in the list, and work
directories are kept. The same snapshots are used.

### 4.7 Restart and resume

**Claim.** Only one engine may drive a run, and only the holder writes its `run.json`. The claim is the
file `lock`, holding `{"pid": <engine pid>, "pid_start": <its field 22>}`, created with `O_CREAT|O_EXCL`.
A claim is **live** if `/proc/<pid>/stat` exists with the same field 22 and otherwise **stale**. A stale
lock may be deleted and claimed again. The holder deletes `lock` when the run reaches a final status.

**Resume.** `resume(run id)` applies to a run with status `running`. It fails with `run_claimed` if the
claim is live, and `run_not_active` for any other status. A server engine calls it at startup on every
run in `runs/` with status `running`, and skips those with a live claim. A local CLI calls it when the
user asks.

After claiming, for each step that is `running`, take its last attempt:

1. If `pid` is set, and `/proc/<pid>/stat` has the same field 22 as `pid_start`, then a leftover script is
   still alive. Stop it as in [section 2.9](#29-what-a-timeout-kills), with no timeout or cancel meaning
   attached.
2. Set the attempt to `interrupted`, with code `interrupted`.
3. Set the step to `pending`, or to `cancelled` if `cancel_requested_at` is set. Its `with` and
   `attempts_used` stay as they were.

Then schedule as usual. `waiting_retry` steps keep their `next_attempt_at`. A fresh attempt gets a fresh
timeout.

**Graceful shutdown.** On SIGTERM or SIGINT an engine stops starting steps, handles its running attempts
with the three steps above, deletes its `lock` and exits. The run stays `running`, ready to be resumed.
The kubernetes `terminationGracePeriodSeconds` should exceed the longest `kill_grace` in use. If it does
not, SIGKILL ends the engine and the next one does the resume above.

Known gaps, accepted in version 1:

- If the script's leader died but a child outlived it across an engine crash, nothing finds that child.
- Two engines taking over the same stale claim in the same instant can both succeed.
- An interrupted attempt does not spend budget, so a block that reliably crashes the host loops forever.

### 4.8 Logs

Logs are kept per attempt, and a step's log is its attempts' logs in order.

`attempts/<n>/log` is opened with `O_CREAT|O_APPEND` by the engine and given to the script as both
stdout and stderr. The script writes to the file directly, with no pipe through the engine. So:

- it holds only what the block wrote, byte for byte, in the order it was written. The engine adds nothing,
  and engine decisions are in `run.json`,
- it is complete up to the moment of a crash, and it is safe for many hours of output,
- a background process that keeps the descriptor open cannot hold up the end of an attempt,
- a reader follows it by byte offset, which is the cursor that the API and the CLI use.

**Chunking.** A read answers with no more than the window it was asked for, plus at most three bytes
more to finish a character the window cut in half, so the cursor never lands inside a UTF-8 sequence
and a reader that decodes each chunk on its own is never shown a replacement character for text the
block wrote correctly. When the file stops mid-sequence on an attempt that is still running, the
unfinished bytes are held back and the next read brings the whole character; once the attempt is
final they are the block's own bytes and come through. Anything else that is not valid UTF-8 comes
through as it was written, byte for byte, whatever the attempt's state.

*Rejected: a pipe through the engine with NDJSON and a timestamp per line.* The engine becomes a
bottleneck and a single point of failure for every long job, and a crash loses the tail.
*Rejected: separate stdout and stderr files.* The relative order of errors and output is what you need
when reading a failure.

A block that wants timestamps prints them.

### 4.9 `run.json`

Replaced atomically on each change: write a temporary file in the same directory, `fsync`, `rename`,
`fsync` the directory. Values are stored as JSON. A `file` value is stored as a path relative to the run
directory, and turned absolute when rendered. Times are ECMAScript `Date.prototype.toISOString()`.

```json
{
  "schema": 1,
  "id": "20261104T101500Z-3fa9c2d1",
  "pipeline": "word-report",
  "status": "running",
  "created_at": "2026-11-04T10:15:00.000Z",
  "finished_at": null,
  "cancel_requested_at": null,
  "inputs": { "lines": 200, "seed": 7, "title": "Word report" },
  "outputs": null,
  "steps": {
    "generate": {
      "name": "Generate the corpus",
      "status": "running",
      "block": { "uses": "./generate-corpus.sh", "name": "generate-corpus", "sha256": "ab12..." },
      "needs": [],
      "with": { "lines": 200, "seed": 7, "interrupt_at": 120 },
      "outputs": null,
      "failure": null,
      "attempts_used": 1,
      "next_attempt_at": null,
      "attempts": [
        {
          "n": 1,
          "status": "failed",
          "pid": 48211,
          "pid_start": 91827364,
          "started_at": "2026-11-04T10:15:00.100Z",
          "finished_at": "2026-11-04T10:15:00.250Z",
          "exit_code": 75,
          "signal": null,
          "failure": { "code": "retry_requested", "message": "exit 75" }
        },
        {
          "n": 2,
          "status": "running",
          "pid": 48230,
          "pid_start": 91827466,
          "started_at": "2026-11-04T10:15:01.260Z",
          "finished_at": null,
          "exit_code": null,
          "signal": null,
          "failure": null
        }
      ]
    }
  }
}
```

| Field | Values |
| --- | --- |
| `schema` | `1` |
| run `status` | `running`, `succeeded`, `failed`, `cancelled` |
| run `inputs` | every pipeline input, with defaults applied |
| run `outputs` | mapping, or `null` unless the run succeeded |
| step `name` | the display name from the pipeline, or the step id |
| step `status` | see [section 4.4](#44-scheduling-and-step-status) |
| step `needs` | effective dependencies, in declaration order of the steps named |
| step `with` | every block input with defaults applied, or `null` before binding |
| step `outputs` | mapping, or `null` until the step succeeded |
| step `failure` | `{code, message}` if the step is `failed`, otherwise `null` |
| attempt `status` | `running`, `succeeded`, `failed`, `interrupted`, `cancelled` |
| attempt `failure` | `{code, message}` unless the attempt is `running` or `succeeded`, then `null` |
| attempt `exit_code` | the exit code, or `null` if none was seen |
| attempt `signal` | the signal name such as `SIGKILL`, or `null` |

The `steps` keys are in declaration order.

### 4.10 Reading a run's files

A run's files are read by a path **relative to the run directory**, using the paths [section 4.2](#42-run-directory)
documents: `steps/<step id>/attempts/<n>/outputs/<name>`, `steps/<step id>/attempts/<n>/log`,
`steps/<step id>/work/...`, `run.json`, `pipeline.yaml`, `inputs/<name>`. There is no way to name a file
that is not inside one run directory, and no route that reads a run's files reaches outside it.

A path is refused when it is empty, begins with `/`, contains a NUL byte, or has a segment that is empty,
`.` or `..` — after percent-decoding, so `..`, `%2e%2e` and `..%2f` are one path and not three. It is
refused when any component of it, read from the run directory down and without following links, is a
symlink. A block is arbitrary bash and can leave anything in its own directory, including a link at
`tokens.json`, at the store, or at another run's directory, so a link is never followed and never
served: asking for one is `file_not_found`, and a listing shows it as a link with no size so that
planting one cannot hide it. An archive follows the same rule, skipping links and saying how many it
skipped.

A download is an attachment with a neutral content type and `X-Content-Type-Options: nosniff`, and is
never rendered inline. A block can write an HTML file, and a file served from the API's own origin is a
script that runs as the API. Files are streamed rather than read into memory whole, because a run's
output can be far larger than the memory a server is allowed.

A run that is `running` is still writing, so any file it holds may be incomplete, and that is signalled
rather than hidden: the manifest says `partial: true` for the run and for each attempt that is `running`,
and a single file answered while the run is running says so in its own header. A finished run's files
are final. An unknown run, step or attempt is the same answer the log route gives (`run_not_found`,
`step_not_found`, `attempt_not_found`); a path with no file behind it is `file_not_found`.

### 4.11 Keeping a run, and letting it go

A run directory is deleted whole or not at all, and only by the engine, because `runs/<run id>/` is the
record, every log and everything a block wrote, and anybody else reaching for it is guessing at a layout
they do not own. An unknown run is `run_not_found`. A run with a live claim is `run_claimed` — something
is writing into it — and it is left alone; cancel it first.

The volume is a fixed size and a run never stops writing to it, so the server can trim on its own. The
window is `$BASHREACTOR_RETENTION`, a [section 1.3](#13-durations) duration (`30d`, `12h`, `45m`): a run
that has reached a final status and has been finished longer than the window is deleted, on startup and
then hourly. Unset, empty, `off`, `none` and `0` all mean the server never deletes anything, and that is
the default — a run directory is the only copy of what a pipeline produced, and nothing in v1 can tell
which runs a person still wants. Whichever it is, the server says so at startup, because "off" being
silent is how a volume fills.

What the sweep will not touch: a run that is not in a final status (`running` is being written into,
`waiting` is waiting on a person, and a sweep must not decide they never will), a run with no
`finished_at` to age it by, and a run that refuses while it is being deleted. Anything it cannot account
for is kept and counted, because the failure mode of keeping one run too long is a fuller disk and the
failure mode of deleting one too early is somebody's data. One directory that will not go does not end
the pass; the error is logged once and the rest still go.

The room left is `GET /v1/disk`, which answers `path`, `total_bytes`, `used_bytes`, `free_bytes` and
`low` — a number for a probe or a cron to watch, said before the runs start dying. A filesystem that
will not say is `runtime_missing`, never a zero: a volume that did not mount is not a full one.

*Rejected: deleting by disk pressure rather than by age.* It needs a number for "full" the spec cannot
pick, and it makes the oldest run the sacrifice every time, which is the one most likely to be the
audit trail.

---

## 5. Errors

Every error is an object, and the CLI, API and MCP server show the same one:

```json
{ "code": "type_mismatch", "message": "steps.count.with.top: expected integer, got string", "path": "steps.count.with.top", "file": "word-report.yaml" }
```

`code` is required, and is one of the codes below. `message` is required, is for people, and MUST NOT be
compared in tests. `path` is the dotted path from the document root to the offending key, with list
indexes as numbers. `file` is the file concerned, where there is one. For a block header, `path` is the
key in the pipeline that referenced it, per [section 3.9](#39-what-is-invalid).

Every code any client can print is in this table, and every code here comes out of a call site
somewhere. The definition, starting and step-failure codes are the closed set `packages/core` types
failures and validation issues against; the access, request and server codes are what the transport
adds, and are nothing a block can fail with.

| Code | When |
| --- | --- |
| **Definition** | |
| `pipeline_yaml_invalid` | [Section 3.1](#31-parsing) |
| `pipeline_schema_invalid` | [Section 3.9](#39-what-is-invalid) |
| `block_not_found` | [Section 3.4](#block-references) |
| `block_header_malformed` | [Section 2.2](#22-how-the-header-is-parsed) |
| `block_schema_invalid` | [Section 2.3](#23-header-schema) |
| `unknown_step`, `unknown_input`, `unknown_output`, `missing_input` | [Section 3.9](#39-what-is-invalid) |
| `expression_invalid`, `type_mismatch`, `dependency_cycle` | [Section 3.9](#39-what-is-invalid) |
| **Starting a run** | |
| `file_input_not_found` | [Section 3.3](#33-pipeline-inputs) |
| `env_missing` | [Section 3.4](#34-step). Also a step failure. |
| **Step failure**, in `failure.code` | |
| `input_too_large` | [Section 2.4](#24-how-inputs-reach-the-script) |
| `spawn_failed` | [Section 4.4](#44-scheduling-and-step-status). Not retried: the host is misconfigured. |
| `exit_nonzero`, `retry_requested`, `block_fatal`, `killed_by_signal`, `timeout`, `cancelled` | [Section 2.8](#28-exit-codes-and-errors) |
| `output_missing`, `output_invalid`, `output_too_large` | [Section 2.5](#25-outputs) |
| `interrupted` | [Section 4.7](#47-restart-and-resume). On an attempt only, never on a step. |
| **Operations** | |
| `run_not_found` | The run id does not exist. |
| `run_not_active` | Cancel or resume on a run that is not `running`. |
| `run_not_retryable` | Manual retry on a run that is `running` or `succeeded`. |
| `run_claimed` | Resume or delete a run with a live claim. |
| `run_delete_failed` | [Section 4.11](#411-keeping-a-run-and-letting-it-go). The filesystem refused the removal even after the tree was made writable. The run is still there, in full. |
| `runtime_missing` | [Section 2.6](#26-runtime-contract). The engine refuses to start, or a server is missing configuration it cannot come up without. Not a network failure: that is `api_unreachable`. Also `GET /v1/disk` when the filesystem under the data directory will not say how full it is, [section 4.11](#411-keeping-a-run-and-letting-it-go). |
| `file_not_found` | [Section 4.10](#410-reading-a-runs-files). No file of this run is at that path, or it is only reachable through a link. |
| `pipeline_not_found` | No pipeline of that name and version. `latest` is a version, so `nope` and `nope@latest` miss the same way. |
| `step_not_found` | The run is there; that step is not one of its steps ([section 4.10](#410-reading-a-runs-files)). |
| `attempt_not_found` | The step is there; that attempt never ran. An attempt of a step that has not run yet is this, not `not_found`. |
| `token_not_found` | No token of that name to read, revoke or list. |
| `not_implemented` | Not built yet (`AGENTS.md`). |
| **Access** | |
| `unauthenticated` | No token came with the request, or the one that came is not one this API knows. A token problem, not a server problem. |
| `forbidden` | The token is known and simply does not carry what this needs: a read token asked to write, a non-admin token asked for the admin token's routes or tools. Not retryable with the same token. |
| **The request** | |
| `bad_request` | The request could not be read as written: a path segment that is not decodable percent-encoded UTF-8, a body that is not the shape the request claimed. |
| `invalid_argument` | An argument the caller had to get right and did not: a CLI command line, a call into the store whose input fails validation. Not a pipeline or a run input — those are the codes above, which name the field. |
| `not_found` | Nothing answers at that path at all. Not the thing asked for — the whole path. A path this API has is `run_not_found`, `pipeline_not_found` or `block_not_found`. |
| `method_not_allowed` | The path is one this API has; the verb put to it is not. |
| **The server** | |
| `internal_error` | Something broke that no other code describes. Every client falls back to it, so it is the one code that can appear without the failure having been understood. |
| `api_unreachable` | A client got no answer out of the API: connection refused, DNS failure, timeout, a connection closed mid-request. The API did not refuse the request, it never received one. The message names the URL tried. This is the only code for "the server is not there", in all three clients. |
| `store_closed` | The store is closed; nothing further can be read from it or written to it. |
| `store_migration_failed` | The store's schema could not be brought to the version this build needs. |
| **The store's own**, passed through with the code untouched | |
| `already_exists` | Writing it would overwrite something already there: a run id, an attempt number, an artifact of that step and attempt. |
| `version_conflict` | What a run recorded about a block version does not match what the store holds for that version. |
| `artifact_not_found` | No artifact of that name for that step and attempt. |

The last three are raised in `packages/store/src/store.ts`, and the API passes a store error through
with its code untouched, so a client has to treat them as its own. `store_migration_failed` and
`store_closed` come out at startup and after shutdown; `already_exists`, `version_conflict` and
`artifact_not_found` come from the store's run and artifact write path, which no route calls yet.
They are listed here so that the first client to meet one meets a code that is in the spec.

---

## 6. Out of scope for version 1

Conditional steps (`if:`), matrix and fan-out steps, triggers and schedules, step output caching between
runs, sandboxing, log rotation, deleting runs by disk pressure, remote or distributed workers, and
manual approval gates. A pipeline that uses a key for any of these is rejected, because the key is
unknown.

Retention is in: [section 4.11](#411-keeping-a-run-and-letting-it-go) keeps a finished run for
`$BASHREACTOR_RETENTION` and then removes it. What is still out is deciding *which* runs to keep — a run
marked to survive, a per-run or per-pipeline window, and any trimming that is not by age.

Manual retry always reuses the snapshot, so fixing a block and continuing a failed run from where it
stopped is not possible yet. It needs a new run.

Engines are Linux only, because of `/proc/<pid>/stat`.

---

## 7. Worked example

[`docs/examples/`](examples/README.md) holds the pipeline `word-report.yaml` with four blocks next to it.

| Spec | Where the example exercises it |
| --- | --- |
| Header format, defaults, the types `string`, `integer`, `json` and `file` | every block's header |
| A plain bash block | `generate-corpus.sh`, `check-corpus.sh` |
| The `uv` form from [section 2.7](#27-calling-uv-and-bun) | `count-words.sh` |
| The `bun` form from [section 2.7](#27-calling-uv-and-bun) | `render-report.sh` |
| A block with no outputs | `check-corpus.sh` |
| Exit 75, resuming from the work directory, `BR_ATTEMPT` | `generate-corpus.sh` with `interrupt_at` |
| Exit 78 not spending the retry budget | `check-corpus.sh` when `lines` is below 100 |
| `skipped` while unrelated work carries on | `report` skipped, `count` succeeds, when `lines` is below 100 |
| `file` output to `file` input by path | `corpus` to `check` and `count`, `counts` to `report` |
| `json` and `integer` from output to input | `top_words`, `total_words` |
| Whole expression and template | `lines`, and `title` of `report` |
| Implicit dependencies | `check` and `count` on `generate` |
| `needs` with no data flowing | `report` on `check` |
| `max_parallel` | `check` and `count` run together, with a limit of 2 |
| Pipeline `outputs` | `report`, `total_words` |

The exact expected results are in [`docs/examples/README.md`](examples/README.md).
