// The persisted run state, shaped like run.json in docs/SPEC.md section 4.9. Times are ISO strings,
// `file` values are paths relative to the run directory.

import type { ErrorCode, StepStatus, Value } from "@bashreactor/core";
import type { AttemptStatus, RunStatus } from "@bashreactor/core";

export interface FailureInfo {
  code: ErrorCode;
  message: string;
}

export interface AttemptRecord {
  n: number;
  status: AttemptStatus;
  pid: number | null;
  pid_start: number | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  signal: string | null;
  failure: FailureInfo | null;
}

export interface StepRecord {
  id: string;
  name: string;
  status: StepStatus;
  block: { uses: string; name: string; sha256: string };
  needs: string[]; // effective dependencies, declaration order
  with: Record<string, Value> | null; // bound values, null before binding
  outputs: Record<string, Value> | null;
  failure: FailureInfo | null;
  attempts_used: number;
  next_attempt_at: string | null;
  attempts: AttemptRecord[];
}

export interface RunRecord {
  schema: 1;
  id: string;
  pipeline: string;
  status: RunStatus;
  created_at: string;
  finished_at: string | null;
  cancel_requested_at: string | null;
  inputs: Record<string, Value>;
  outputs: Record<string, Value> | null;
  steps: Record<string, StepRecord>; // insertion order = declaration order
}

/**
 * The shape `newRunId` produces. A run id is also a directory name, so anything that takes one from a
 * caller and turns it into a path has to check it first — above all the thing that deletes.
 */
export const RUN_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;

export function newRunId(now: Date = new Date()): string {
  const stamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    "T",
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0"),
    "Z",
  ].join("");
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${stamp}-${hex}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export const FINAL_STEP_STATUSES: ReadonlySet<StepStatus> = new Set([
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);

export const FINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled"]);
