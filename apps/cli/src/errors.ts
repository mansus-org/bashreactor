// The one place that decides what a failure looks like and what the process exits with, so no
// command can drift. A failure is docs/SPEC.md section 5's error object; the exit code says who to
// blame: 1 when the API refused, 2 when the command line was wrong before anyone was asked.

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** SPEC section 5's body. `code` is a string because the CLI adds codes the spec has none for. */
export interface ErrorBody {
  code: string;
  message: string;
  path?: string;
  file?: string;
}

/**
 * Codes this CLI answers with that SPEC section 5 does not list:
 *
 * - `invalid_argument` — the command line itself was wrong. The store already uses this code for
 *   an argument that cannot be right, and the API maps it to 422, so it is the house vocabulary.
 *
 * Everything else — `unauthenticated`, `forbidden`, `pipeline_not_found`, `internal_error` — comes
 * from the API's own list (apps/api/README.md) and is passed through untouched.
 */
export const USAGE_CODE = "invalid_argument";

export class CliError extends Error {
  readonly code: string;
  readonly path?: string;
  readonly file?: string;
  readonly exit: number;

  constructor(
    code: string,
    message: string,
    options: { path?: string; file?: string; exit?: number } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.path = options.path;
    this.file = options.file;
    this.exit = options.exit ?? EXIT_FAILURE;
  }

  toBody(): ErrorBody {
    const body: ErrorBody = { code: this.code, message: this.message };
    if (this.path !== undefined) body.path = this.path;
    if (this.file !== undefined) body.file = this.file;
    return body;
  }
}

/** The command line was wrong: a missing argument, an unknown flag, a value that cannot parse. */
export function usage(
  message: string,
  options: { code?: string; path?: string; file?: string } = {},
): CliError {
  return new CliError(options.code ?? USAGE_CODE, message, {
    path: options.path,
    file: options.file,
    exit: EXIT_USAGE,
  });
}

/** The API answered a failure. Its body is shown exactly as it came back, because it is the spec's. */
export function apiFailure(body: ErrorBody): CliError {
  return new CliError(body.code, body.message, { path: body.path, file: body.file, exit: EXIT_FAILURE });
}

/** No API to talk to: the server is not there, rather than refusing the request. */
export function unreachable(where: string, reason: string): CliError {
  return new CliError("runtime_missing", `cannot reach the API at ${where}: ${reason}`, {
    exit: EXIT_FAILURE,
  });
}

/** Something threw that no command expected. It is still one error object, never a stack trace. */
export function unexpected(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CliError("internal_error", message, { exit: EXIT_FAILURE });
}
