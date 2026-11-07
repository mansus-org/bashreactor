// The narrow persistence interface the engine talks to. packages/store (BASHR-4) will implement it;
// FsRunStore here is the minimal file-backed implementation the engine's tests use, including the
// restart test, which needs a store that outlives the engine process.

import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BashreactorError } from "@bashreactor/core";
import { RUN_ID_RE } from "./run.ts";
import type { RunRecord } from "./run.ts";

export interface EngineClaim {
  pid: number;
  pid_start: number;
}

export interface RunFiles {
  pipeline: Uint8Array;
  blocks: { sha256: string; bytes: Uint8Array }[];
  fileInputs: { name: string; bytes: Uint8Array }[];
}

export interface FileStat {
  kind: "file" | "directory" | "other" | "missing";
}

export interface RunLayout {
  runDir: string;
  runJson: string;
  lock: string;
  cancelRequest: string;
  pipelineSnapshot: string;
  blockPath(sha256: string): string;
  inputPath(name: string): string;
  workDir(stepId: string): string;
  attemptDir(stepId: string, n: number): string;
  attemptOutputsDir(stepId: string, n: number): string;
  attemptTmpDir(stepId: string, n: number): string;
  attemptLogPath(stepId: string, n: number): string;
  outputPath(stepId: string, n: number, name: string): string;
}

export type ClaimResult = "claimed" | "exists" | "missing";

export interface RunStore {
  layout(runId: string): RunLayout;
  createRun(record: RunRecord, files: RunFiles): Promise<void>;
  saveRun(record: RunRecord): Promise<void>;
  loadRun(runId: string): Promise<RunRecord | null>;
  listRunIds(): Promise<string[]>;
  /**
   * Take a run's whole directory away (SPEC 4.2). The only method here that destroys anything, so it
   * is the one that refuses a name that is not a run id: every other path it could build is under
   * `runs/`, and this one would be a tree somewhere else.
   */
  removeRun(runId: string): Promise<void>;

  tryClaim(runId: string, claim: EngineClaim): Promise<ClaimResult>;
  loadClaim(runId: string): Promise<EngineClaim | null>;
  releaseClaim(runId: string): Promise<void>;

  writeCancelRequest(runId: string): Promise<void>;
  hasCancelRequest(runId: string): Promise<boolean>;
  clearCancelRequest(runId: string): Promise<void>;

  writeFile(runId: string, rel: string, data: Uint8Array, mode?: number): Promise<void>;
  readFile(runId: string, rel: string): Promise<Uint8Array | null>;
  /** At most `length` bytes from `offset`, plus the file's size after the read. Null when the file is missing. */
  readFileRange(runId: string, rel: string, offset: number, length: number): Promise<{ bytes: Uint8Array; size: number } | null>;
  stat(runId: string, rel: string): Promise<FileStat>;
  chmod(runId: string, rel: string, mode: number): Promise<void>;
  remove(runId: string, rel: string): Promise<void>;
  ensureDir(runId: string, rel: string): Promise<void>;

  homePath(): string;
}

