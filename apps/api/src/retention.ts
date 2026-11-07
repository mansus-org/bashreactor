// Trimming the volume (SPEC 6).
//
// `$BASHREACTOR_HOME` is a fixed PVC — 1 Gi in `.k3s/values.yaml` — and a run writes as much log as
// its blocks produce: one test block wrote 3 MB in under a second. With nothing ever removed, the
// volume fills, and then every write fails at once: the store cannot record a run, the engine
// cannot append a log, and the only symptom is runs failing. So either the server trims, or an
// operator does it from outside. Both are supported; the one answer that is not allowed is silence,
// which is what the deployment shipped with.
//
// The rule kept here is deliberately narrow: **a run that has reached a final status, older than the
// retention, goes**. Not a run that is running (its step is a process group writing into that very
// directory), not a run `waiting` on an approval (that is a person who has not got back to it, and a
// sweep must not decide they never will), not a run whose `finished_at` is missing (nothing to age it
// by), not a run the retention has not reached. Anything the sweep cannot account for is kept and
// counted, because the failure mode of keeping one run too long is a fuller disk, and the failure
// mode of deleting one too early is someone's data.

import { BashreactorError } from "@bashreactor/core";
import { FINAL_RUN_STATUSES, type RunRecord } from "@bashreactor/engine";

/** How often to sweep when the operator did not say. Trimming is not urgent; an hour is not. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** What the sweep is allowed to ask of the engine, so it can be tested without a running one. */
export interface RunsThatCanBeDeleted {
  listRuns(): Promise<string[]>;
  getRun(runId: string): Promise<RunRecord | null>;
  deleteRun(runId: string): Promise<void>;
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
  /** The first error that was not "this run is not deletable right now". The sweep finishes anyway. */
  problem: string | null;
}

/**
 * One pass over every run: delete the finished ones whose `finished_at` is older than `olderThanMs`
 * before `now`.
 *
 * A run that refuses is not a failure of the sweep. `run_claimed` means something is writing into it
 * and `run_not_found` means someone deleted it mid-pass; both are counted as kept and the pass moves
 * on. Any other error is kept as `problem` — the pass still finishes, because one directory that
 * will not go should not strand the rest, and a repeat of the same error is not worth a stack trace
 * per run.
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
    const record = await engine.getRun(id);
    // Gone between the listing and now: there is nothing here to remove and nothing to report.
    if (record === null) continue;
    // Anything short of a final status is somebody else's business: `running` is being written
    // into, `waiting` is waiting on a person. A `finished_at` is the same promise the status makes,
    // and a record that has one without the other is kept rather than guessed at.
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

  return { cutoff: new Date(cutoff).toISOString(), deleted, kept, problem };
}

/**
 * Say out loud what is going to happen to old runs, and start doing it (SPEC 6).
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
): () => void {
  if (retentionMs === null) {
    log(
      "bashreactor: retention is off: finished runs are kept until something deletes them " +
        "(bashreactor runs rm <id>, or set BASHREACTOR_RETENTION)",
    );
    return () => {};
  }
  log(`bashreactor: retention: a run that finished over ${durationText(retentionMs)} ago is deleted`);
  return startRetention(engine, retentionMs, { log });
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
 * says which of the two is happening at startup, so neither is a surprise (SPEC 6).
 *
 * The timer is unref'd: it must be the last thing keeping the process alive, and a test that builds
 * an API would otherwise hang on exit.
 */
export function startRetention(
  engine: RunsThatCanBeDeleted,
  retentionMs: number | null,
  options: RetentionOptions = {},
): () => void {
  if (retentionMs === null) return () => {};
  const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const log = options.log ?? ((line: string) => console.log(line));
  const sweep = options.sweep ?? ((e, older) => sweepRuns(e, older));

  const pass = async (): Promise<void> => {
    try {
      const report = await sweep(engine, retentionMs);
      if (report.deleted.length > 0 || report.problem !== null) {
        log(
          `bashreactor: retention removed ${report.deleted.length} run(s) finished over ${durationText(retentionMs)} ago` +
            ` (kept ${report.kept})${report.problem === null ? "" : `: ${report.problem}`}`,
        );
      }
    } catch (error) {
      // A sweep that could not even list the runs is the interesting kind of failure: it means the
      // data directory is not readable, and the next run will fail for the same reason.
      log(`bashreactor: retention sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const timer = setInterval(() => void pass(), intervalMs);
  timer.unref?.();
  void pass();

  return () => clearInterval(timer);
}
