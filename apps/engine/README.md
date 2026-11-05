# Bashreactor run engine (BASHR-3)

Runs pipelines made of long-running block processes. It parses and validates a pipeline with
`@bashreactor/core`, schedules its steps by their dependencies, runs each step as a detached process
group with `uv` and `bun` on its PATH, applies retries and timeouts, and persists everything it needs
to survive a restart.

## Public API

```ts
import { Engine, FsRunStore } from "@bashreactor/engine";
import type { RunStore } from "@bashreactor/engine";

const engine = new Engine({ store, env?, path? });

// Definition
engine.validate(pipelinePath): ValidationIssue[];          // section 3.9, every rule, nothing created

// Runs
engine.start(pipelinePath, inputs?): Promise<RunRecord>;   // validate + inputs + pass_env + snapshot
engine.drive(runId): Promise<RunRecord>;                   // claim + mark interrupted + run to a final status
engine.resume(runId): Promise<RunRecord>;                  // same as drive (the name the CLI uses)
engine.retry(runId): Promise<RunRecord>;                   // manual retry on a failed/cancelled run
engine.cancel(runId): Promise<void>;                       // write cancel.request; the holder applies it
engine.getRun(runId): Promise<RunRecord | null>;
engine.listRuns(): Promise<string[]>;
engine.readLog(runId, stepId, attempt, offset): Promise<{ data: Uint8Array; nextOffset: number }>;
```

`RunRecord` is the `run.json` shape of SPEC section 4.9 (`schema: 1`, steps in declaration order,
`file` values stored as paths relative to the run directory).

## The RunStore interface

The engine never touches the disk for run state. `packages/store` (BASHR-4) must implement this
interface; `FsRunStore` here is the reference/test implementation the engine's tests use.

```ts
interface RunStore {
  layout(runId): RunLayout;                 // absolute paths: run.json, lock, cancel.request,
                                            // pipeline.yaml, blocks/<sha>.sh, inputs/<name>,
                                            // steps/<id>/work, steps/<id>/attempts/<n>/{log,outputs,tmp}
  createRun(record, files): Promise<void>;  // assemble .tmp-<id> then rename (atomic)
  saveRun(record): Promise<void>;           // atomic replace of run.json
  loadRun(runId): Promise<RunRecord | null>;
  listRunIds(): Promise<string[]>;

  tryClaim(runId, { pid, pid_start }): Promise<"claimed" | "exists" | "missing">; // O_CREAT|O_EXCL
  loadClaim(runId): Promise<{ pid, pid_start } | null>;
  releaseClaim(runId): Promise<void>;       // delete lock

  writeCancelRequest(runId): Promise<void>; // empty cancel.request file
  hasCancelRequest(runId): Promise<boolean>;
  clearCancelRequest(runId): Promise<void>;

  writeFile(runId, rel, bytes, mode?): Promise<void>;  // mkdir -p parents
  readFile(runId, rel): Promise<Uint8Array | null>;
  stat(runId, rel): Promise<{ kind: "file" | "directory" | "other" | "missing" }>;
  chmod(runId, rel, mode): Promise<void>;
  remove(runId, rel): Promise<void>;        // recursive
  ensureDir(runId, rel): Promise<void>;

  homePath(): string;                       // $BASHREACTOR_HOME/home, shared by all blocks
}
```

`RunFiles` carries `{ pipeline: Uint8Array, blocks: { sha256, bytes }[], fileInputs: { name, bytes }[] }`.
Claim liveness (field 22 of `/proc/<pid>/stat`) lives in the engine (`apps/engine/src/proc.ts`), not
in the store.

## Decisions

- **The test store is file-backed, not in-memory.** A spawned block needs real filesystem paths for
  its cwd, log file, `OUTPUT_*` and `TMPDIR`, and the restart test needs a store that outlives the
  engine process. `FsRunStore` is that minimal store; a pure in-memory store cannot satisfy either.
- **`cancel()` always writes `cancel.request`.** The holder's drive loop polls it every 100 ms and
  applies the cancel; a non-holder just leaves the file for the next engine. This one path covers
  both cases of SPEC 4.6 without a second code path.
- **Library block references (`name@version`) are `block_not_found`.** There is no block library yet
  (BASHR-4); path references resolve relative to the pipeline file's directory.
- **Block bodies are opaque bytes.** Only the comment header is decoded as UTF-8
  (`splitBlockHeaderBytes`), so a block whose script body is not UTF-8 still parses.
- **`drive` and `resume` are the same operation**: claim the run, turn any `running` step's last
  attempt into `interrupted` (stopping a leftover process group first), then schedule until a final
  status. A fresh attempt gets a fresh timeout.
- **Attempt numbers never reset.** `interrupted` and `cancelled` attempts do not spend the retry
  budget; a manual retry clears `attempts_used` but keeps the old attempts in the list and the work
  directory.
- **`$BASHREACTOR_HOME` is the store's root.** `FsRunStore` lays out `runs/` and `home/` under it;
  the engine passes `home/` to every block as `HOME`, so uv and bun caches are shared across runs
  and restarts.

## Cross-package note

The scaffold's `apps/api` and `apps/cli` were written against the old guessed error body
`{ error: { code, message } }`. SPEC section 5 makes the body `{ code, message, path, file }`; their
scaffold tests were updated in the same commit to the spec shape, and `apps/api`'s non-spec
`invalid_config` code (for a bad `PORT`) became `runtime_missing`, the closest spec code. The spec
has no configuration-error code; BASHR-5 should add one when it builds the real API.
