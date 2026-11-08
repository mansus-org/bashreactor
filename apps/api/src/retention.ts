// Trimming the volume (SPEC 4.11).
//
// `$BASHREACTOR_HOME` is given a size — 1 Gi in `.k3s/values.yaml` — and a run writes as much log as
// its blocks produce: one test block wrote 3 MB in under a second. With nothing ever removed, the
// volume fills, and then every write fails at once: the store cannot record a run, the engine
// cannot append a log, and the only symptom is runs failing. So either the server trims, or an
// operator does it from outside. Both are supported; the one answer that is not allowed is silence,
// which is what the deployment shipped with.
//
// The rule kept here is deliberately narrow: **a run that has reached a final status, older than the
// retention, goes**. Not a run that is running (its step is a process group writing into that very
// directory), not a run that has no `finished_at` (nothing to age it by), not a run the retention has
// not reached. Anything the sweep cannot account for is kept and counted, because the failure mode of
// keeping one run too long is a fuller disk, and the failure mode of deleting one too early is
// someone's data.

import { BashreactorError } from "@bashreactor/core";
import { FINAL_RUN_STATUSES, type PruneResult, type RunRecord } from "@bashreactor/engine";

/** How often to sweep when the operator did not say. Trimming is not urgent; an hour is not. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** What the sweep is allowed to ask of the engine, so it can be tested without a running one. */
export interface RunsThatCanBeDeleted {
  listRuns(): Promise<string[]>;
  getRun(runId: string): Promise<RunRecord | null>;
  deleteRun(runId: string): Promise<void>;
  pruneTempDirs(olderThanMs: number): Promise<PruneResult>;
}

/**
 * A duration written back the way `BASHREACTOR_RETENTION` takes it, so a log line can repeat what the
 * operator set rather than printing milliseconds at them.
 */
export function durationText(ms: number): string {
  const units: readonly [number, string][] = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1_000, "s"],
  ];
  let text = "";
  let left = ms;
  for (const [size, suffix] of units) {
    const count = Math.floor(left / size);
    if (count === 0) continue;
    text += `${count}${suffix}`;
    left -= count * size;
  }
  return text === "" ? "0s" : text;
}

export interface RetentionReport {
  /** Runs older than this were removed. */
  cutoff: string;
  /** The ids removed, in the order the listing gave them. */
  deleted: string[];
  /** Everything the sweep looked at and left alone, for one reason or another. */
  kept: number;
  /** The leftover `.tmp-*` directories cleared in the same pass (SPEC 4.11). */
  temp: string[];
  /** The first error that was not "this run is not deletable right now". The sweep finishes anyway. */
  problem: string | null;
}

/**
 * One pass over every run: delete the finished ones whose `finished_at` is older than `olderThanMs`
 * before `now`, then clear the directories that belong to no run.
 *
 * A run that refuses is not a failure of the sweep. `run_claimed` means something is writing into it
 * and `run_not_found` means someone deleted it mid-pass; both are counted as kept and the pass moves
 * on. Any other error is kept as `problem` — the pass still finishes, because one directory that
 * will not go should not strand the rest, and a repeat of the same error is not worth a stack trace
 * per run.
 *
 * Reading a record sits inside the same protection as deleting one: a `run.json` that is not valid
 * JSON makes `getRun` throw, and a single damaged record must not stop the sweep reaching every
 * healthy run after it.
 *
 * The pass yields between runs. A home with thousands of runs is thousands of `stat` and `open` calls
 * on the event loop the server is answering requests on, and a sweep that stalls the process for a
 * second to free space is a bad trade.
 */
export async function sweepRuns(
  engine: RunsThatCanBeDeleted,
  olderThanMs: number,
  options: { now?: Date } = {},
): Promise<RetentionReport> {
  const cutoff = (options.now ?? new Date()).getTime() - olderThanMs;
  const deleted: string[] = [];
  let kept = 0;
  let problem: string | null = null;

  for (const id of await engine.listRuns()) {
    await Bun.sleep(0);
    let record: RunRecord | null;
    try {
      record = await engine.getRun(id);
    } catch (error) {
      problem ??= error instanceof Error ? error.message : String(error);
      kept += 1;
      continue;
    }
    // Gone between the listing and now. Nothing to remove, but it is a run the sweep looked at and
    // did not delete, and `kept` is what says so: a pass reporting `deleted: 0, kept: 0` with a
    // directory still sitting there is the silence this whole file exists to avoid.
    if (record === null) {
      kept += 1;
      continue;
    }
    // Anything short of a final status is somebody else's business: `running` is being written into,
    // and a run with no `finished_at` has not stopped yet. A `finished_at` is the same promise the
    // status makes, and a record that has one without the other is kept rather than guessed at.
    if (!FINAL_RUN_STATUSES.has(record.status) || record.finished_at === null) {
      kept += 1;
      continue;
    }
    const finished = Date.parse(record.finished_at);
    if (!Number.isFinite(finished) || finished > cutoff) {
      kept += 1;
      continue;
    }
    try {
      await engine.deleteRun(id);
      deleted.push(id);
    } catch (error) {
      if (error instanceof BashreactorError && (error.code === "run_claimed" || error.code === "run_not_found")) {
        kept += 1;
        continue;
      }
      problem ??= error instanceof Error ? error.message : String(error);
      kept += 1;
    }
  }

  // The runs are dealt with; what is left under `runs/` belongs to no run and is in no listing, so
  // nothing else would ever reclaim it — a delete the filesystem refused partway, or a `createRun`
  // the pod died inside.
  const temp = await engine.pruneTempDirs(olderThanMs);
  for (const failure of temp.failed) problem ??= failure;

  return { cutoff: new Date(cutoff).toISOString(), deleted, kept, temp: temp.removed, problem };
}

