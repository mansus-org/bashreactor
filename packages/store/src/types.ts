// The store's nouns, mirroring docs/SPEC.md. The on-disk layout of these values is owned by the
// store (README.md), not by the block/pipeline parsers in @bashreactor/core.
//
// ValueType, RunStatus, StepStatus and AttemptStatus are core's, re-exported: one definition of
// "what a value type is" for the whole repo, so a store row and a parsed pipeline can never drift.
// Failure stays here. It is not a duplicate: core has no failure type, and the engine's own
// FailureInfo narrows `code` to the spec's ErrorCode, while a stored failure keeps whatever code
// the writer recorded (a store row outlives the version of core that produced it).

import type { AttemptStatus, RunStatus, StepStatus, ValueType } from "@bashreactor/core";

export type { AttemptStatus, RunStatus, StepStatus, ValueType };

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

/**
 * One block name in the library, without opening any of its files. `versions` is the count of
 * versions stored, and `addBlockVersion` numbers them from 1 up with nothing removed, so it equals
 * `latest` for anything this store wrote.
 */
export interface BlockName {
  name: string;
  latest: number;
  versions: number;
}

/** The same three facts about one pipeline name. */
export interface PipelineName {
  name: string;
  latest: number;
  versions: number;
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
