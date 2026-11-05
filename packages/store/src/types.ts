// The store's nouns, mirroring docs/SPEC.md. The on-disk layout of these values is owned by the
// store (README.md), not by the block/pipeline parsers in @bashreactor/core.

export type ValueType = "string" | "integer" | "number" | "boolean" | "json" | "file";

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "waiting_retry" | "succeeded" | "failed" | "skipped" | "cancelled";
export type AttemptStatus = "running" | "succeeded" | "failed" | "interrupted" | "cancelled";

export interface Failure {
  code: string;
  message: string;
}

export interface BlockVersion {
  name: string;
  version: number;
  sha256: string;
  size: number;
  createdAt: string;
}

export interface PipelineRecord {
  name: string;
  version: number;
  sha256: string;
  yaml: string;
  parsed: unknown;
  createdAt: string;
}

export interface BlockRef {
  uses: string;
  name: string;
  version: number | null;
  sha256: string;
}

export interface Attempt {
  n: number;
  status: AttemptStatus;
  pid: number | null;
  pidStart: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  failure: Failure | null;
  logSize: number;
}

export interface Step {
  id: string;
  name: string;
  status: StepStatus;
  needs: string[];
  with: unknown | null;
  outputs: unknown | null;
  failure: Failure | null;
  attemptsUsed: number;
  nextAttemptAt: string | null;
  block: BlockRef;
  attempts: Attempt[];
}

export interface Run {
  id: string;
  pipeline: { name: string; version: number };
  status: RunStatus;
  createdAt: string;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  inputs: unknown;
  outputs: unknown | null;
  steps: Step[];
}

export interface RunSummary {
  id: string;
  pipeline: string;
  pipelineVersion: number;
  status: RunStatus;
  createdAt: string;
  finishedAt: string | null;
}

export interface Artifact {
  runId: string;
  stepId: string;
  attempt: number;
  name: string;
  type: ValueType;
  size: number;
  path: string;
  sha256: string | null;
  published: boolean;
}

// --- Write-side inputs -------------------------------------------------------

export interface NewAttempt {
  n: number;
  status: AttemptStatus;
  pid?: number | null;
  pidStart?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  failure?: Failure | null;
}

export interface NewStep {
  id: string;
  name: string;
  status: StepStatus;
  block: BlockRef;
  needs?: string[];
  with?: unknown | null;
  outputs?: unknown | null;
  failure?: Failure | null;
  attemptsUsed?: number;
  nextAttemptAt?: string | null;
  attempts?: NewAttempt[];
}

export interface NewRun {
  id: string;
  pipeline: { name: string; version: number };
  status: RunStatus;
  createdAt: string;
  finishedAt?: string | null;
  cancelRequestedAt?: string | null;
  inputs?: unknown;
  outputs?: unknown | null;
  steps: NewStep[];
}

export interface StepUpdate {
  status?: StepStatus;
  with?: unknown | null;
  outputs?: unknown | null;
  failure?: Failure | null;
  attemptsUsed?: number;
  nextAttemptAt?: string | null;
}

export interface RunUpdate {
  status?: RunStatus;
  finishedAt?: string | null;
  cancelRequestedAt?: string | null;
  outputs?: unknown | null;
  steps?: Record<string, StepUpdate>;
}

export interface AttemptUpdate {
  status?: AttemptStatus;
  pid?: number | null;
  pidStart?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  failure?: Failure | null;
}

export interface LogChunk {
  bytes: Uint8Array;
  size: number;
}
