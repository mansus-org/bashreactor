// The store: a queryable index of pipelines, runs, block versions, logs and artifacts, plus the
// block library. Each Store instance owns one data directory; nothing here is global, so two Stores
// (in one process or two) can point at the same directory and SQLite serializes their writes.

import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { StoreError } from "./errors.ts";
import { appendFile, atomicWriteFile, ensureDir, fileSizeOf, readFileAll, readFileFrom, sha256 } from "./fs.ts";
import { migrate } from "./schema.ts";
import type {
  Artifact,
  Attempt,
  AttemptStatus,
  AttemptUpdate,
  BlockName,
  BlockVersion,
  Failure,
  LogChunk,
  NewAttempt,
  NewRun,
  NewStep,
  PipelineName,
  PipelineRecord,
  Run,
  RunStatus,
  RunSummary,
  RunUpdate,
  StepStatus,
  StepUpdate,
  ValueType,
} from "./types.ts";

const BLOCK_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const STEP_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
const RUN_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

const RUN_STATUSES: ReadonlySet<string> = new Set(["running", "succeeded", "failed", "cancelled"]);
const STEP_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "waiting_retry",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);
const ATTEMPT_STATUSES: ReadonlySet<string> = new Set(["running", "succeeded", "failed", "interrupted", "cancelled"]);
const VALUE_TYPES: ReadonlySet<string> = new Set(["string", "integer", "number", "boolean", "json", "file"]);

export interface StoreOptions {
  create?: boolean;
}

interface BlockRow {
  name: string;
  version: number;
  sha256: string;
  size: number;
  created_at: string;
}

/** One row of a `GROUP BY name` over either library table. */
interface NameRow {
  name: string;
  latest: number;
  versions: number;
}

interface PipelineRow {
  name: string;
  version: number;
  sha256: string;
  yaml: string;
  parsed_json: string;
  created_at: string;
}

interface RunRow {
  id: string;
  pipeline_name: string;
  pipeline_version: number;
  status: string;
  created_at: string;
  finished_at: string | null;
  cancel_requested_at: string | null;
  inputs_json: string;
  outputs_json: string | null;
}

interface StepRow {
  step_id: string;
  name: string;
  status: string;
  uses: string;
  block_name: string;
  block_version: number | null;
  block_sha256: string;
  needs_json: string;
  with_json: string | null;
  outputs_json: string | null;
  failure_json: string | null;
  attempts_used: number;
  next_attempt_at: string | null;
}

interface AttemptRow {
  step_id: string;
  n: number;
  status: string;
  pid: number | null;
  pid_start: number | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  signal: string | null;
  failure_json: string | null;
  log_path: string;
  log_size: number;
}

interface ArtifactRow {
  run_id: string;
  step_id: string;
  attempt: number;
  name: string;
  type: string;
  path: string;
  size: number;
  sha256: string | null;
  published: number;
}

function requireMatch(re: RegExp, value: string, what: string): void {
  if (!re.test(value)) {
    throw new StoreError("invalid_argument", `${what} is invalid: ${JSON.stringify(value)}`);
  }
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (cause) {
    throw new StoreError("invalid_argument", "value is not JSON-serializable", { cause });
  }
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return json(value);
}

function parseJson<T>(text: string | null): T | null {
  return text === null ? null : (JSON.parse(text) as T);
}

