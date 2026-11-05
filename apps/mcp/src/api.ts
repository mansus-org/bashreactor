// The only way this server reaches Bashreactor: the REST API, over HTTP, with a bearer token, like
// the CLI and the web app do. Nothing here opens the store or the engine — two writers on one data
// directory is a bug, and the API is the surface that enforces scopes.
//
// A non-2xx answer is turned into the API's own error object and rethrown untouched, so a 422 from
// a bad pipeline arrives at the agent as a 422's `type_mismatch` and not as a shrug.

import { errorObject, McpFailure } from "./errors.ts";

/** What `GET /v1/whoami` says about the caller. */
export interface Identity {
  name: string;
  scope: "read" | "write" | "admin";
  admin: boolean;
}

export interface ApiResult {
  status: number;
  text: string;
  headers: Headers;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface ClientOptions {
  /** The API's base URL, no trailing slash. */
  baseUrl: string;
  /** The caller's token, or the one this server was configured with. */
  token: string;
  fetch?: typeof globalThis.fetch;
}

/** How much of an unexpected body to quote back; a proxy's HTML page is not worth a kilobyte. */
const MAX_QUOTED_BYTES = 400;

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  /**
   * Who the token is. Every MCP request calls this once: it is what turns "is this caller allowed to
   * write" into a question the API answers instead of one this server guesses at.
   */
  async whoami(): Promise<Identity> {
    const body = (await this.json("/v1/whoami")) as Record<string, unknown>;
    return {
      name: String(body.name ?? ""),
      scope: body.scope === "write" || body.scope === "admin" ? body.scope : "read",
      admin: body.admin === true,
    };
  }

  async json(path: string, options: RequestOptions = {}): Promise<unknown> {
    const result = await this.request("GET", path, options);
    return parseJson(result, this.baseUrl);
  }

  async post(path: string, body: unknown): Promise<{ status: number; value: unknown }> {
    const result = await this.request("POST", path, { body });
    return { status: result.status, value: parseJson(result, this.baseUrl) };
  }

  async delete(path: string): Promise<unknown> {
    return parseJson(await this.request("DELETE", path), this.baseUrl);
  }

  /** A route that answers with bytes rather than JSON, such as a block's content. */
  async text(path: string, options: RequestOptions = {}): Promise<ApiResult> {
    return await this.request("GET", path, options);
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<ApiResult> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: "application/json" };
    let payload: string | undefined;
    if (options.body !== undefined) {
      payload = JSON.stringify(options.body);
      headers["content-type"] = "application/json";
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, { method, headers, body: payload });
    } catch (error) {
      // The one failure the API cannot speak for: it is not answering at all.
      const why = error instanceof Error ? error.message : String(error);
      throw new McpFailure(
        errorObject("api_unreachable", `could not reach the Bashreactor API at ${this.baseUrl}: ${why}`),
        502,
        error,
      );
    }

    const text = await response.text();
    if (!response.ok) throw failureFrom(response.status, text, this.baseUrl);
    return { status: response.status, text, headers: response.headers };
  }
}

/** The API's error object if the body is one, and an honest description of the body if it is not. */
function failureFrom(status: number, text: string, baseUrl: string): McpFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined && typeof parsed === "object" && !Array.isArray(parsed)) {
    const raw = parsed as Record<string, unknown>;
    if (typeof raw.code === "string") {
      return new McpFailure(
        errorObject(raw.code, typeof raw.message === "string" ? raw.message : "the API gave no message", {
          path: typeof raw.path === "string" ? raw.path : undefined,
          file: typeof raw.file === "string" ? raw.file : undefined,
        }),
        status,
      );
    }
  }
  const quoted = text.trim().slice(0, MAX_QUOTED_BYTES);
  return new McpFailure(
    errorObject("internal_error", `the API at ${baseUrl} answered ${status}${quoted === "" ? "" : `: ${quoted}`}`),
    status,
  );
}

function parseJson(result: ApiResult, baseUrl: string): unknown {
  if (result.text.trim() === "") return null;
  try {
    return JSON.parse(result.text);
  } catch (error) {
    throw new McpFailure(
      errorObject(
        "internal_error",
        `the API at ${baseUrl} answered ${result.status} with something that is not JSON`,
      ),
      result.status,
      error,
    );
  }
}
