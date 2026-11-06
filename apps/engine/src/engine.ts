// The run engine (BASHR-3): scheduling, state, logs, cancel, retry and resume. It never touches
// the disk for run state itself; everything goes through the RunStore, so packages/store can back
// the same interface later.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  BashreactorError,
  MAX_STEP_INPUT_BYTES,
  MAX_TEXT_BYTES,
  checkLiteral,
  coerce,
  parseBlockHeaderText,
  parsePipeline,
  parseTextForm,
  refsOf,
  renderValue,
  splitBlockHeaderBytes,
  utf8Length,
  validatePipelineSource,
} from "@bashreactor/core";
import type {
  Block,
  ErrorCode,
  ExpressionRef,
  Pipeline,
  PipelineStep,
  Value,
  ValueType,
  WithValue,
} from "@bashreactor/core";
import { readProcStartTime } from "./proc.ts";
import { FINAL_RUN_STATUSES, FINAL_STEP_STATUSES, nowIso, newRunId } from "./run.ts";
import type { AttemptRecord, RunRecord, StepRecord } from "./run.ts";
import type { EngineClaim, RunFiles, RunLayout, RunStore } from "./run-store.ts";
import { checkRuntime } from "./runtime.ts";
import { spawnBlock } from "./spawn.ts";

export interface EngineOptions {
  store: RunStore;
  env?: Record<string, string | undefined>;
  path?: string;
}

interface RunPlan {
  pipeline: Pipeline;
  blocks: Map<string, Block>;
  inputTypes: Map<string, ValueType>;
}

interface ActiveAttempt {
  stepId: string;
  n: number;
  pid: number;
  deadline: number;
  killGraceMs: number;
  timedOut: boolean;
  cancelled: boolean;
  finished: boolean;
  sigtermAt: number | null;
  sigkilled: boolean;
  exit: { exitCode: number | null; signal: string | null } | null;
}

interface DriveState {
  plan: RunPlan;
  active: Map<string, ActiveAttempt>;
  reaped: ActiveAttempt[];
}

interface AttemptOutcome {
  status: "succeeded" | "failed" | "cancelled";
  code: ErrorCode | null;
  retryable: boolean;
  outputs: Record<string, Value> | null;
}

