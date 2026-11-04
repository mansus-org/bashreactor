// Every error the CLI, API and MCP server can surface. docs/SPEC.md section 5 owns the codes and
// the body shape, so the three surfaces print the same object.

export const ERROR_CODES = [
  // Definition
  "pipeline_yaml_invalid",
  "pipeline_schema_invalid",
  "block_not_found",
  "block_header_malformed",
  "block_schema_invalid",
  "unknown_step",
  "unknown_input",
  "unknown_output",
  "missing_input",
  "expression_invalid",
  "type_mismatch",
  "dependency_cycle",
  // Starting a run
  "file_input_not_found",
  "env_missing",
  // Step failure
  "input_too_large",
  "spawn_failed",
  "exit_nonzero",
  "retry_requested",
  "block_fatal",
  "killed_by_signal",
  "timeout",
  "cancelled",
  "output_missing",
  "output_invalid",
  "output_too_large",
  "interrupted",
  // Operations
  "run_not_found",
  "run_not_active",
  "run_not_retryable",
  "run_claimed",
  "runtime_missing",
  "not_implemented",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  path?: string;
  file?: string;
}

export class BashreactorError extends Error {
  readonly code: ErrorCode;
  readonly path?: string;
  readonly file?: string;

  constructor(code: ErrorCode, message: string, options: { path?: string; file?: string } = {}) {
    super(message);
    this.name = "BashreactorError";
    this.code = code;
    this.path = options.path;
    this.file = options.file;
  }

  toBody(): ErrorBody {
    const body: ErrorBody = { code: this.code, message: this.message };
    if (this.path !== undefined) body.path = this.path;
    if (this.file !== undefined) body.file = this.file;
    return body;
  }
}

export class NotImplementedError extends BashreactorError {
  constructor(what: string) {
    super("not_implemented", `${what} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}