/**
 * Say out loud what is going to happen to old runs, and start doing it (SPEC 4.11).
 *
 * Both entries call this — `apps/api/src/main.ts` and the entry the image actually runs, in
 * `apps/web/src/server.ts` — rather than each writing its own sentence, because the two would drift
 * and only one of them is what a deployment runs. "Off" is a legitimate answer (an operator trims from
 * outside, or from the CLI) and the only thing worse than off is off unnoticed.
 */
export function announceRetention(
  engine: RunsThatCanBeDeleted,
  retentionMs: number | null,
  log: (line: string) => void = (line: string) => console.log(line),
  intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS,
): () => Promise<void> {
  if (retentionMs === null) {
    log(
      "bashreactor: retention is off: finished runs are kept until something deletes them " +
        "(bashreactor runs rm <id>, or set BASHREACTOR_RETENTION)",
    );
    return async () => {};
  }
  log(
    `bashreactor: retention: a run that finished over ${durationText(retentionMs)} ago is deleted, at startup and then every ${durationText(intervalMs)}`,
  );
  return startRetention(engine, retentionMs, { log, intervalMs });
}

export interface RetentionOptions {
  intervalMs?: number;
  log?: (line: string) => void;
  /** Replaced in tests. */
  sweep?: (engine: RunsThatCanBeDeleted, olderThanMs: number) => Promise<RetentionReport>;
}

/**
 * Start the periodic trim, and hand back the function that stops it. Does nothing at all when
 * `retentionMs` is null, which is the default and means "the operator trims, not us" — the caller
 * says which of the two is happening at startup, so neither is a surprise (SPEC 4.11).
 *
 * The timer is unref'd: it must be the last thing keeping the process alive, and a test that builds an
 * API would otherwise hang on exit.
 *
 * Sweeps do not overlap. A pass is a walk of the whole home and a slow filesystem can keep it busy for
 * minutes; a timer that fires into that starts a second walk of the same directories, deleting under
 * the first one and reporting twice. So a tick that arrives while a pass is in flight is logged and
 * skipped, and the function returned here resolves once the last pass has finished — which is what a
 * shutdown wants, not a timer cleared mid-delete.
 */
export function startRetention(
  engine: RunsThatCanBeDeleted,
  retentionMs: number | null,
  options: RetentionOptions = {},
): () => Promise<void> {
  if (retentionMs === null) return async () => {};
  const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const log = options.log ?? ((line: string) => console.log(line));
  const sweep = options.sweep ?? ((e, older) => sweepRuns(e, older));

  // A window shorter than the interval is one the sweep cannot honour: a run goes somewhere between
  // the window and the window plus an interval. That is almost never what whoever wrote `15m` meant,
  // so it is said once here rather than inferred from log timestamps afterwards.
  if (retentionMs < intervalMs) {
    log(
      `bashreactor: retention: the window (${durationText(retentionMs)}) is shorter than the sweep interval (${durationText(intervalMs)}), so a run is kept up to that much longer than asked`,
    );
  }

  let inFlight: Promise<void> | null = null;
  let skipNoted = false;

  const run = async (): Promise<void> => {
    try {
      const report = await sweep(engine, retentionMs);
      if (report.deleted.length > 0 || report.temp.length > 0 || report.problem !== null) {
        const left = report.temp.length === 0 ? "" : `, ${report.temp.length} leftover directory/directories`;
        log(
          `bashreactor: retention removed ${report.deleted.length} run(s) finished over ${durationText(retentionMs)} ago` +
            ` (kept ${report.kept}${left})${report.problem === null ? "" : `: ${report.problem}`}`,
        );
      }
    } catch (error) {
      // A sweep that could not even list the runs is the interesting kind of failure: it means the
      // data directory is not readable, and the next run will fail for the same reason.
      log(`bashreactor: retention sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const pass = (): Promise<void> => {
    if (inFlight !== null) {
      // Once per stalled sweep, not once per tick: an hour-long pass on an hourly timer is one line,
      // and a pass that is stuck for a day is still one line rather than twenty-four.
      if (!skipNoted) {
        skipNoted = true;
        log("bashreactor: retention: the last sweep has not finished, this one is skipped");
      }
      return inFlight;
    }
    skipNoted = false;
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const timer = setInterval(() => void pass(), intervalMs);
  timer.unref?.();
  void pass();

  return async () => {
    clearInterval(timer);
    await inFlight;
  };
}
