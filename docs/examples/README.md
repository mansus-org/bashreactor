# Worked example: `word-report`

A pipeline of four blocks that follows [`docs/SPEC.md`](../SPEC.md) line by line. The engine's tests run
it, so a change here is a change to what they expect. It needs no network and takes a few seconds, most
of it the one-second retry wait.

| File | What it is |
| --- | --- |
| [`word-report.yaml`](word-report.yaml) | The pipeline. |
| [`generate-corpus.sh`](generate-corpus.sh) | Plain bash. Writes a reproducible corpus. Exits 75 once, then resumes from its work directory. |
| [`check-corpus.sh`](check-corpus.sh) | Plain bash, with no outputs. Exits 78 if the corpus is too short. |
| [`count-words.sh`](count-words.sh) | Python through `uv`. Counts words. |
| [`render-report.sh`](render-report.sh) | TypeScript through `bun`. Renders the report. |

```
            ┌─> check ───────┐
generate ───┤                ├─> report
            └─> count ───────┘
```

`check` and `count` take the `corpus` file from `generate`. `report` takes `top_words`, `total_words` and
the `counts` file from `count`, and `line_count` from `generate` inside its title. It reads nothing from
`check`, so it says `needs: [check]`.

## Running it

These are the commands the CLI (BASHR-7) has to provide. Paths are relative to the repo root.

```bash
# Check the pipeline and every block it uses, without running anything.
bashreactor validate docs/examples/word-report.yaml

# Start a run with the defaults, and wait for it. Prints the run id first.
bashreactor run docs/examples/word-report.yaml

# The same, with inputs. Values are read with the text form of SPEC section 1.2.
bashreactor run docs/examples/word-report.yaml --input lines=300 --input seed=11 --input title=Other

# See how a run is doing, and read one step's log. Logs are kept per step and per attempt.
bashreactor status <run-id>
bashreactor logs <run-id> --step generate
bashreactor logs <run-id> --step generate --attempt 1

# Stop a run. Continue a failed or cancelled run. Pick up a run after the engine died.
bashreactor cancel <run-id>
bashreactor retry <run-id>
bashreactor resume <run-id>
```

## What a run does

### With the defaults

The run ends `succeeded`, with this order of events. `check` and `count` run at the same time: `check`
always starts first, because it is declared first, and either may end first.

| Step | Attempt | Result | Notes |
| --- | --- | --- | --- |
| `generate` | 1 | `failed`, `retry_requested`, exit 75 | Stops at line 120, as `interrupt_at` says. |
| `generate` | 2 | `succeeded` | Starts a second later, and continues from the 120 lines in its work directory. |
| `check` | 1 | `succeeded` | |
| `count` | 1 | `succeeded` | |
| `report` | 1 | `succeeded` | Starts after both of the above. |

Pipeline outputs in `run.json`:

```json
{
  "report": "steps/report/attempts/1/outputs/report",
  "total_words": 1300
}
```

Step outputs:

| Step | Output | Value |
| --- | --- | --- |
| `generate` | `corpus` | `steps/generate/attempts/2/outputs/corpus` |
| `generate` | `line_count` | `200` |
| `count` | `total_words` | `1300` |
| `count` | `top_words` | see below |
| `count` | `counts` | `steps/count/attempts/1/outputs/counts` |
| `report` | `report` | `steps/report/attempts/1/outputs/report` |
| `report` | `report_bytes` | `163` |

`top_words`:

```json
[
  { "word": "amber", "count": 114 },
  { "word": "larch", "count": 114 },
  { "word": "fjord", "count": 113 },
  { "word": "delta", "count": 110 },
  { "word": "cedar", "count": 109 }
]
```

The `report` file, with mode `0444`:

```markdown
# Word report: 200 lines

1300 words, 12 distinct.

| Word | Count |
| --- | --- |
| amber | 114 |
| larch | 114 |
| fjord | 113 |
| delta | 110 |
| cedar | 109 |
```

The artifacts are the same bytes on every run:

| File | Size | SHA-256 |
| --- | --- | --- |
| `corpus` | 8230 | `645ce2d768db71791d28a66e9e5b0f29e8c8799365cbf3f4da0580fa7c041393` |
| `counts` | 135 | `970c6e40e987cbce61f63b5397349f7892a1a29af5fcc12d60d13834f26a6b7b` |
| `report` | 163 | `f64f7bba5dd7e3982fd38008b6cab150f2e438e753f1eca60607be7fa1125075` |

The log of `generate`, attempt 1:

```
attempt 1: 0 of 200 lines already written
attempt 1: stopping after 120 lines, asking for a retry
```

The log of `generate`, attempt 2:

```
attempt 2: 120 of 200 lines already written
attempt 2: corpus finished
```

Attempt 1's outputs directory is empty. Its partial work was in the work directory, which is why attempt 2
could use it.

### With `--input lines=50`

The corpus is below `min_lines`, so the gate fails. The run ends `failed`, with `outputs: null`.

| Step | Status | `attempts_used` | Notes |
| --- | --- | --- | --- |
| `generate` | `succeeded` | 1 | `interrupt_at` is never reached, so there is no retry. |
| `check` | `failed`, `block_fatal`, exit 78 | 1 | `max_attempts` is 2, but exit 78 never retries. |
| `count` | `succeeded` | 1 | Does not depend on `check`, so it carries on. |
| `report` | `skipped` | 0 | No attempts and no `with`. |

The log of `check`, attempt 1:

```
check-corpus: 50 lines, need at least 100
```

### With `--input lines=300 --input seed=11 --input title=Other`

The run ends `succeeded`, with `total_words` 1950 and the title `Other: 300 lines`.