export class FsRunStore implements RunStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(join(root, "runs"), { recursive: true });
    mkdirSync(join(root, "home"), { recursive: true });
  }

  layout(runId: string): RunLayout {
    const runDir = join(this.root, "runs", runId);
    const stepsDir = (stepId: string) => join(runDir, "steps", stepId);
    return {
      runDir,
      runJson: join(runDir, "run.json"),
      lock: join(runDir, "lock"),
      cancelRequest: join(runDir, "cancel.request"),
      pipelineSnapshot: join(runDir, "pipeline.yaml"),
      blockPath: (sha256) => join(runDir, "blocks", `${sha256}.sh`),
      inputPath: (name) => join(runDir, "inputs", name),
      workDir: (stepId) => join(stepsDir(stepId), "work"),
      attemptDir: (stepId, n) => join(stepsDir(stepId), "attempts", String(n)),
      attemptOutputsDir: (stepId, n) => join(stepsDir(stepId), "attempts", String(n), "outputs"),
      attemptTmpDir: (stepId, n) => join(stepsDir(stepId), "attempts", String(n), "tmp"),
      attemptLogPath: (stepId, n) => join(stepsDir(stepId), "attempts", String(n), "log"),
      outputPath: (stepId, n, name) => join(stepsDir(stepId), "attempts", String(n), "outputs", name),
    };
  }

  homePath(): string {
    return join(this.root, "home");
  }

  async createRun(record: RunRecord, files: RunFiles): Promise<void> {
    const tmpName = `.tmp-${record.id}`;
    const tmpDir = this.layout(tmpName).runDir;
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(join(tmpDir, "blocks"), { recursive: true });
    mkdirSync(join(tmpDir, "inputs"), { recursive: true });
    writeFileSync(join(tmpDir, "pipeline.yaml"), files.pipeline);
    for (const block of files.blocks) writeFileSync(join(tmpDir, "blocks", `${block.sha256}.sh`), block.bytes);
    for (const input of files.fileInputs) writeFileSync(join(tmpDir, "inputs", input.name), input.bytes, { mode: 0o444 });
    writeAtomic(this.layout(tmpName).runJson, JSON.stringify(record, null, 2));
    renameSync(tmpDir, this.layout(record.id).runDir);
  }

  async saveRun(record: RunRecord): Promise<void> {
    writeAtomic(this.layout(record.id).runJson, JSON.stringify(record, null, 2));
  }

  async loadRun(runId: string): Promise<RunRecord | null> {
    const bytes = readIfExists(this.layout(runId).runJson);
    if (bytes === null) return null;
    return JSON.parse(new TextDecoder().decode(bytes)) as RunRecord;
  }

  async listRunIds(): Promise<string[]> {
    const runsDir = join(this.root, "runs");
    if (!existsSync(runsDir)) return [];
    return readdirSync(runsDir).filter((name) => !name.startsWith(".tmp-"));
  }

  async removeRun(runId: string): Promise<void> {
    if (!RUN_ID_RE.test(runId)) throw new BashreactorError("run_not_found", `"${runId}" is not a run id`);
    const { runDir } = this.layout(runId);
    // `force`, so deleting twice is the same answer as deleting once. A run directory that is a
    // symlink goes as the link and not as whatever it points at: `rmSync` lstats what it walks.
    rmSync(runDir, { recursive: true, force: true });
  }

  async tryClaim(runId: string, claim: EngineClaim): Promise<ClaimResult> {
    const lockPath = this.layout(runId).lock;
    if (!existsSync(this.layout(runId).runDir)) return "missing";
    try {
      writeFileSync(lockPath, JSON.stringify(claim), { flag: "wx" });
      return "claimed";
    } catch {
      return "exists";
    }
  }

  async loadClaim(runId: string): Promise<EngineClaim | null> {
    const bytes = readIfExists(this.layout(runId).lock);
    if (bytes === null) return null;
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as EngineClaim;
    } catch {
      return null;
    }
  }

  async releaseClaim(runId: string): Promise<void> {
    const lockPath = this.layout(runId).lock;
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // already gone
    }
  }

  async writeCancelRequest(runId: string): Promise<void> {
    writeFileSync(this.layout(runId).cancelRequest, new Uint8Array());
  }

  async hasCancelRequest(runId: string): Promise<boolean> {
    return existsSync(this.layout(runId).cancelRequest);
  }

  async clearCancelRequest(runId: string): Promise<void> {
    try {
      rmSync(this.layout(runId).cancelRequest, { force: true });
    } catch {
      // already gone
    }
  }

  async writeFile(runId: string, rel: string, data: Uint8Array, mode?: number): Promise<void> {
    const target = join(this.layout(runId).runDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data, mode === undefined ? {} : { mode });
  }

  async readFile(runId: string, rel: string): Promise<Uint8Array | null> {
    return readIfExists(join(this.layout(runId).runDir, rel));
  }

  async readFileRange(
    runId: string,
    rel: string,
    offset: number,
    length: number,
  ): Promise<{ bytes: Uint8Array; size: number } | null> {
    let fd: number;
    try {
      fd = openSync(join(this.layout(runId).runDir, rel), "r");
    } catch {
      return null;
    }
    try {
      const buffer = new Uint8Array(length);
      let filled = 0;
      // readSync may return short of what was asked; only a zero means the end of the file.
      while (filled < length) {
        const got = readSync(fd, buffer, filled, length - filled, offset + filled);
        if (got === 0) break;
        filled += got;
      }
      // Sized after the read, so bytes appended meanwhile still count as "more to read".
      return { bytes: buffer.subarray(0, filled), size: fstatSync(fd).size };
    } finally {
      closeSync(fd);
    }
  }

  async stat(runId: string, rel: string): Promise<FileStat> {
    const target = join(this.layout(runId).runDir, rel);
    let info;
    try {
      info = lstatSync(target);
    } catch {
      return { kind: "missing" };
    }
    if (info.isFile()) return { kind: "file" };
    if (info.isDirectory()) return { kind: "directory" };
    return { kind: "other" };
  }

  async chmod(runId: string, rel: string, mode: number): Promise<void> {
    chmodSync(join(this.layout(runId).runDir, rel), mode);
  }

  async remove(runId: string, rel: string): Promise<void> {
    const target = join(this.layout(runId).runDir, rel);
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // already gone
    }
  }

  async ensureDir(runId: string, rel: string): Promise<void> {
    mkdirSync(join(this.layout(runId).runDir, rel), { recursive: true });
  }
}

function readIfExists(path: string): Uint8Array | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function writeAtomic(target: string, text: string): void {
  const tmp = `${target}.tmp-${Math.random().toString(16).slice(2)}`;
  writeFileSync(tmp, text);
  renameSync(tmp, target);
}
