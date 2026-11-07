// How much room `$BASHREACTOR_HOME` has left, for `GET /v1/disk` (SPEC 6).
//
// Before this, the only way to find out the volume was full was that a run failed: the write that
// noticed was a block's log append, hours deep into a pipeline, and the error was an `EIO` or an
// `ENOSPC` in a step's `failure` field. A deployment that fills up should say so before the runs
// start dying, in a way a probe or a cron can read.
//
// The numbers are the filesystem's own, taken at the data directory — which is the mount that
// matters, not the container root. Nothing here decides policy: it reports, and the operator's probe
// decides what low means. The one threshold kept here is `LOW_FREE_BYTES`, and it is a warning flag
// rather than a failing status on purpose: `/healthz` is readiness, and a full volume is not
// something a restart fixes (see `disk` in app.ts).

import { statfsSync } from "node:fs";

/**
 * Below this, the next run is close to not being able to write its own `run.json`. It is not a
 * number derived from anything in the spec; it is the size of the reserve we would want before a
 * write fails mid-step, in bytes — a few hundred megabytes of log, or one large artifact.
 */
export const LOW_FREE_BYTES = 64 * 1024 * 1024;

export interface DiskSpace {
  /** Bytes the filesystem holds, as the mount reports it. */
  total_bytes: number;
  /** `total_bytes` minus what is available to the server, so the reserved blocks count as used. */
  used_bytes: number;
  /** Bytes the server can actually write, which is what a full volume is measured by. */
  free_bytes: number;
  /** `free_bytes` under `LOW_FREE_BYTES`. */
  low: boolean;
}

/**
 * The space under `path`, or null when the filesystem will not say. A route that answers "cannot
 * read it" with 503 is worth more than one that answers zero: the data directory can be a mount that
 * is not up yet, and a zero would read as "full" to anything watching.
 */
export function diskSpace(path: string): DiskSpace | null {
  try {
    const stats = statfsSync(path);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    return { total_bytes: total, used_bytes: total - free, free_bytes: free, low: free < LOW_FREE_BYTES };
  } catch {
    return null;
  }
}
