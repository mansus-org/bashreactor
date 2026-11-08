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

/**
 * What a claim says to a reader that is not the holder: who wrote `lock`, and whether they are still
 * there. `pid_start` stays out of it, because it is only the evidence for `live` and means nothing to
 * anyone who cannot read `/proc`.
 */
export interface ClaimState {
  /** The pid of the engine that wrote `lock`. */
  pid: number;
  /** Whether that pid is still the process that wrote it. A stale claim blocks nothing (SPEC 4.7). */
  live: boolean;
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

/**
 * A directory under `runs/` that is not a run: one `createRun` was halfway through when the process
 * died, or one a delete moved out of the listing before removing it. No listing ever returns these,
 * which is the whole reason they get this prefix — and the reason something has to sweep them.
 */
export const TEMP_PREFIX = ".tmp-";

/** What a directory that will not go away costs: the name, and why. */
export interface PruneResult {
  /** Temp directories removed. */
  removed: string[];
  /** Temp directories still there, with the filesystem's reason each one stayed. */
  failed: string[];
}

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
  /**
   * Remove `runs/${TEMP_PREFIX}*` directories whose own mtime is older than `olderThanMs` (SPEC
   * 4.11). They belong to no run, so nothing else will ever look at them: a crashed `createRun` and a
   * delete the filesystem refused both leave one, and on a volume whose whole problem is that it
   * fills up, "invisible" must not mean "forgotten". Never throws — a directory it cannot remove
   * comes back in `failed`.
   */
  pruneTempDirs(olderThanMs: number): Promise<PruneResult>;

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
    const tmpName = `${TEMP_PREFIX}${record.id}`;
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
    return readdirSync(runsDir).filter((name) => !name.startsWith(TEMP_PREFIX));
  }

  /**
   * Remove a run whole, or not at all — which is the hard half of the promise (SPEC 4.11). `rmSync
   * -r` walks depth-first and throws the moment it meets something it cannot unlink, and a block can
   * easily leave a read-only tree in its work dir (a Go module cache does, `npm` sometimes does):
   * the run would be half gone, and if `run.json` was the file that went first then nothing can name
   * the directory again. So the directory is renamed out of the listing first — one atomic call,
   * after which the run does not exist as far as every reader is concerned — and only the renamed
   * copy is removed. Whatever a refusing filesystem leaves is a temp directory, and the sweep clears
   * it.
   *
   * A run directory that is a symlink goes as the link and not as whatever it points at: `rmSync`
   * lstats what it walks.
   */
  async removeRun(runId: string): Promise<void> {
    if (!RUN_ID_RE.test(runId)) throw new BashreactorError("run_not_found", `"${runId}" is not a run id`);
    const { runDir } = this.layout(runId);
    try {
      lstatSync(runDir);
    } catch {
      return; // already gone, which is the same answer as deleted
    }
    const staged = join(this.root, "runs", `${TEMP_PREFIX}delete-${runId}`);
    try {
      renameSync(runDir, staged);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new BashreactorError(
        "run_delete_failed",
        `run "${runId}" could not be moved out of the way: ${reason(error)}`,
        { path: runDir },
      );
    }
    removeTree(staged, `run "${runId}"`);
  }

  async pruneTempDirs(olderThanMs: number): Promise<PruneResult> {
    const runsDir = join(this.root, "runs");
    const removed: string[] = [];
    const failed: string[] = [];
    let names: string[];
    try {
      names = readdirSync(runsDir);
    } catch {
      return { removed, failed };
    }
    const cutoff = Date.now() - olderThanMs;
    for (const name of names) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const path = join(runsDir, name);
      let mtime: number;
      try {
        mtime = lstatSync(path).mtimeMs;
      } catch {
        continue;
      }
      // Younger than the retention: it is somebody's in-flight `createRun`, not a leftover.
      if (mtime > cutoff) continue;
      try {
        removeTree(path, `leftover "${name}"`);
        removed.push(name);
      } catch (error) {
        failed.push(`${name}: ${reason(error)}`);
      }
    }
    return { removed, failed };
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

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Make every directory under `path` writable, bottom up. Removing a file needs write permission on
 * the directory holding it, not on the file, so this is what a read-only tree left by a block needs
 * before it can be unlinked. A directory that cannot be chmod'd is passed over: the `rmSync` that
 * follows reports it properly.
 */
function chmodDirsWritable(path: string): void {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // A `Dirent` from `readdirSync` is an `lstat`, so a symlink is not a directory and its target is
    // left alone, which is the whole point.
    if (entry.isDirectory()) chmodDirsWritable(join(path, entry.name));
  }
  try {
    chmodSync(path, 0o700);
  } catch {
    // reported by the removal that follows
  }
}

/** Remove a tree, and if the filesystem refuses, make it writable and try once more. */
function removeTree(path: string, what: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
    return;
  } catch {
    chmodDirsWritable(path);
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (second) {
      throw new BashreactorError(
        "run_delete_failed",
        `${what} could not be removed: ${reason(second)}`,
        { path },
      );
    }
  }
}
