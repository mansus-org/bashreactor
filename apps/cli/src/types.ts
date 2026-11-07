// The shapes the CLI reads off the API, which are docs/SPEC.md section 4.9 (run.json) and the small
// records apps/api answers with for the library. They are declared here rather than imported from
// the engine or the store, because the CLI's only contract is the JSON on the wire.

export interface RunRecord {
  id: string;
  pipeline: string;
  status: RunStatus;
  created_at: string;
  finished_at: string | null;
  cancel_requested_at: string | null;
  inputs: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
  steps: Record<string, StepRecord>;
}

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface StepRecord {
  name: string;
  status: StepStatus;
  needs: string[];
  failure: Failure | null;
  attempts_used: number;
  next_attempt_at: string | null;
  attempts: AttemptRecord[];
}

export type StepStatus =
  | "pending"
  | "running"
  | "waiting_retry"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export const FINAL_STEP_STATUSES: readonly StepStatus[] = ["succeeded", "failed", "skipped", "cancelled"];

export interface AttemptRecord {
  n: number;
  status: string;
  failure: Failure | null;
}

export interface Failure {
  code: string;
  message: string;
}

export interface LogChunk {
  run: string;
  step: string;
  attempt: number;
  offset: number;
  next_offset: number;
  truncated: boolean;
  text: string;
}

/**
 * `GET /v1/runs/:id/files` (BASHR-47). A file entry carries a `size`; a symlink or other special
 * file carries a `kind` and no size, and is not downloadable — a block that plants a link must be
 * visible in the listing, not hidden by it.
 */
export interface RunFileManifest {
  run: string;
  status: RunStatus;
  partial: boolean;
  outputs: RunOutputFile[];
  steps: Record<string, RunStepFiles>;
}

export interface RunFileEntry {
  path: string;
  size: number | null;
  kind?: "link" | "other";
}

export interface RunOutputFile extends RunFileEntry {
  name: string;
  type: "file";
  step: string;
  attempt: number;
}

export interface RunStepFiles {
  attempts: {
    n: number;
    status: string;
    partial: boolean;
    log?: RunFileEntry;
    outputs?: (RunFileEntry & { name: string })[];
    work?: RunFileEntry[];
  }[];
}

export interface RunSummary {
  id: string;
  pipeline: string;
  status: RunStatus;
  created_at: string;
  finished_at: string | null;
  cancel_requested_at: string | null;
}

export interface BlockVersion {
  name: string;
  version: number;
  sha256: string;
  size: number;
  created_at: string;
}

export interface BlockList {
  name: string;
  latest: number;
  versions: BlockVersion[];
}

export interface PipelineVersion {
  name: string;
  version: number;
  sha256: string;
  created_at: string;
  yaml?: string;
  parsed?: { inputs?: { name: string; type: string }[] };
}

export interface PipelineList {
  name: string;
  latest: number;
  versions: PipelineVersion[];
}

export interface ValidationReport {
  valid: boolean;
  issues: { code: string; message: string; path?: string }[];
}

export interface Identity {
  name: string;
  scope: string;
  admin: boolean;
}

export interface TokenInfo {
  id: string;
  name: string;
  scope: string;
  created_at: string;
  last_used: string | null;
}

export interface Health {
  status: string;
  version: string;
  problem?: string;
}

/** `GET /v1/disk`: the filesystem `$BASHREACTOR_HOME` sits on, in bytes. */
export interface Disk {
  path: string;
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  low: boolean;
}
