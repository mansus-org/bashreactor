# @bashreactor/store

The queryable index of Bashreactor's nouns: pipelines, runs, steps and attempts, block versions,
logs and artifacts. It is also the block library that `uses: name@version` resolves against
(SPEC §3.4).

The run directory in `$BASHREACTOR_HOME/runs/<id>` stays the source of truth for resuming a run
(SPEC §4.2). The store is an index and mirror of that data plus the block library; nothing in the
engine may need the store to resume a run. This package has no global state: every `Store` instance
owns one data directory and takes it in its constructor.

## On-disk layout

Everything the store owns lives under one directory, `dataDir`:

```
<dataDir>/
  store.sqlite                 SQLite database (plus -wal and -shm)
  blocks/<name>/<version>      immutable block library bytes
  logs/<runId>/<stepId>/<n>.log
  artifacts/<runId>/<stepId>/<n>/<output name>
```

Paths recorded inside SQLite are relative to `dataDir`, so the whole directory can be moved.

## Decisions

### Store format: SQLite via `bun:sqlite`

A SQLite database was chosen over a file-per-record layout because the store must answer relational
questions (a run with its pipeline, steps, block versions and artifacts; a pipeline's version
history; the block library by `name@version`). SQLite provides those joins and indexes, ACID
transactions so a write never leaves a half-written run, and WAL mode so readers do not block the
writer. `bun:sqlite` is built into bun, so there is no new runtime dependency. Blocks, logs and
artifacts are files on disk, not BLOBs: blocks and artifacts are immutable and large, and logs must
be appendable without rewriting the file.

### Data directory and concurrency

`dataDir` is an explicit constructor argument (the store never invents one implicitly). The
`openStore()` factory resolves the default as `$BASHREACTOR_HOME/store`, falling back to
`~/.bashreactor/store`, so the store lives beside — never inside — the engine's `runs/` directory.

Concurrent access is SQLite's own file locking: the database is opened in WAL journal mode with a
5-second busy timeout and foreign keys on, so two `Store` instances (in one process or two) can
safely point at the same directory. Version allocation for blocks and pipelines runs inside a
`BEGIN IMMEDIATE` transaction, so two writers cannot both allocate version *n*. Immutable files are
written to a same-directory temp file, fsynced, renamed, and the directory is fsynced, so a reader
never sees a partial block or artifact.

### Logs: append without rewriting, follow by offset

A log is one file per attempt, opened with `O_CREAT|O_APPEND`. `appendLog` only ever appends; it
never seeks or rewrites, and returns the new total size. A reader follows with `readLog(runId,
stepId, attempt, offset)`, which returns the bytes from `offset` to the current end plus the current
size; the caller uses the returned size as its next offset. This is the same byte-offset cursor the
API and CLI use (SPEC §4.8). Logs are readable while the step is still running because every append
is visible immediately and the reader re-reads from its cursor.

`appendLog` keeps the `attempts.log_size` column current, but read paths (`logSize`, the `logSize`
on an `Attempt`) stat the file, so they stay correct even if a process died between appending and
updating the column.

### Migration

The schema version is `PRAGMA user_version`. A new store is version 1. Opening a store runs each
migration in order inside one transaction and bumps the version; opening a store whose
`user_version` is higher than this build understands fails with `store_migration_failed`, so a newer
store is never silently downgraded. The migrations live in `src/schema.ts` as an ordered list; each
new migration appends to the list and raises `SCHEMA_VERSION`.

## Schema

SQLite tables (all `STRICT`):

- `block_versions(name, version, sha256, path, size, created_at)` — one row per immutable version;
  `(name, version)` is the primary key and the version number is per name starting at 1.
- `pipelines(name, version, sha256, yaml, parsed_json, created_at)` — the YAML exactly as written
  plus its parsed form as JSON, versioned per name.
- `runs(id, pipeline_name, pipeline_version, status, created_at, finished_at, cancel_requested_at,
  inputs_json, outputs_json)` — one row per run; `id` is the SPEC run id.
- `steps(run_id, step_id, position, name, status, uses, block_name, block_version, block_sha256,
  needs_json, with_json, outputs_json, failure_json, attempts_used, next_attempt_at)` — declaration
  order via `position`.
- `attempts(run_id, step_id, n, status, pid, pid_start, started_at, finished_at, exit_code, signal,
  failure_json, log_path, log_size)`.
- `artifacts(run_id, step_id, attempt, name, type, path, size, sha256, published)`.

