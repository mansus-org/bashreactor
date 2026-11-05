// Errors the store throws. The codes are store-specific; the engine/CLI/API reconciliation (a later
// task) maps them onto the codes in docs/SPEC.md section 5. For now callers branch on `code`, which is
// why it is a closed union rather than a free string.

export type StoreErrorCode =
  | "invalid_argument"
  | "already_exists"
  | "run_not_found"
  | "step_not_found"
  | "attempt_not_found"
  | "block_not_found"
  | "pipeline_not_found"
  | "artifact_not_found"
  | "version_conflict"
  | "store_locked"
  | "store_migration_failed"
  | "store_closed";

export interface StoreErrorBody {
  code: StoreErrorCode;
  message: string;
  path?: string;
  file?: string;
}

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly path: string | undefined;
  readonly file: string | undefined;

  constructor(code: StoreErrorCode, message: string, details: { path?: string; file?: string; cause?: unknown } = {}) {
    super(message, { cause: details.cause });
    this.name = "StoreError";
    this.code = code;
    this.path = details.path;
    this.file = details.file;
  }

  toJSON(): StoreErrorBody {
    const body: StoreErrorBody = { code: this.code, message: this.message };
    if (this.path !== undefined) body.path = this.path;
    if (this.file !== undefined) body.file = this.file;
    return body;
  }
}
