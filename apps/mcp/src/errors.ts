// The one shape every failure takes here: SPEC section 5's error object, `{code, message, path?,
// file?}`, exactly as the REST API answers it, so the CLI, the API and this server print the same
// thing. A tool never rewrites an error into a sentence — it hands back the object and the client
// reads `code`.
//
// Every code here is in SPEC section 5. `unauthenticated`, `forbidden` and `internal_error` mean
// what the API means by them, and `api_unreachable` is the one failure the API cannot answer for:
// it is not answering at all.

import { BashreactorError } from "@bashreactor/core";

export interface ErrorObject {
  code: string;
  message: string;
  path?: string;
  file?: string;
}

export function errorObject(
  code: string,
  message: string,
  options: { path?: string; file?: string } = {},
): ErrorObject {
  const body: ErrorObject = { code, message };
  if (options.path !== undefined) body.path = options.path;
  if (options.file !== undefined) body.file = options.file;
  return body;
}

/**
 * A failure with the error object it should be shown as, plus the HTTP status to answer a request
 * with when there is one. `status` is null for a failure that only ever surfaces as a tool error.
 */
export class McpFailure extends Error {
  readonly body: ErrorObject;
  readonly status: number | null;

  constructor(body: ErrorObject, status: number | null = null, cause?: unknown) {
    super(body.message, { cause });
    this.name = "McpFailure";
    this.body = body;
    this.status = status;
  }
}

/** Whatever was thrown, reduced to the object the caller is owed. Nothing is invented here. */
export function errorBodyOf(error: unknown): ErrorObject {
  if (error instanceof McpFailure) return error.body;
  if (error instanceof BashreactorError) return error.toBody();
  const message = error instanceof Error ? error.message : String(error);
  return errorObject("internal_error", `the MCP server failed: ${message}`);
}

/** The status to answer an HTTP request with, when the failure came from one. */
export function statusOf(error: unknown, fallback = 500): number {
  if (error instanceof McpFailure) return error.status ?? fallback;
  if (error instanceof BashreactorError) return error.code === "runtime_missing" ? 503 : 500;
  return fallback;
}

/**
 * A tool result's text: the error object as one compact line, byte for byte what the API puts in a
 * response body. Pretty-printing it would make two surfaces print two renderings of one error.
 */
export function errorText(body: ErrorObject): string {
  return JSON.stringify(body);
}
