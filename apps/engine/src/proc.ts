// Linux process helpers. docs/SPEC.md section 4.7 ties a claim to field 22 of /proc/<pid>/stat,
// which changes across restarts of the same pid, so a stale claim can be told from a live one.

import { readFileSync } from "node:fs";
import type { EngineClaim } from "./run-store.ts";

export function readProcStartTime(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close === -1) return null;
    const fields = stat.slice(close + 2).split(" ");
    // fields[0] is /proc field 3 (state); starttime is field 22, so fields[19].
    const starttime = Number(fields[19]);
    return Number.isFinite(starttime) && starttime > 0 ? starttime : null;
  } catch {
    return null;
  }
}

export function isLiveClaim(claim: EngineClaim): boolean {
  return readProcStartTime(claim.pid) === claim.pid_start;
}