Block versions, pipelines and runs are inserted exactly once and never rewritten in place: editing a
block or pipeline creates a new version row, and a run row keeps the version it used. State that
changes (run status, step status, attempts) is updated through `updateRun`, `addAttempt` and
`updateAttempt`.

## Public API

Errors are `StoreError` with a typed `code` (`invalid_argument`, `already_exists`, `run_not_found`,
`step_not_found`, `attempt_not_found`, `block_not_found`, `pipeline_not_found`, `artifact_not_found`,
`version_conflict`, `store_locked`, `store_migration_failed`, `store_closed`) and an optional
`path`/`file`. `StoreError.toJSON()` returns `{ code, message, path?, file? }`.

```ts
new Store(dataDir: string, options?: { create?: boolean }): Store
Store.open(dataDir: string, options?: StoreOptions): Store
openStore(dataDir?: string, options?: StoreOptions): Store
defaultStoreDir(env?: Record<string, string | undefined>): string
store.close(): void

// Block library
store.addBlockVersion(name: string, content: Uint8Array | string): BlockVersion
store.getBlockVersion(name: string, version: number): BlockVersion
store.latestBlockVersion(name: string): BlockVersion | null
store.listBlockVersions(name: string): BlockVersion[]
store.listBlockNames(): BlockName[] // every name, sorted: { name, latest, versions }
store.readBlockVersion(name: string, version: number): Uint8Array

// Pipelines
store.savePipeline(input: { name: string; yaml: string; parsed: unknown }): PipelineRecord
store.getPipeline(name: string, version: number): PipelineRecord
store.latestPipeline(name: string): PipelineRecord | null
store.listPipelineVersions(name: string): PipelineRecord[]
store.listPipelineNames(): PipelineName[] // every name, sorted, without the YAML of each

// Runs and step state
store.createRun(run: NewRun): Run
store.getRun(id: string): Run
store.listRuns(): RunSummary[]
store.updateRun(id: string, update: RunUpdate): Run
store.addAttempt(runId: string, stepId: string, attempt: NewAttempt): Attempt
store.updateAttempt(runId: string, stepId: string, n: number, patch: AttemptUpdate): Attempt

// Logs
store.appendLog(runId: string, stepId: string, attempt: number, bytes: Uint8Array): number
store.readLog(runId: string, stepId: string, attempt: number, offset?: number): LogChunk
store.logSize(runId: string, stepId: string, attempt: number): number

// Artifacts
store.saveArtifact(runId, stepId, attempt, name, type: ValueType, content, published?): Artifact
store.getArtifact(runId, stepId, attempt, name): Artifact
store.readArtifact(runId, stepId, attempt, name): Uint8Array
store.listArtifacts(runId, stepId?): Artifact[]
```

The value and status types (`ValueType`, `RunStatus`, `StepStatus`, `AttemptStatus`) are `@bashreactor/core`'s,
re-exported from `src/types.ts` so importing them from the store still works; the full record shapes
(`BlockVersion`, `PipelineRecord`, `Run`, `Step`, `Attempt`, `Artifact`, `RunSummary`, `LogChunk`)
are documented by their TypeScript definitions in that file.

## Decisions the spec left open

- **Where the store lives.** SPEC §4.2 says the store "may index or mirror" run data and "stores the
  block library" but does not place its files. Chosen: one store-owned directory, default
  `$BASHREACTOR_HOME/store`, with `store.sqlite`, `blocks/`, `logs/` and `artifacts/` inside it.
- **Artifacts are copied, not referenced.** `saveArtifact` takes bytes and stores them under the
  store's `artifacts/` area, recording type, size, SHA-256 and the stored location. This keeps a run
  fully inspectable after a restart without depending on an engine-managed path. For multi-gigabyte
  `file` outputs the engine reconciliation (a later task) may want a no-copy reference variant; that
  is intentionally out of this package's surface for now.
- **A run's block reference.** Each step records `{ uses, name, version, sha256 }`; `version` is
  null for path blocks and the library version for `name@version` blocks. For library blocks
  `createRun` checks the version exists and that its SHA-256 matches what the run used
  (`version_conflict` otherwise), which is what makes editing a block unable to rewrite history.
- **Store error codes.** The store has its own typed codes rather than reusing the scaffold's
  `@bashreactor/core` codes, because those do not cover persistence errors. The mapping onto
  SPEC §5 codes happens in the reconciliation task.

## Open items

- A no-copy artifact reference (record an existing file's path without importing its bytes).
- Indexing an engine's existing `runs/` directory (mirroring run.json) — the reconciliation task
  owns the engine↔store mapping.
- Retention/deletion of old runs and old pipeline/block versions (out of scope in SPEC v1).