function toBytes(content: Uint8Array | string): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function validateNewRun(run: NewRun): void {
  requireMatch(RUN_ID_RE, run.id, "run id");
  if (!RUN_STATUSES.has(run.status)) throw new StoreError("invalid_argument", `unknown run status: ${run.status}`);
  if (run.createdAt.length === 0) throw new StoreError("invalid_argument", "createdAt must not be empty");
  if (run.steps.length === 0) throw new StoreError("invalid_argument", "a run needs at least one step");

  const seen = new Set<string>();
  for (const step of run.steps) {
    requireMatch(STEP_ID_RE, step.id, "step id");
    if (seen.has(step.id)) throw new StoreError("invalid_argument", `duplicate step id: ${step.id}`);
    seen.add(step.id);
    if (step.name.length === 0) throw new StoreError("invalid_argument", `step ${step.id}: name must not be empty`);
    if (!STEP_STATUSES.has(step.status)) {
      throw new StoreError("invalid_argument", `step ${step.id}: unknown status ${step.status}`);
    }
    requireMatch(BLOCK_NAME_RE, step.block.name, `step ${step.id}: block name`);
    if (step.block.uses.length === 0) throw new StoreError("invalid_argument", `step ${step.id}: uses must not be empty`);
    if (step.block.version !== null && (!Number.isInteger(step.block.version) || step.block.version < 1)) {
      throw new StoreError("invalid_argument", `step ${step.id}: block version must be null or a positive integer`);
    }
    requireMatch(SHA256_RE, step.block.sha256, `step ${step.id}: block sha256`);
    for (const need of step.needs ?? []) requireMatch(STEP_ID_RE, need, `step ${step.id}: needs entry`);

    const attempts = step.attempts ?? [];
    const attemptNumbers = new Set<number>();
    for (const attempt of attempts) {
      if (!Number.isInteger(attempt.n) || attempt.n < 1) {
        throw new StoreError("invalid_argument", `step ${step.id}: attempt number must be a positive integer`);
      }
      if (attemptNumbers.has(attempt.n)) {
        throw new StoreError("invalid_argument", `step ${step.id}: duplicate attempt number ${attempt.n}`);
      }
      attemptNumbers.add(attempt.n);
      if (!ATTEMPT_STATUSES.has(attempt.status)) {
        throw new StoreError("invalid_argument", `step ${step.id}: unknown attempt status ${attempt.status}`);
      }
    }
  }
}

export function defaultStoreDir(env: Record<string, string | undefined> = process.env): string {
  const home = env.BASHREACTOR_HOME;
  if (home !== undefined && home !== "") return join(home, "store");
  const userHome = env.HOME;
  if (userHome !== undefined && userHome !== "") return join(userHome, ".bashreactor", "store");
  return join(process.cwd(), ".bashreactor", "store");
}

export class Store {
  readonly dataDir: string;
  #db!: Database;
  #closed = false;