export class Engine {
  readonly store: RunStore;
  readonly env: Record<string, string | undefined>;
  readonly path: string;
  private runtimeMissing: string[] | null = null;
  // Shutdown is carried out by each drive loop itself, at the top of its next turn, so it can never
  // race a step being started or an attempt being recorded: the loop is the only writer of its run.
  private stopping = false;
  private hurried = false;
  private readonly drives = new Set<Promise<unknown>>();

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.env = options.env ?? process.env;
    this.path = options.path ?? process.env.PATH ?? "";
  }

  private async ensureRuntime(): Promise<void> {
    if (this.runtimeMissing === null) this.runtimeMissing = await checkRuntime(this.path);
    if (this.runtimeMissing.length > 0) {
      throw new BashreactorError("runtime_missing", `missing on PATH: ${this.runtimeMissing.join(", ")}`);
    }
  }

  validate(pipelinePath: string): ReturnType<typeof validatePipelineSource> {
    const bytes = readFileSync(pipelinePath);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return validatePipelineSource(source, {
      resolve: (uses) => {
        const block = this.resolveBlockFile(dirname(pipelinePath), uses);
        if (!block.ok) return { ok: false };
        return { ok: true, source: new TextDecoder("utf-8", { fatal: false }).decode(block.bytes) };
      },
    });
  }

  async start(pipelinePath: string, inputs: Record<string, Value> = {}): Promise<RunRecord> {
    await this.ensureRuntime();
    const pipelineBytes = readFileSync(pipelinePath);
    const pipelineSource = new TextDecoder("utf-8", { fatal: true }).decode(pipelineBytes);
    const dir = dirname(pipelinePath);
    const issues = validatePipelineSource(pipelineSource, {
      resolve: (uses) => {
        const block = this.resolveBlockFile(dir, uses);
        if (!block.ok) return { ok: false };
        return { ok: true, source: new TextDecoder("utf-8", { fatal: false }).decode(block.bytes) };
      },
    });
    if (issues.length > 0) {
      const first = issues[0]!;
      throw new BashreactorError(first.code, first.message, { path: first.path, file: pipelinePath });
    }
    const pipeline = parsePipeline(pipelineSource);

    const blocks = new Map<string, { bytes: Uint8Array; block: Block }>();
    for (const step of pipeline.steps) {
      const resolved = this.resolveBlockFile(dir, step.uses);
      if (!resolved.ok) {
        throw new BashreactorError("block_not_found", `block "${step.uses}" was not found`, { path: `steps.${step.id}.uses`, file: pipelinePath });
      }
      const header = splitBlockHeaderBytes(resolved.bytes);
      if (!header.ok) {
        throw new BashreactorError("block_header_malformed", header.error, { path: `steps.${step.id}.uses`, file: pipelinePath });
      }
      blocks.set(step.id, { bytes: resolved.bytes, block: parseBlockHeaderText(header.header) });
    }

    const runInputs = this.checkRunInputs(pipeline, inputs);
    for (const step of pipeline.steps) {
      for (const name of step.pass_env) {
        if (this.env[name] === undefined) {
          throw new BashreactorError("env_missing", `environment variable "${name}" is not set`, { path: `steps.${step.id}.pass_env`, file: pipelinePath });
        }
      }
    }

    const id = newRunId();
    const stepRecords: Record<string, StepRecord> = {};
    for (const step of pipeline.steps) {
      const { block, bytes } = blocks.get(step.id)!;
      stepRecords[step.id] = {
        id: step.id,
        name: step.name,
        status: "pending",
        block: { uses: step.uses, name: block.name, sha256: sha256(bytes) },
        needs: effectiveNeeds(step, pipeline),
        with: null,
        outputs: null,
        failure: null,
        attempts_used: 0,
        next_attempt_at: null,
        attempts: [],
      };
    }

    const record: RunRecord = {
      schema: 1,
      id,
      pipeline: pipeline.name,
      status: "running",
      created_at: nowIso(),
      finished_at: null,
      cancel_requested_at: null,
      inputs: runInputs.values,
      outputs: null,
      steps: stepRecords,
    };

    const files: RunFiles = {
      pipeline: pipelineBytes,
      blocks: [...blocks.values()].map(({ bytes }) => ({ sha256: sha256(bytes), bytes })),
      fileInputs: runInputs.files.map((file) => ({ name: file.name, bytes: file.bytes })),
    };
    await this.store.createRun(record, files);
    return record;
  }

  async drive(runId: string): Promise<RunRecord> {
    return this.track(async () => {
      await this.claim(runId);
      return this.runLoop(runId);
    });
  }

  async resume(runId: string): Promise<RunRecord> {
    return this.drive(runId);
  }

  async retry(runId: string): Promise<RunRecord> {
    return this.track(async () => {
      const record = await this.store.loadRun(runId);
      if (record === null) throw new BashreactorError("run_not_found", `run "${runId}" does not exist`);
      if (record.status !== "failed" && record.status !== "cancelled") {
        throw new BashreactorError("run_not_retryable", `run "${runId}" is ${record.status}, not failed or cancelled`);
      }
      await this.claim(runId);
      for (const step of Object.values(record.steps)) {
        if (step.status === "failed" || step.status === "skipped" || step.status === "cancelled") {
          step.status = "pending";
          step.with = null;
          step.failure = null;
          step.next_attempt_at = null;
          step.attempts_used = 0;
        }
      }
      record.status = "running";
      record.cancel_requested_at = null;
      record.finished_at = null;
      record.outputs = null;
      await this.store.clearCancelRequest(runId);
      await this.store.saveRun(record);
      return this.runLoop(runId);
    });
  }

  /**
   * SPEC 4.7, graceful shutdown. Stops every drive loop from starting steps, stops the attempts that
   * are running (SIGTERM, `kill_grace`, SIGKILL), marks them interrupted, releases the claims and
   * resolves. The runs stay `running`, so the next engine resumes them. A second call skips the
   * remaining grace: the attempts are killed at once, and the bookkeeping still happens.
   */
  async shutdown(): Promise<void> {
    if (this.stopping) this.hurried = true;
    this.stopping = true;
    await Promise.allSettled([...this.drives]);
  }

  async cancel(runId: string): Promise<void> {
    const record = await this.store.loadRun(runId);
    if (record === null) throw new BashreactorError("run_not_found", `run "${runId}" does not exist`);
    if (record.status !== "running") {
      throw new BashreactorError("run_not_active", `run "${runId}" is ${record.status}, not running`);
    }
    // The holder sees this file within its poll interval and applies the cancel; a non-holder just
    // leaves it for the next engine to act on (section 4.6).
    await this.store.writeCancelRequest(runId);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.store.loadRun(runId);
  }

  async listRuns(): Promise<string[]> {
    return this.store.listRunIds();
  }

  async readLog(runId: string, stepId: string, attempt: number, offset: number): Promise<{ data: Uint8Array; nextOffset: number }> {
    const bytes = (await this.store.readFile(runId, `steps/${stepId}/attempts/${attempt}/log`)) ?? new Uint8Array();
    const data = bytes.slice(offset);
    return { data, nextOffset: bytes.length };
  }

  // --- internals ----------------------------------------------------------

  private resolveBlockFile(dir: string, uses: string): { ok: true; bytes: Uint8Array } | { ok: false } {
    if (!uses.startsWith("./") && !uses.startsWith("../")) return { ok: false }; // library refs need a library
    try {
      return { ok: true, bytes: readFileSync(join(dir, uses)) };
    } catch {
      return { ok: false };
    }
  }

  private checkRunInputs(
    pipeline: Pipeline,
    provided: Record<string, Value>,
  ): { values: Record<string, Value>; files: { name: string; bytes: Uint8Array }[] } {
    const values: Record<string, Value> = {};
    const files: { name: string; bytes: Uint8Array }[] = [];
    const known = new Set(pipeline.inputs.map((input) => input.name));
    for (const name of Object.keys(provided)) {
      if (!known.has(name)) {
        throw new BashreactorError("unknown_input", `unknown input "${name}"`, { path: `inputs.${name}` });
      }
    }
    for (const input of pipeline.inputs) {
      const given = provided[input.name];
      if (given === undefined) {
        if (input.default === undefined) {
          throw new BashreactorError("missing_input", `input "${input.name}" is required`, { path: `inputs.${input.name}` });
        }
        values[input.name] = input.default;
        continue;
      }
      if (input.type === "file") {
        if (typeof given !== "string") {
          throw new BashreactorError("type_mismatch", `input "${input.name}" must be a file path`, { path: `inputs.${input.name}` });
        }
        const absolute = isAbsolute(given) ? given : resolve(process.cwd(), given);
        let bytes: Uint8Array;
        try {
          bytes = readFileSync(absolute);
        } catch {
          throw new BashreactorError("file_input_not_found", `file input "${input.name}" was not found`, { path: `inputs.${input.name}` });
        }
        if (!lstatSync(absolute).isFile()) {
          throw new BashreactorError("file_input_not_found", `file input "${input.name}" is not a regular file`, { path: `inputs.${input.name}` });
        }
        files.push({ name: input.name, bytes });
        values[input.name] = `inputs/${input.name}`;
        continue;
      }
      const literal = checkLiteral(input.type, given);
      if (!literal.ok) {
        throw new BashreactorError("type_mismatch", `input "${input.name}": ${literal.message}`, { path: `inputs.${input.name}` });
      }
      values[input.name] = literal.value;
    }
    return { values, files };
  }

  private async claim(runId: string): Promise<EngineClaim> {
    const record = await this.store.loadRun(runId);
    if (record === null) throw new BashreactorError("run_not_found", `run "${runId}" does not exist`);
    const claim: EngineClaim = { pid: process.pid, pid_start: readProcStartTime(process.pid) ?? 0 };
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await this.store.tryClaim(runId, claim);
      if (result === "claimed") return claim;
      if (result === "missing") throw new BashreactorError("run_not_found", `run "${runId}" does not exist`);
      const existing = await this.store.loadClaim(runId);
      if (existing === null) continue;
      if (readProcStartTime(existing.pid) !== existing.pid_start) {
        await this.store.releaseClaim(runId);
        continue;
      }
      throw new BashreactorError("run_claimed", `run "${runId}" is claimed by a live engine`);
    }
    throw new BashreactorError("run_claimed", `run "${runId}" is claimed by a live engine`);
  }

  private async loadPlan(runId: string): Promise<RunPlan> {
    const record = await this.store.loadRun(runId);
    if (record === null) throw new BashreactorError("run_not_found", `run "${runId}" does not exist`);
    const pipelineBytes = (await this.store.readFile(runId, "pipeline.yaml")) ?? new Uint8Array();
    const pipeline = parsePipeline(new TextDecoder("utf-8", { fatal: true }).decode(pipelineBytes));
    const blocks = new Map<string, Block>();
    for (const step of Object.values(record.steps)) {
      const bytes = (await this.store.readFile(runId, `blocks/${step.block.sha256}.sh`)) ?? new Uint8Array();
      const header = splitBlockHeaderBytes(bytes);
      blocks.set(step.id, parseBlockHeaderText(header.ok ? header.header : ""));
    }
    return { pipeline, blocks, inputTypes: new Map(pipeline.inputs.map((input) => [input.name, input.type])) };
  }

  private track<T>(work: () => Promise<T>): Promise<T> {
    const running = work();
    const entry = running.catch(() => undefined);
    this.drives.add(entry);
    void entry.then(() => this.drives.delete(entry));
    return running;
  }

  private async runLoop(runId: string): Promise<RunRecord> {
    const plan = await this.loadPlan(runId);
    const state: DriveState = { plan, active: new Map(), reaped: [] };
    const initial = await this.store.loadRun(runId);
    if (initial !== null) await this.interruptRunning(initial, state);
    try {
      while (true) {
        const record = await this.store.loadRun(runId);
        if (record === null) throw new BashreactorError("run_not_found", `run "${runId}" does not exist`);
        if (this.stopping) {
          await this.windDown(record, state);
          return record;
        }
        if (await this.store.hasCancelRequest(runId)) {
          await this.applyCancel(record, state);
          await this.store.clearCancelRequest(runId);
        }
        await this.reap(record, state);
        this.checkTimeouts(state);
        await this.schedule(record, state);
        this.updateRunStatus(record, plan);
        await this.store.saveRun(record);
        if (FINAL_RUN_STATUSES.has(record.status)) return record;
        await Bun.sleep(100);
      }
    } finally {
      await this.store.releaseClaim(runId);
    }
  }

  private async applyCancel(record: RunRecord, state: DriveState): Promise<void> {
    if (record.status !== "running") return;
    record.cancel_requested_at = nowIso();
    for (const step of Object.values(record.steps)) {
      if (step.status === "pending" || step.status === "waiting_retry") {
        step.status = "cancelled";
        step.next_attempt_at = null;
      } else if (step.status === "running") {
        const attempt = state.active.get(step.id);
        if (attempt !== undefined && !attempt.finished && !attempt.cancelled) {
          attempt.cancelled = true;
          attempt.sigtermAt = Date.now();
          sendGroupSignal(attempt.pid, "SIGTERM");
        }
      }
    }
  }

  private async interruptRunning(record: RunRecord, state: DriveState): Promise<void> {
    let changed = false;
    for (const step of Object.values(record.steps)) {
      if (step.status !== "running") continue;
      const attempt = step.attempts[step.attempts.length - 1];
      if (attempt !== undefined && attempt.pid !== null && attempt.pid_start !== null
        && readProcStartTime(attempt.pid) === attempt.pid_start) {
        await this.stopProcessGroup(attempt.pid, this.killGraceMs(state, step.id));
      }
      this.markInterrupted(record, step, "engine restart");
      changed = true;
    }
    if (changed) await this.store.saveRun(record);
  }

  // The rules of section 4.7 for an attempt cut off by an engine going away, shared by resume and
  // shutdown so there is one copy of them.
  private markInterrupted(record: RunRecord, step: StepRecord, message: string): void {
    const attempt = step.attempts[step.attempts.length - 1];
    if (attempt !== undefined) {
      attempt.status = "interrupted";
      attempt.finished_at = nowIso();
      attempt.failure = { code: "interrupted", message };
    }
    step.status = record.cancel_requested_at !== null ? "cancelled" : "pending";
  }

  private killGraceMs(state: DriveState, stepId: string): number {
    return (state.plan.pipeline.steps.find((s) => s.id === stepId)?.kill_grace ?? 30) * 1000;
  }

  // Runs on the drive loop's own turn, so nothing else is starting or recording an attempt. Attempts
  // that ended by themselves before shutdown began are recorded as they ended; the rest are stopped
  // and interrupted, never read as a timeout, a signal death or a retry.
  private async windDown(record: RunRecord, state: DriveState): Promise<void> {
    await this.reap(record, state);
    const live = [...state.active.values()].filter((attempt) => !attempt.finished);
    await Promise.all(live.map((attempt) => {
      // An attempt already in its grace period (timeout or cancel) has had its SIGTERM; it keeps the
      // clock it was on instead of getting a second signal and a fresh grace.
      const termed = attempt.sigtermAt;
      const graceLeft = termed === null ? attempt.killGraceMs : Math.max(0, termed + attempt.killGraceMs - Date.now());
      return this.stopProcessGroup(attempt.pid, graceLeft, termed === null);
    }));
    for (const attempt of live) {
      const step = record.steps[attempt.stepId]!;
      const attemptRecord = step.attempts.find((a) => a.n === attempt.n)!;
      if (attempt.cancelled) {
        attemptRecord.status = "cancelled";
        attemptRecord.finished_at = nowIso();
        attemptRecord.failure = { code: "cancelled", message: "cancelled" };
        step.status = "cancelled";
      } else {
        this.markInterrupted(record, step, "engine shutdown");
      }
      state.active.delete(attempt.stepId);
    }
    // Whatever exited meanwhile was caused by the signals above and must not be read as a result.
    state.reaped.length = 0;
    this.updateRunStatus(record, state.plan);
    await this.store.saveRun(record);
  }

  private async stopProcessGroup(pgid: number, killGraceMs: number, sendTerm = true): Promise<void> {
    if (sendTerm) sendGroupSignal(pgid, "SIGTERM");
    const deadline = Date.now() + killGraceMs;
    while (!this.hurried && readProcStartTime(pgid) !== null && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    sendGroupSignal(pgid, "SIGKILL");
    // SIGKILL is not instant: the leader stays in /proc as a zombie until it is reaped. Waiting for it
    // makes "stopped" true when this returns, which the interrupted mark that follows claims.
    const gone = Date.now() + 2000;
    while (readProcStartTime(pgid) !== null && Date.now() < gone) {
      await Bun.sleep(10);
    }
  }

  private async reap(record: RunRecord, state: DriveState): Promise<void> {
    while (state.reaped.length > 0) {
      const attempt = state.reaped.shift()!;
      await this.finishAttempt(attempt, record, state);
    }
  }

  private checkTimeouts(state: DriveState): void {
    const now = Date.now();
    for (const attempt of state.active.values()) {
      if (attempt.finished) continue;
      if (!attempt.timedOut && now >= attempt.deadline) {
        attempt.timedOut = true;
        attempt.sigtermAt = now;
        sendGroupSignal(attempt.pid, "SIGTERM");
      } else if (attempt.timedOut && !attempt.sigkilled && attempt.sigtermAt !== null && now >= attempt.sigtermAt + attempt.killGraceMs) {
        attempt.sigkilled = true;
        sendGroupSignal(attempt.pid, "SIGKILL");
      }
    }
  }

  private async schedule(record: RunRecord, state: DriveState): Promise<void> {
    if (record.cancel_requested_at !== null || this.stopping) return;
    const maxParallel = state.plan.pipeline.max_parallel;
    const running = [...state.active.values()].filter((attempt) => !attempt.finished).length;
    let started = 0;
    for (const step of Object.values(record.steps)) {
      if (running + started >= maxParallel || this.stopping) return;
      if (!this.isEligible(step, record)) continue;
      await this.startStep(record, step.id, state);
      if (record.steps[step.id]!.status === "running") started += 1;
    }
  }

  private isEligible(step: StepRecord, record: RunRecord): boolean {
    if (step.status === "pending") {
      return step.needs.every((need) => record.steps[need]?.status === "succeeded");
    }
    if (step.status === "waiting_retry" && step.next_attempt_at !== null) {
      return Date.parse(step.next_attempt_at) <= Date.now() && step.needs.every((need) => record.steps[need]?.status === "succeeded");
    }
    return false;
  }

  private async startStep(record: RunRecord, stepId: string, state: DriveState): Promise<void> {
    const step = record.steps[stepId]!;
    const pipelineStep = state.plan.pipeline.steps.find((s) => s.id === stepId)!;
    const block = state.plan.blocks.get(stepId)!;

    if (step.with === null) {
      try {
        step.with = this.bindWith(pipelineStep, block, record, state.plan);
      } catch (error) {
        if (error instanceof BashreactorError && error.code === "input_too_large") {
          step.status = "failed";
          step.failure = { code: error.code, message: error.message };
          this.skipDownstream(record, stepId);
          return;
        }
        throw error;
      }
    }

    for (const name of pipelineStep.pass_env) {
      if (this.env[name] === undefined) {
        step.status = "failed";
        step.failure = { code: "env_missing", message: `environment variable "${name}" is not set` };
        this.skipDownstream(record, stepId);
        return;
      }
    }

    const layout = this.store.layout(record.id);
    const before = { status: step.status, next_attempt_at: step.next_attempt_at };
    const n = (step.attempts[step.attempts.length - 1]?.n ?? 0) + 1;
    await this.store.ensureDir(record.id, `steps/${stepId}/work`);
    await this.store.ensureDir(record.id, `steps/${stepId}/attempts/${n}/outputs`);
    await this.store.ensureDir(record.id, `steps/${stepId}/attempts/${n}/tmp`);
    await this.store.writeFile(record.id, `steps/${stepId}/attempts/${n}/log`, new Uint8Array());

    const attemptRecord: AttemptRecord = {
      n,
      status: "running",
      pid: null,
      pid_start: null,
      started_at: null,
      finished_at: null,
      exit_code: null,
      signal: null,
      failure: null,
    };
    step.attempts.push(attemptRecord);
    step.status = "running";
    step.next_attempt_at = null;
    await this.store.saveRun(record);

    // The awaits above are where a shutdown can begin. Nothing after this check awaits before the
    // spawn, so no process starts once the flag is set; the attempt just recorded is taken back.
    if (this.stopping) {
      step.attempts.pop();
      step.status = before.status;
      step.next_attempt_at = before.next_attempt_at;
      await this.store.saveRun(record);
      return;
    }

    let proc;
    try {
      proc = spawnBlock({
        blockPath: layout.blockPath(step.block.sha256),
        cwd: layout.workDir(stepId),
        env: this.buildEnv(record, stepId, n, block, pipelineStep, layout),
        logPath: layout.attemptLogPath(stepId, n),
      });
    } catch (error) {
      attemptRecord.status = "failed";
      attemptRecord.finished_at = nowIso();
      attemptRecord.failure = { code: "spawn_failed", message: (error as Error).message };
      step.status = "failed";
      step.failure = { code: "spawn_failed", message: (error as Error).message };
      step.attempts_used += 1;
      this.skipDownstream(record, stepId);
      await this.store.saveRun(record);
      return;
    }

    const pid = proc.pid;
    const active: ActiveAttempt = {
      stepId,
      n,
      pid,
      deadline: Date.now() + pipelineStep.timeout * 1000,
      killGraceMs: pipelineStep.kill_grace * 1000,
      timedOut: false,
      cancelled: false,
      finished: false,
      sigtermAt: null,
      sigkilled: false,
      exit: null,
    };
    attemptRecord.pid = pid;
    attemptRecord.pid_start = readProcStartTime(pid) ?? 0;
    attemptRecord.started_at = nowIso();
    state.active.set(stepId, active);
    proc.exited.then(() => {
      active.exit = { exitCode: proc.exitCode, signal: signalName(proc.signalCode) };
      active.finished = true;
      state.reaped.push(active);
    });
    await this.store.saveRun(record);
  }

  private buildEnv(
    record: RunRecord,
    stepId: string,
    n: number,
    block: Block,
    pipelineStep: PipelineStep,
    layout: RunLayout,
  ): Record<string, string> {
    const env: Record<string, string> = {
      PATH: this.path,
      HOME: this.store.homePath(),
      TMPDIR: layout.attemptTmpDir(stepId, n),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
      PYTHONUNBUFFERED: "1",
      NO_COLOR: "1",
      BR_RUN_ID: record.id,
      BR_STEP_ID: stepId,
      BR_ATTEMPT: String(n),
    };
    const bound = record.steps[stepId]!.with!;
    for (const input of block.inputs) {
      const value = bound[input.name]!;
      env[`INPUT_${input.name.toUpperCase()}`] = renderValue(input.type, absolutize(input.type, value, layout.runDir));
    }
    for (const output of block.outputs) {
      env[`OUTPUT_${output.name.toUpperCase()}`] = layout.outputPath(stepId, n, output.name);
    }
    for (const name of pipelineStep.pass_env) {
      const value = this.env[name];
      if (value !== undefined) env[name] = value;
    }
    return env;
  }

  private bindWith(step: PipelineStep, block: Block, record: RunRecord, plan: RunPlan): Record<string, Value> {
    const result: Record<string, Value> = {};
    const provided = new Map(step.with.map((entry) => [entry.name, entry.value]));
    for (const input of block.inputs) {
      const entry = provided.get(input.name);
      if (entry === undefined) {
        result[input.name] = input.default!;
        continue;
      }
      result[input.name] = this.resolveWithValue(entry, input.type, record, plan);
    }
    let totalBytes = 0;
    for (const input of block.inputs) {
      const rendered = renderValue(input.type, result[input.name]!);
      const bytes = utf8Length(rendered);
      if ((input.type === "string" || input.type === "json") && bytes > MAX_TEXT_BYTES) {
        throw new BashreactorError("input_too_large", `input "${input.name}" is over ${MAX_TEXT_BYTES} bytes`);
      }
      totalBytes += bytes;
    }
    if (totalBytes > MAX_STEP_INPUT_BYTES) {
      throw new BashreactorError("input_too_large", `rendered inputs are over ${MAX_STEP_INPUT_BYTES} bytes`);
    }
    return result;
  }

  private resolveWithValue(value: WithValue, targetType: ValueType, record: RunRecord, plan: RunPlan): Value {
    if (value.kind === "literal") return value.value;
    if (value.kind === "whole") {
      const source = this.resolveRef(value.ref, record, plan);
      return coerce(source.type, targetType, source.value);
    }
    let out = "";
    for (const part of value.parts) {
      if (part.kind === "text") {
        out += part.text;
      } else {
        const source = this.resolveRef(part.ref, record, plan);
        out += renderValue(source.type, source.value);
      }
    }
    return out;
  }

  private resolveRef(ref: ExpressionRef, record: RunRecord, plan: RunPlan): { type: ValueType; value: Value } {
    if (ref.kind === "inputs") {
      const type = plan.inputTypes.get(ref.name)!;
      return { type, value: record.inputs[ref.name]! };
    }
    const step = record.steps[ref.step]!;
    const type = plan.blocks.get(ref.step)!.outputs.find((output) => output.name === ref.output)!.type;
    return { type, value: step.outputs![ref.output]! };
  }

  private async finishAttempt(attempt: ActiveAttempt, record: RunRecord, state: DriveState): Promise<void> {
    const step = record.steps[attempt.stepId]!;
    const pipelineStep = state.plan.pipeline.steps.find((s) => s.id === attempt.stepId)!;
    const block = state.plan.blocks.get(attempt.stepId)!;
    sendGroupSignal(attempt.pid, "SIGKILL");
    await this.store.remove(record.id, `steps/${attempt.stepId}/attempts/${attempt.n}/tmp`);

    const attemptRecord = step.attempts.find((a) => a.n === attempt.n)!;
    attemptRecord.finished_at = nowIso();
    attemptRecord.exit_code = attempt.exit?.exitCode ?? null;
    attemptRecord.signal = attempt.exit?.signal ?? null;

    const outcome = await this.decideOutcome(attempt, record, block);
    attemptRecord.status = outcome.status;
    attemptRecord.failure = outcome.status === "succeeded" || outcome.code === null ? null : { code: outcome.code, message: outcome.code };

    if (outcome.status === "succeeded") {
      step.status = "succeeded";
      step.outputs = outcome.outputs;
      step.failure = null;
      step.attempts_used += 1;
    } else if (outcome.status === "cancelled") {
      step.status = "cancelled";
      step.failure = null;
    } else {
      step.attempts_used += 1;
      if (outcome.retryable && step.attempts_used < pipelineStep.retry.max_attempts) {
        if (record.cancel_requested_at !== null) {
          step.status = "cancelled";
          step.failure = null;
        } else {
          step.status = "waiting_retry";
          step.failure = null;
          step.next_attempt_at = new Date(Date.now() + retryWaitMs(pipelineStep.retry, step.attempts_used) * 1000).toISOString();
        }
      } else {
        step.status = "failed";
        step.failure = outcome.code === null ? null : { code: outcome.code, message: outcome.code };
        this.skipDownstream(record, attempt.stepId);
      }
    }
    state.active.delete(attempt.stepId);
  }

  private async decideOutcome(attempt: ActiveAttempt, record: RunRecord, block: Block): Promise<AttemptOutcome> {
    if (attempt.cancelled) return { status: "cancelled", code: "cancelled", retryable: false, outputs: null };
    if (attempt.timedOut) return { status: "failed", code: "timeout", retryable: true, outputs: null };
    if (attempt.exit?.signal !== null && attempt.exit?.signal !== undefined) {
      return { status: "failed", code: "killed_by_signal", retryable: true, outputs: null };
    }
    if (attempt.exit?.exitCode === 75) return { status: "failed", code: "retry_requested", retryable: true, outputs: null };
    if (attempt.exit?.exitCode === 78) return { status: "failed", code: "block_fatal", retryable: false, outputs: null };
    if (attempt.exit?.exitCode !== 0 && attempt.exit?.exitCode !== null) {
      return { status: "failed", code: "exit_nonzero", retryable: true, outputs: null };
    }
    return this.readOutputs(record, attempt, block);
  }

  private async readOutputs(record: RunRecord, attempt: ActiveAttempt, block: Block): Promise<AttemptOutcome> {
    const outputs: Record<string, Value> = {};
    for (const output of block.outputs) {
      const rel = `steps/${attempt.stepId}/attempts/${attempt.n}/outputs/${output.name}`;
      const stat = await this.store.stat(record.id, rel);
      if (stat.kind === "missing") {
        return { status: "failed", code: "output_missing", retryable: false, outputs: null };
      }
      if (stat.kind !== "file") {
        return { status: "failed", code: "output_invalid", retryable: false, outputs: null };
      }
      if (output.type === "file") {
        await this.store.chmod(record.id, rel, 0o444);
        outputs[output.name] = rel;
        continue;
      }
      const bytes = (await this.store.readFile(record.id, rel)) ?? new Uint8Array();
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return { status: "failed", code: "output_invalid", retryable: false, outputs: null };
      }
      const parsed = parseTextForm(output.type, text);
      if (!parsed.ok) {
        return { status: "failed", code: parsed.code, retryable: false, outputs: null };
      }
      outputs[output.name] = parsed.value;
    }
    return { status: "succeeded", code: null, retryable: false, outputs };
  }

  private skipDownstream(record: RunRecord, failedStepId: string): void {
    const dependsOn = new Map<string, string[]>();
    for (const step of Object.values(record.steps)) {
      for (const need of step.needs) {
        const list = dependsOn.get(need) ?? [];
        list.push(step.id);
        dependsOn.set(need, list);
      }
    }
    const affected = new Set<string>();
    const visit = (id: string): void => {
      for (const downstream of dependsOn.get(id) ?? []) {
        if (affected.has(downstream)) continue;
        affected.add(downstream);
        visit(downstream);
      }
    };
    visit(failedStepId);
    for (const id of affected) {
      const step = record.steps[id]!;
      if (step.status === "pending") step.status = "skipped";
    }
  }

  private updateRunStatus(record: RunRecord, plan: RunPlan): void {
    const steps = Object.values(record.steps);
    const allFinal = steps.every((step) => FINAL_STEP_STATUSES.has(step.status));
    if (!allFinal) {
      record.status = "running";
      record.finished_at = null;
      return;
    }
    if (steps.every((step) => step.status === "succeeded")) {
      record.status = "succeeded";
    } else if (record.cancel_requested_at !== null) {
      record.status = "cancelled";
    } else {
      record.status = "failed";
    }
    record.finished_at = nowIso();
    if (record.status === "succeeded") {
      const outputs: Record<string, Value> = {};
      for (const output of plan.pipeline.outputs) {
        if (output.ref.kind === "step_output") {
          const value = record.steps[output.ref.step]?.outputs?.[output.ref.output];
          if (value !== undefined) outputs[output.name] = value;
        }
      }
      record.outputs = outputs;
    } else {
      record.outputs = null;
    }
  }
}

function effectiveNeeds(step: PipelineStep, pipeline: Pipeline): string[] {
  const order = new Map(pipeline.steps.map((s, i) => [s.id, i]));
  const set = new Set(step.needs);
  for (const entry of step.with) {
    for (const ref of refsOf(entry.value)) {
      if (ref.kind === "step_output") set.add(ref.step);
    }
  }
  return [...set].filter((id) => order.has(id)).toSorted((a, b) => order.get(a)! - order.get(b)!);
}

function retryWaitMs(retry: PipelineStep["retry"], failures: number): number {
  const exponent = Math.max(0, failures - 1);
  const wait = Math.min(retry.max_delay, retry.delay * retry.backoff ** exponent);
  return Math.max(0, wait);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function absolutize(type: ValueType, value: Value, runDir: string): Value {
  if (type === "file" && typeof value === "string" && !isAbsolute(value)) {
    return join(runDir, value);
  }
  return value;
}

function signalName(code: NodeJS.Signals | number | null): string | null {
  if (code === null || code === undefined) return null;
  if (typeof code === "number") return `SIG${code}`;
  return code;
}

function sendGroupSignal(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // the group is already gone
  }
}
