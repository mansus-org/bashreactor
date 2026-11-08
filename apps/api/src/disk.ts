// How much room `$BASHREACTOR_HOME` has left, for `GET /v1/disk` (SPEC 4.11).
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
//
// Alongside them goes `runsBytes`, the bytes under `runs/`. A `local-path` volume is a directory on
// a node and enforces no size, so the filesystem numbers can belong to a disk much larger than the
// volume — the count of what bashreactor itself wrote is the one that can be compared with the size
// the deployment asked for.

import { statfsSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

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

/**
 * The bytes the run directories are holding, which is the number an operator can act on.
 *
 * `statfs` reports a filesystem, and on this cluster a `local-path` volume is a directory on a node
 * that has other things on it: `total_bytes` is then the node's disk and `used_bytes` is mostly
 * somebody else's workload. What compares against the size the volume was asked for is what
 * bashreactor itself has written under `runs/`, so it is counted rather than guessed at.
 *
 * The walk is async on purpose. This answers a probe that fires every few seconds, and a synchronous
 * walk of a home with thousands of runs would stall the loop the API is answering on.
 *
 * A directory that is missing or unreadable counts as nothing rather than failing the call: the
 * filesystem numbers above are still the news, and `runs/` not existing yet is a fresh install.
 * A symlink is counted as the link, never as what it points at — a block that escapes the volume
 * through one should not be charged to it.
 */
export async function runsBytes(runsDir: string): Promise<number> {
  let total = 0;
  const pending = [runsDir];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
        continue;
      }
      try {
        total += (await lstat(child)).size;
      } catch {
        // Gone between the listing and now, which a delete or a sweep in parallel makes normal.
      }
    }
  }
  return total;
}