  constructor(dataDir: string, options: StoreOptions = {}) {
    if (typeof dataDir !== "string" || dataDir.length === 0) {
      throw new StoreError("invalid_argument", "dataDir must be a non-empty path");
    }
    this.dataDir = resolve(dataDir);
    const create = options.create ?? true;
    if (create) {
      ensureDir(this.dataDir);
    } else if (!existsSync(this.dataDir)) {
      throw new StoreError("invalid_argument", `dataDir does not exist: ${this.dataDir}`);
    }

    const dbPath = join(this.dataDir, "store.sqlite");
    let db: Database;
    try {
      db = new Database(dbPath, { create, strict: true });
    } catch (cause) {
      throw new StoreError("store_migration_failed", `cannot open store at ${this.dataDir}`, { cause });
    }
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA foreign_keys = ON");
      migrate(db);
    } catch (err) {
      try {
        db.close();
      } catch {
        // nothing left to close
      }
      if (err instanceof StoreError) throw err;
      throw new StoreError("store_migration_failed", `store at ${this.dataDir} is not usable`, { cause: err });
    }
    this.#db = db;
  }

  static open(dataDir: string, options?: StoreOptions): Store {
    return new Store(dataDir, options);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  // --- Block library ---------------------------------------------------------

  addBlockVersion(name: string, content: Uint8Array | string): BlockVersion {
    this.#assertOpen();
    requireMatch(BLOCK_NAME_RE, name, "block name");
    const bytes = toBytes(content);
    const sha = sha256(bytes);
    const createdAt = new Date().toISOString();
    return this.#immediate(() => {
      const latest = this.#db
        .query("SELECT version, sha256 FROM block_versions WHERE name = ? ORDER BY version DESC LIMIT 1")
        .get(name) as { version: number; sha256: string } | null;
      if (latest !== null && latest.sha256 === sha) return this.#blockVersion(name, latest.version);
      const version = (latest?.version ?? 0) + 1;
      const relPath = join("blocks", name, String(version));
      atomicWriteFile(join(this.dataDir, relPath), bytes);
      this.#db
        .query("INSERT INTO block_versions (name, version, sha256, path, size, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(name, version, sha, relPath, bytes.length, createdAt);
      return this.#blockVersion(name, version);
    });
  }

  getBlockVersion(name: string, version: number): BlockVersion {
    this.#assertOpen();
    return this.#blockVersion(name, version);
  }

  latestBlockVersion(name: string): BlockVersion | null {
    this.#assertOpen();
    const row = this.#db
      .query("SELECT name, version, sha256, size, created_at FROM block_versions WHERE name = ? ORDER BY version DESC LIMIT 1")
      .get(name) as BlockRow | null;
    return row === null ? null : blockVersionFromRow(row);
  }

  listBlockVersions(name: string): BlockVersion[] {
    this.#assertOpen();
    const rows = this.#db
      .query("SELECT name, version, sha256, size, created_at FROM block_versions WHERE name = ? ORDER BY version ASC")
      .all(name) as BlockRow[];
    return rows.map(blockVersionFromRow);
  }

  /** Every block the library holds, one entry per name, names sorted. */
  listBlockNames(): BlockName[] {
    this.#assertOpen();
    return this.#libraryNames(
      "SELECT name, MAX(version) AS latest, COUNT(*) AS versions FROM block_versions GROUP BY name ORDER BY name ASC",
    );
  }

  readBlockVersion(name: string, version: number): Uint8Array {
    this.#assertOpen();
    const row = this.#db
      .query("SELECT path FROM block_versions WHERE name = ? AND version = ?")
      .get(name, version) as { path: string } | null;
    if (row === null) throw new StoreError("block_not_found", `block ${name}@${version} does not exist`);
    const abs = join(this.dataDir, row.path);
    if (!existsSync(abs)) throw new StoreError("block_not_found", `block ${name}@${version} content is missing`);
    return readFileAll(abs);
  }

  // --- Pipelines -------------------------------------------------------------

  savePipeline(input: { name: string; yaml: string; parsed: unknown }): PipelineRecord {
    this.#assertOpen();
    requireMatch(BLOCK_NAME_RE, input.name, "pipeline name");
    const sha = sha256(new TextEncoder().encode(input.yaml));
    const parsedJson = json(input.parsed);
    const createdAt = new Date().toISOString();
    return this.#immediate(() => {
      const latest = this.#db
        .query("SELECT version, sha256 FROM pipelines WHERE name = ? ORDER BY version DESC LIMIT 1")
        .get(input.name) as { version: number; sha256: string } | null;
      if (latest !== null && latest.sha256 === sha) return this.#pipeline(input.name, latest.version);
      const version = (latest?.version ?? 0) + 1;
      this.#db
        .query("INSERT INTO pipelines (name, version, sha256, yaml, parsed_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(input.name, version, sha, input.yaml, parsedJson, createdAt);
      return this.#pipeline(input.name, version);
    });
  }

  getPipeline(name: string, version: number): PipelineRecord {
    this.#assertOpen();
    return this.#pipeline(name, version);
  }

  latestPipeline(name: string): PipelineRecord | null {
    this.#assertOpen();
    const row = this.#db
      .query("SELECT name, version, sha256, yaml, parsed_json, created_at FROM pipelines WHERE name = ? ORDER BY version DESC LIMIT 1")
      .get(name) as PipelineRow | null;
    return row === null ? null : pipelineFromRow(row);
  }

  listPipelineVersions(name: string): PipelineRecord[] {
    this.#assertOpen();
    const rows = this.#db
      .query("SELECT name, version, sha256, yaml, parsed_json, created_at FROM pipelines WHERE name = ? ORDER BY version ASC")
      .all(name) as PipelineRow[];
    return rows.map(pipelineFromRow);
  }

  /** Every pipeline that has been stored, one entry per name, names sorted. */
  listPipelineNames(): PipelineName[] {
    this.#assertOpen();
    return this.#libraryNames(
      "SELECT name, MAX(version) AS latest, COUNT(*) AS versions FROM pipelines GROUP BY name ORDER BY name ASC",
    );
  }

  /**
   * The `GROUP BY name` both library listings run. The counts are counted out rather than handed
   * through, because a row object carries whatever the driver decided an aggregate is, and the two
   * callers above differ only in the table they ask.
   */
  #libraryNames(sql: string): { name: string; latest: number; versions: number }[] {
    return (this.#db.query(sql).all() as NameRow[]).map((row) => ({
      name: row.name,
      latest: Number(row.latest),
      versions: Number(row.versions),
    }));
  }

  // --- Runs ------------------------------------------------------------------

  createRun(run: NewRun): Run {
    this.#assertOpen();
    validateNewRun(run);
    this.#immediate(() => {
      if (this.#pipelineRow(run.pipeline.name, run.pipeline.version) === null) {
        throw new StoreError("pipeline_not_found", `pipeline ${run.pipeline.name}@${run.pipeline.version} does not exist`);
      }
      const existing = this.#db.query("SELECT id FROM runs WHERE id = ?").get(run.id) as { id: string } | null;
      if (existing !== null) throw new StoreError("already_exists", `run ${run.id} already exists`);

      this.#db
        .query(
          "INSERT INTO runs (id, pipeline_name, pipeline_version, status, created_at, finished_at, cancel_requested_at, inputs_json, outputs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          run.id,
          run.pipeline.name,
          run.pipeline.version,
          run.status,
          run.createdAt,
          run.finishedAt ?? null,
          run.cancelRequestedAt ?? null,
          json(run.inputs ?? {}),
          jsonOrNull(run.outputs),
        );

      run.steps.forEach((step, position) => {
        this.#insertStep(run.id, step, position);
        for (const attempt of step.attempts ?? []) this.#insertAttempt(run.id, step.id, attempt);
      });
    });
    return this.getRun(run.id);
  }

  getRun(id: string): Run {
    this.#assertOpen();
    return this.#getRun(id);
  }

  listRuns(): RunSummary[] {
    this.#assertOpen();
    const rows = this.#db
      .query("SELECT id, pipeline_name, pipeline_version, status, created_at, finished_at FROM runs ORDER BY id ASC")
      .all() as {
      id: string;
      pipeline_name: string;
      pipeline_version: number;
      status: string;
      created_at: string;
      finished_at: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      pipeline: row.pipeline_name,
      pipelineVersion: row.pipeline_version,
      status: row.status as RunStatus,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    }));
  }

  updateRun(id: string, update: RunUpdate): Run {
    this.#assertOpen();
    this.#immediate(() => {
      const row = this.#db.query("SELECT id FROM runs WHERE id = ?").get(id) as { id: string } | null;
      if (row === null) throw new StoreError("run_not_found", `run ${id} does not exist`);

      if (update.status !== undefined) this.#db.query("UPDATE runs SET status = ? WHERE id = ?").run(update.status, id);
      if (update.finishedAt !== undefined) this.#db.query("UPDATE runs SET finished_at = ? WHERE id = ?").run(update.finishedAt, id);
      if (update.cancelRequestedAt !== undefined) {
        this.#db.query("UPDATE runs SET cancel_requested_at = ? WHERE id = ?").run(update.cancelRequestedAt, id);
      }
      if (update.outputs !== undefined) {
        this.#db.query("UPDATE runs SET outputs_json = ? WHERE id = ?").run(jsonOrNull(update.outputs), id);
      }

      for (const [stepId, stepUpdate] of Object.entries(update.steps ?? {})) {
        const stepRow = this.#db
          .query("SELECT step_id FROM steps WHERE run_id = ? AND step_id = ?")
          .get(id, stepId) as { step_id: string } | null;
        if (stepRow === null) throw new StoreError("step_not_found", `step ${stepId} of run ${id} does not exist`);
        this.#updateStep(id, stepId, stepUpdate);
      }
    });
    return this.getRun(id);
  }

  addAttempt(runId: string, stepId: string, attempt: NewAttempt): Attempt {
    this.#assertOpen();
    if (!Number.isInteger(attempt.n) || attempt.n < 1) {
      throw new StoreError("invalid_argument", "attempt number must be a positive integer");
    }
    if (!ATTEMPT_STATUSES.has(attempt.status)) {
      throw new StoreError("invalid_argument", `unknown attempt status ${attempt.status}`);
    }
    this.#immediate(() => {
      const stepRow = this.#db
        .query("SELECT step_id FROM steps WHERE run_id = ? AND step_id = ?")
        .get(runId, stepId) as { step_id: string } | null;
      if (stepRow === null) throw new StoreError("step_not_found", `step ${stepId} of run ${runId} does not exist`);
      const existing = this.#db
        .query("SELECT n FROM attempts WHERE run_id = ? AND step_id = ? AND n = ?")
        .get(runId, stepId, attempt.n) as { n: number } | null;
      if (existing !== null) throw new StoreError("already_exists", `attempt ${attempt.n} of step ${stepId} already exists`);
      this.#insertAttempt(runId, stepId, attempt);
    });
    return this.#attempt(runId, stepId, attempt.n);
  }

  updateAttempt(runId: string, stepId: string, n: number, patch: AttemptUpdate): Attempt {
    this.#assertOpen();
    this.#immediate(() => {
      const row = this.#db
        .query("SELECT n FROM attempts WHERE run_id = ? AND step_id = ? AND n = ?")
        .get(runId, stepId, n) as { n: number } | null;
      if (row === null) throw new StoreError("attempt_not_found", `attempt ${n} of step ${stepId} does not exist`);
      this.#updateAttempt(runId, stepId, n, patch);
    });
    return this.#attempt(runId, stepId, n);
  }

  // --- Logs ------------------------------------------------------------------

  appendLog(runId: string, stepId: string, attempt: number, bytes: Uint8Array): number {
    this.#assertOpen();
    return this.#immediate(() => {
      const row = this.#db
        .query("SELECT log_path FROM attempts WHERE run_id = ? AND step_id = ? AND n = ?")
        .get(runId, stepId, attempt) as { log_path: string } | null;
      if (row === null) throw new StoreError("attempt_not_found", `attempt ${attempt} of step ${stepId} does not exist`);
      const size = appendFile(join(this.dataDir, row.log_path), bytes);
      this.#db.query("UPDATE attempts SET log_size = ? WHERE run_id = ? AND step_id = ? AND n = ?").run(size, runId, stepId, attempt);
      return size;
    });
  }

  readLog(runId: string, stepId: string, attempt: number, offset = 0): LogChunk {
    this.#assertOpen();
    if (!Number.isInteger(offset) || offset < 0) throw new StoreError("invalid_argument", "log offset must be a non-negative integer");
    const row = this.#db
      .query("SELECT log_path FROM attempts WHERE run_id = ? AND step_id = ? AND n = ?")
      .get(runId, stepId, attempt) as { log_path: string } | null;
    if (row === null) throw new StoreError("attempt_not_found", `attempt ${attempt} of step ${stepId} does not exist`);
    const abs = join(this.dataDir, row.log_path);
    if (!existsSync(abs)) return { bytes: new Uint8Array(0), size: 0 };
    return readFileFrom(abs, offset);
  }

  logSize(runId: string, stepId: string, attempt: number): number {
    this.#assertOpen();
    const row = this.#db
      .query("SELECT log_path FROM attempts WHERE run_id = ? AND step_id = ? AND n = ?")
      .get(runId, stepId, attempt) as { log_path: string } | null;
    if (row === null) throw new StoreError("attempt_not_found", `attempt ${attempt} of step ${stepId} does not exist`);
    return fileSizeOf(join(this.dataDir, row.log_path));
  }

  // --- Artifacts -------------------------------------------------------------

  saveArtifact(
    runId: string,
    stepId: string,
    attempt: number,
    name: string,
    type: ValueType,
    content: Uint8Array | string,
    published = true,
  ): Artifact {
    this.#assertOpen();
    requireMatch(STEP_ID_RE, name, "artifact name");
    if (!VALUE_TYPES.has(type)) throw new StoreError("invalid_argument", `unknown artifact type ${type}`);
    if (!Number.isInteger(attempt) || attempt < 1) throw new StoreError("invalid_argument", "attempt must be a positive integer");
    const bytes = toBytes(content);
    const sha = sha256(bytes);
    return this.#immediate(() => {
      const attemptRow = this.#db
        .query("SELECT n FROM attempts WHERE run_id = ? AND step_id = ? AND n = ?")
        .get(runId, stepId, attempt) as { n: number } | null;
      if (attemptRow === null) throw new StoreError("attempt_not_found", `attempt ${attempt} of step ${stepId} does not exist`);
      const existing = this.#db
        .query("SELECT name FROM artifacts WHERE run_id = ? AND step_id = ? AND attempt = ? AND name = ?")
        .get(runId, stepId, attempt, name) as { name: string } | null;
      if (existing !== null) {
        throw new StoreError("already_exists", `artifact ${name} of step ${stepId} attempt ${attempt} already exists`);
      }
      const relPath = join("artifacts", runId, stepId, String(attempt), name);
      atomicWriteFile(join(this.dataDir, relPath), bytes);
      this.#db
        .query("INSERT INTO artifacts (run_id, step_id, attempt, name, type, path, size, sha256, published) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(runId, stepId, attempt, name, type, relPath, bytes.length, sha, published ? 1 : 0);
      return this.#artifact(runId, stepId, attempt, name);
    });
  }

  getArtifact(runId: string, stepId: string, attempt: number, name: string): Artifact {
    this.#assertOpen();
    return this.#artifact(runId, stepId, attempt, name);
  }

  readArtifact(runId: string, stepId: string, attempt: number, name: string): Uint8Array {
    this.#assertOpen();
    const row = this.#db
      .query("SELECT path FROM artifacts WHERE run_id = ? AND step_id = ? AND attempt = ? AND name = ?")
      .get(runId, stepId, attempt, name) as { path: string } | null;
    if (row === null) throw new StoreError("artifact_not_found", `artifact ${name} of step ${stepId} attempt ${attempt} does not exist`);
    const abs = join(this.dataDir, row.path);
    if (!existsSync(abs)) throw new StoreError("artifact_not_found", `artifact ${name} content is missing`);
    return readFileAll(abs);
  }

  listArtifacts(runId: string, stepId?: string): Artifact[] {
    this.#assertOpen();
    const rows =
      stepId === undefined
        ? (this.#db
            .query("SELECT run_id, step_id, attempt, name, type, path, size, sha256, published FROM artifacts WHERE run_id = ? ORDER BY step_id ASC, attempt ASC, name ASC")
            .all(runId) as ArtifactRow[])
        : (this.#db
            .query("SELECT run_id, step_id, attempt, name, type, path, size, sha256, published FROM artifacts WHERE run_id = ? AND step_id = ? ORDER BY attempt ASC, name ASC")
            .all(runId, stepId) as ArtifactRow[]);
    return rows.map((row) => this.#artifactFromRow(row));
  }

  // --- Internals -------------------------------------------------------------

  #assertOpen(): void {
    if (this.#closed) throw new StoreError("store_closed", "store is closed");
  }

  #immediate<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // nothing to roll back
      }
      throw err;
    }
  }

  #blockVersion(name: string, version: number): BlockVersion {
    const row = this.#db
      .query("SELECT name, version, sha256, size, created_at FROM block_versions WHERE name = ? AND version = ?")
      .get(name, version) as BlockRow | null;
    if (row === null) throw new StoreError("block_not_found", `block ${name}@${version} does not exist`);
    return blockVersionFromRow(row);
  }

  #pipeline(name: string, version: number): PipelineRecord {
    const row = this.#pipelineRow(name, version);
    if (row === null) throw new StoreError("pipeline_not_found", `pipeline ${name}@${version} does not exist`);
    return pipelineFromRow(row);
  }

  #pipelineRow(name: string, version: number): PipelineRow | null {
    return this.#db
      .query("SELECT name, version, sha256, yaml, parsed_json, created_at FROM pipelines WHERE name = ? AND version = ?")
      .get(name, version) as PipelineRow | null;
  }

  #getRun(id: string): Run {
    const runRow = this.#db
      .query("SELECT id, pipeline_name, pipeline_version, status, created_at, finished_at, cancel_requested_at, inputs_json, outputs_json FROM runs WHERE id = ?")
      .get(id) as RunRow | null;
    if (runRow === null) throw new StoreError("run_not_found", `run ${id} does not exist`);

    const stepRows = this.#db
      .query("SELECT step_id, name, status, uses, block_name, block_version, block_sha256, needs_json, with_json, outputs_json, failure_json, attempts_used, next_attempt_at FROM steps WHERE run_id = ? ORDER BY position ASC")
      .all(id) as StepRow[];
    const attemptRows = this.#db
      .query("SELECT step_id, n, status, pid, pid_start, started_at, finished_at, exit_code, signal, failure_json, log_path, log_size FROM attempts WHERE run_id = ? ORDER BY n ASC")
      .all(id) as AttemptRow[];

    const attemptsByStep = new Map<string, Attempt[]>();
    for (const row of attemptRows) {
      const list = attemptsByStep.get(row.step_id) ?? [];
      list.push(this.#attemptFromRow(row));
      attemptsByStep.set(row.step_id, list);
    }

    return {
      id: runRow.id,
      pipeline: { name: runRow.pipeline_name, version: runRow.pipeline_version },
      status: runRow.status as RunStatus,
      createdAt: runRow.created_at,
      finishedAt: runRow.finished_at,
      cancelRequestedAt: runRow.cancel_requested_at,
      inputs: parseJson(runRow.inputs_json),
      outputs: parseJson(runRow.outputs_json),
      steps: stepRows.map((row) => ({
        id: row.step_id,
        name: row.name,
        status: row.status as StepStatus,
        needs: parseJson<string[]>(row.needs_json) ?? [],
        with: parseJson(row.with_json),
        outputs: parseJson(row.outputs_json),
        failure: parseJson<Failure>(row.failure_json),
        attemptsUsed: row.attempts_used,
        nextAttemptAt: row.next_attempt_at,
        block: { uses: row.uses, name: row.block_name, version: row.block_version, sha256: row.block_sha256 },
        attempts: attemptsByStep.get(row.step_id) ?? [],
      })),
    };
  }

  #attempt(runId: string, stepId: string, n: number): Attempt {
    const row = this.#db
      .query("SELECT step_id, n, status, pid, pid_start, started_at, finished_at, exit_code, signal, failure_json, log_path, log_size FROM attempts WHERE run_id = ? AND step_id = ? AND n = ?")
      .get(runId, stepId, n) as AttemptRow | null;
    if (row === null) throw new StoreError("attempt_not_found", `attempt ${n} of step ${stepId} does not exist`);
    return this.#attemptFromRow(row);
  }

  #attemptFromRow(row: AttemptRow): Attempt {
    return {
      n: row.n,
      status: row.status as AttemptStatus,
      pid: row.pid,
      pidStart: row.pid_start,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      exitCode: row.exit_code,
      signal: row.signal,
      failure: parseJson<Failure>(row.failure_json),
      logSize: fileSizeOf(join(this.dataDir, row.log_path)),
    };
  }

  #insertStep(runId: string, step: NewStep, position: number): void {
    if (step.block.version !== null) {
      const blockRow = this.#db
        .query("SELECT sha256 FROM block_versions WHERE name = ? AND version = ?")
        .get(step.block.name, step.block.version) as { sha256: string } | null;
      if (blockRow === null) {
        throw new StoreError("block_not_found", `block ${step.block.name}@${step.block.version} does not exist`);
      }
      if (blockRow.sha256 !== step.block.sha256) {
        throw new StoreError(
          "version_conflict",
          `block ${step.block.name}@${step.block.version} has sha256 ${blockRow.sha256}, run records ${step.block.sha256}`,
        );
      }
    }
    this.#db
      .query(
        "INSERT INTO steps (run_id, step_id, position, name, status, uses, block_name, block_version, block_sha256, needs_json, with_json, outputs_json, failure_json, attempts_used, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        runId,
        step.id,
        position,
        step.name,
        step.status,
        step.block.uses,
        step.block.name,
        step.block.version,
        step.block.sha256,
        json(step.needs ?? []),
        jsonOrNull(step.with),
        jsonOrNull(step.outputs),
        jsonOrNull(step.failure),
        step.attemptsUsed ?? 0,
        step.nextAttemptAt ?? null,
      );
  }

  #insertAttempt(runId: string, stepId: string, attempt: NewAttempt): void {
    const relPath = join("logs", runId, stepId, `${attempt.n}.log`);
    this.#db
      .query(
        "INSERT INTO attempts (run_id, step_id, n, status, pid, pid_start, started_at, finished_at, exit_code, signal, failure_json, log_path, log_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .run(
        runId,
        stepId,
        attempt.n,
        attempt.status,
        attempt.pid ?? null,
        attempt.pidStart ?? null,
        attempt.startedAt ?? null,
        attempt.finishedAt ?? null,
        attempt.exitCode ?? null,
        attempt.signal ?? null,
        jsonOrNull(attempt.failure),
        relPath,
      );
  }

  #updateStep(runId: string, stepId: string, update: StepUpdate): void {
    const sets: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (update.status !== undefined) {
      sets.push("status = ?");
      params.push(update.status);
    }
    if (update.with !== undefined) {
      sets.push("with_json = ?");
      params.push(jsonOrNull(update.with));
    }
    if (update.outputs !== undefined) {
      sets.push("outputs_json = ?");
      params.push(jsonOrNull(update.outputs));
    }
    if (update.failure !== undefined) {
      sets.push("failure_json = ?");
      params.push(jsonOrNull(update.failure));
    }
    if (update.attemptsUsed !== undefined) {
      sets.push("attempts_used = ?");
      params.push(update.attemptsUsed);
    }
    if (update.nextAttemptAt !== undefined) {
      sets.push("next_attempt_at = ?");
      params.push(update.nextAttemptAt);
    }
    if (sets.length === 0) return;
    this.#db.query(`UPDATE steps SET ${sets.join(", ")} WHERE run_id = ? AND step_id = ?`).run(...params, runId, stepId);
  }

  #updateAttempt(runId: string, stepId: string, n: number, patch: AttemptUpdate): void {
    const sets: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.pid !== undefined) {
      sets.push("pid = ?");
      params.push(patch.pid);
    }
    if (patch.pidStart !== undefined) {
      sets.push("pid_start = ?");
      params.push(patch.pidStart);
    }
    if (patch.startedAt !== undefined) {
      sets.push("started_at = ?");
      params.push(patch.startedAt);
    }
    if (patch.finishedAt !== undefined) {
      sets.push("finished_at = ?");
      params.push(patch.finishedAt);
    }
    if (patch.exitCode !== undefined) {
      sets.push("exit_code = ?");
      params.push(patch.exitCode);
    }
    if (patch.signal !== undefined) {
      sets.push("signal = ?");
      params.push(patch.signal);
    }
    if (patch.failure !== undefined) {
      sets.push("failure_json = ?");
      params.push(jsonOrNull(patch.failure));
    }
    if (sets.length === 0) return;
    this.#db.query(`UPDATE attempts SET ${sets.join(", ")} WHERE run_id = ? AND step_id = ? AND n = ?`).run(...params, runId, stepId, n);
  }

  #artifact(runId: string, stepId: string, attempt: number, name: string): Artifact {
    const row = this.#db
      .query("SELECT run_id, step_id, attempt, name, type, path, size, sha256, published FROM artifacts WHERE run_id = ? AND step_id = ? AND attempt = ? AND name = ?")
      .get(runId, stepId, attempt, name) as ArtifactRow | null;
    if (row === null) throw new StoreError("artifact_not_found", `artifact ${name} of step ${stepId} attempt ${attempt} does not exist`);
    return this.#artifactFromRow(row);
  }

  #artifactFromRow(row: ArtifactRow): Artifact {
    return {
      runId: row.run_id,
      stepId: row.step_id,
      attempt: row.attempt,
      name: row.name,
      type: row.type as ValueType,
      size: row.size,
      path: join(this.dataDir, row.path),
      sha256: row.sha256,
      published: row.published === 1,
    };
  }
}

export function openStore(dataDir?: string, options?: StoreOptions): Store {
  return new Store(dataDir ?? defaultStoreDir(), options);
}

function blockVersionFromRow(row: BlockRow): BlockVersion {
  return { name: row.name, version: row.version, sha256: row.sha256, size: row.size, createdAt: row.created_at };
}

function pipelineFromRow(row: PipelineRow): PipelineRecord {
  return {
    name: row.name,
    version: row.version,
    sha256: row.sha256,
    yaml: row.yaml,
    parsed: JSON.parse(row.parsed_json) as unknown,
    createdAt: row.created_at,
  };
}
