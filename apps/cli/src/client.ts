// The only way the CLI reaches a deployment: HTTP, with a bearer token, and nothing else. The API is
// the surface that enforces scopes and the only thing that knows where the runs live, so the CLI
// never opens the store or the engine in-process.

import type { Connection } from "./connection.ts";
import { apiFailure, unreachable } from "./errors.ts";
import type { ErrorBody } from "./errors.ts";

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  /** Sent as JSON. */
  body?: unknown;
  /** False for `/healthz`, which is unauthenticated and must work with no token at all. */
  auth?: boolean;
}

export class ApiClient {
  readonly url: string;
  readonly token: string | null;

  constructor(conn: Connection) {
    this.url = conn.url;
    this.token = conn.token;
  }

  /** A response that is already known to be a success. */
  async send(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const where = this.href(path, options.query);
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.auth !== false && this.token !== null) headers.authorization = `Bearer ${this.token}`;
    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["content-type"] = "application/json";
    }

    let response: Response;
    try {
      response = await fetch(where, { method, headers, body });
    } catch (error) {
      throw unreachable(where, readCause(error));
    }
    if (!response.ok) throw await failureOf(response);
    return response;
  }

  /** The API's own JSON, untouched: one object, or an array, exactly as it came back. */
  async json<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(method, path, options);
    const text = await response.text();
    if (text.trim() === "") return undefined as T;
    return JSON.parse(text) as T;
  }

  /** A route whose answer is bytes rather than a document. */
  async bytes(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    return await this.send(method, path, options);
  }

  href(path: string, query?: Record<string, string | number | undefined>): string {
    const url = `${this.url}${path}`;
    if (query === undefined) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const search = params.toString();
    return search === "" ? url : `${url}?${search}`;
  }
}

/**
 * The API's failure body, passed through as it arrived: the CLI does not re-word a message the spec
 * fixes, and does not invent a code the server already chose.
 */
async function failureOf(response: Response): Promise<Error> {
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if (typeof record.code === "string" && typeof record.message === "string") {
      const body: ErrorBody = { code: record.code, message: record.message };
      if (typeof record.path === "string") body.path = record.path;
      if (typeof record.file === "string") body.file = record.file;
      return apiFailure(body);
    }
  }
  const detail = text.trim() === "" ? `HTTP ${response.status} with no body` : text.trim().slice(0, 400);
  return apiFailure({ code: "internal_error", message: `the API at ${response.url} answered ${detail}` });
}

/** `fetch` wraps whatever went wrong, and the message worth showing is the cause's. */
function readCause(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message !== "") return cause.message;
  if (typeof cause === "string" && cause !== "") return cause;
  return error instanceof Error ? error.message : String(error);
}
