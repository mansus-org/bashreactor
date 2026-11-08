// The one place that turns a thrown thing into an HTTP response, so no route can drift. The body is
// SPEC section 5's error object — `{ code, message, path?, file? }` — and the status follows from
// the code alone.
//
// Every code here is in SPEC section 5, so a client switching on `code` gets one vocabulary out of
// all three surfaces. The definition, starting and step-failure codes come from `packages/core`,
// the store raises its own and they pass through with the code untouched, and the rest —
// `unauthenticated`, `forbidden`, `not_found`, `method_not_allowed`, `bad_request`,
// `internal_error` — are this API's answers to the failures the other two packages cannot see.

import { BashreactorError } from "@bashreactor/core";
import { StoreError } from "@bashreactor/store";

const STATUS_BY_CODE: Record<string, number> = {
  // The request itself could not be read: a path that is not a sequence of decodable segments.
  bad_request: 400,
  // Definition and request validation: the request is understood and wrong.
  pipeline_yaml_invalid: 422,
  pipeline_schema_invalid: 422,
  block_header_malformed: 422,
  block_schema_invalid: 422,
  unknown_step: 422,
  unknown_input: 422,
  unknown_output: 422,
  missing_input: 422,
  expression_invalid: 422,
  type_mismatch: 422,
  dependency_cycle: 422,
  file_input_not_found: 422,
  env_missing: 422,
  invalid_argument: 422,
  // The thing named does not exist.
  run_not_found: 404,
  block_not_found: 404,
  pipeline_not_found: 404,
  token_not_found: 404,
  step_not_found: 404,
  attempt_not_found: 404,
  artifact_not_found: 404,
  // A path inside a run directory that is not there, is a link, or is not inside it at all.
  file_not_found: 404,
  // No route is mounted at the path the request named.
  not_found: 404,
  // The thing exists but is in the wrong state for this call.
  run_claimed: 409,
  run_not_active: 409,
  run_not_retryable: 409,
  already_exists: 409,
  version_conflict: 409,
  // Auth.
  unauthenticated: 401,
  forbidden: 403,
  // The server, not the caller.
  method_not_allowed: 405,
  not_implemented: 501,
  runtime_missing: 503,
  // The filesystem refused the removal even once the tree was writable (SPEC 4.11). The run is
  // untouched, so the caller could ask again, but there is nothing in the request to fix.
  run_delete_failed: 500,
  internal_error: 500,
  store_migration_failed: 500,
  store_closed: 500,
  // A step's failure code, which never comes back as an HTTP failure of its own: it is a field of
  // a run. Mapped so the table is total and a mistake shows up as a 500 rather than a wrong 4xx.
  input_too_large: 500,
  spawn_failed: 500,
  exit_nonzero: 500,
  retry_requested: 500,
  block_fatal: 500,
  killed_by_signal: 500,
  timeout: 500,
  cancelled: 500,
  output_missing: 500,
  output_invalid: 500,
  output_too_large: 500,
  interrupted: 500,
};

/**
 * Every code whose status is decided in the table above. SPEC 5 has to list all of them, and nothing
 * here may map a code the spec has not agreed to; `test/errors.test.ts` checks both ways.
 */
export const CODES_WITH_STATUS: readonly string[] = Object.keys(STATUS_BY_CODE);

/**
 * The status for an error code, independent of which route or which package raised it (SPEC 5).
 *
 * A code nothing mapped is a 500, because that is what it is: something broke that no other code
 * describes. Guessing a 4xx would tell a caller their request was wrong when it was not.
 */
export function statusForCode(code: string): number {
  return STATUS_BY_CODE[code] ?? 500;
}

/** An error whose HTTP status is already known, or is derived from its code. */
export class ApiError extends Error {
  readonly code: string;
  readonly path?: string;
  readonly file?: string;
  readonly status: number | null;

  constructor(
    code: string,
    message: string,
    options: { path?: string; file?: string; status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ApiError";
    this.code = code;
    this.path = options.path;
    this.file = options.file;
    this.status = options.status ?? null;
  }
}

export interface ErrorBody {
  code: string;
  message: string;
  path?: string;
  file?: string;
}

/** The single mapping from a thrown value to `{ status, body }`. */
export function errorToResponse(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof ApiError) {
    return { status: error.status ?? statusForCode(error.code), body: body(error.code, error.message, error.path, error.file) };
  }
  if (error instanceof BashreactorError) {
    return { status: statusForCode(error.code), body: body(error.code, error.message, error.path, error.file) };
  }
  if (error instanceof StoreError) {
    return { status: statusForCode(error.code), body: body(error.code, error.message, error.path, error.file) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 500,
    body: { code: "internal_error", message: `internal error: ${message}` },
  };
}

function body(code: string, message: string, path?: string, file?: string): ErrorBody {
  const out: ErrorBody = { code, message };
  if (path !== undefined) out.path = path;
  if (file !== undefined) out.file = file;
  return out;
}

/**
 * The first validation issue of a multi-issue report, as the error object SPEC 4.3 hands back. The
 * status is 422 whatever the issue's own code would say: the request was understood and the document
 * in it is not valid, which is what 422 means. A lookup of a thing that is not there is still 404.
 */
export function firstIssueAsError(
  issues: readonly { code: string; message: string; path?: string }[],
  file?: string,
): ApiError {
  const first = issues[0]!;
  return new ApiError(first.code, first.message, { path: first.path, file, status: 422 });
}
