// The parsed, in-memory shapes of blocks and pipelines. docs/SPEC.md owns the on-disk syntax; the
// parser turns that into these, so nothing here knows how a declaration is spelled.

export type ValueType = "string" | "integer" | "number" | "boolean" | "json" | "file";

export const VALUE_TYPES: readonly ValueType[] = [
  "string",
  "integer",
  "number",
  "boolean",
  "json",
  "file",
];

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

// A value of one of the six types. `file` values are paths: absolute when handed to a script,
// relative to the run directory when stored in run.json.
export type Value = string | number | boolean | JsonValue;

// Section 1.1 name rules.
export const BLOCK_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
export const IO_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const RESERVED_ENV_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "PYTHONUNBUFFERED",
  "NO_COLOR",
];

// Section 1.3 defaults.
export const DEFAULT_TIMEOUT_SECONDS = 24 * 60 * 60; // 24h
export const DEFAULT_KILL_GRACE_SECONDS = 30;
export const DEFAULT_MAX_PARALLEL = 4;

export interface BlockInput {
  name: string;
  type: ValueType;
  description: string; // default ""
  default?: Value; // present makes the input optional
}

export interface BlockOutput {
  name: string;
  type: ValueType;
  description: string; // default ""
}

export interface Block {
  name: string;
  description: string;
  inputs: BlockInput[]; // declaration order
  outputs: BlockOutput[]; // declaration order
}

// A pipeline input has exactly the same schema as a block input (section 3.3).
export type PipelineInput = BlockInput;

export interface Retry {
  max_attempts: number; // >= 1, default 1
  delay: number; // seconds, default 30
  backoff: number; // >= 1, default 2
  max_delay: number; // seconds, default max(1h, delay)
}

export const DEFAULT_RETRY: Retry = {
  max_attempts: 1,
  delay: 30,
  backoff: 2,
  max_delay: 60 * 60,
};

export type ExpressionRef =
  | { kind: "inputs"; name: string }
  | { kind: "step_output"; step: string; output: string };

export type TemplatePart = { kind: "text"; text: string } | { kind: "expr"; ref: ExpressionRef };

export type WithValue =
  | { kind: "literal"; value: Value }
  | { kind: "whole"; ref: ExpressionRef }
  | { kind: "template"; parts: TemplatePart[] };

export interface WithEntry {
  name: string;
  value: WithValue;
}

export interface PipelineOutput {
  name: string;
  ref: ExpressionRef; // always a step_output (validated)
}

export interface PipelineStep {
  id: string;
  name: string; // default = id
  uses: string;
  needs: string[]; // declared needs, in declaration order
  with: WithEntry[]; // declaration order
  pass_env: string[];
  timeout: number; // seconds, always present (default 24h)
  kill_grace: number; // seconds, default 30
  retry: Retry;
}

export interface Pipeline {
  name: string;
  description: string;
  max_parallel: number; // default 4
  inputs: PipelineInput[]; // declaration order
  steps: PipelineStep[]; // declaration order
  outputs: PipelineOutput[]; // declaration order
}

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";
export type StepStatus =
  | "pending"
  | "running"
  | "waiting_retry"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";
export type AttemptStatus = "running" | "succeeded" | "failed" | "interrupted" | "cancelled";

// Block references (section 3.4).
export const PATH_REF_RE = /^\.\.?\//;
export const LIBRARY_REF_RE = /^[a-z][a-z0-9-]{0,63}@[1-9][0-9]*$/;

export function isPathRef(uses: string): boolean {
  return PATH_REF_RE.test(uses);
}

export function isLibraryRef(uses: string): boolean {
  return LIBRARY_REF_RE.test(uses);
}
