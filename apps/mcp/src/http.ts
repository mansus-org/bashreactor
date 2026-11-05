// The HTTP surface: one POST to `/mcp`, answered entirely from the request in front of it. There is
// no session id, no `Mcp-Session-Id` header, no stream left open between calls, so any replica can
// answer any request and a pod that restarts loses nothing but the bytes in flight.
//
// The caller's token arrives on the request and is spent on the API right there. The server holds no
// token of its own beyond the one it was configured with, and it never learns one it was not given.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ApiClient } from "./api.ts";
import type { McpConfig } from "./config.ts";
import { errorBodyOf, errorObject, McpFailure, statusOf } from "./errors.ts";
import { buildMcpServer } from "./server.ts";

export interface McpServer {
  fetch(request: Request): Promise<Response>;
  config: McpConfig;
}

export interface McpOptions {
  log?: (line: string) => void;
  /** Replaced in tests. */
  fetch?: typeof globalThis.fetch;
}

export function createMcpServer(config: McpConfig, options: McpOptions = {}): McpServer {
  const log = options.log ?? ((line: string) => console.log(line));
  const fetchFn = options.fetch;

  async function dispatch(request: Request, url: URL, who: { name: string; tool: string }): Promise<Response> {
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({
        status: "ok",
        version: config.version,
        api: config.apiUrl,
        token: config.token === null ? "caller-only" : "configured",
      });
    }

    if (url.pathname !== config.path) {
      throw new McpFailure(
        errorObject("not_implemented", `${request.method} ${url.pathname} is not this server; the MCP endpoint is ${config.path}`),
        501,
      );
    }
    if (request.method !== "POST") {
      // Stateless: there is no session to open with a GET or to close with a DELETE.
      throw new McpFailure(
        errorObject(
          "not_implemented",
          `${config.path} takes POST; this endpoint is stateless, so there is no session to GET or DELETE`,
        ),
        405,
      );
    }

    const token = bearerOf(request) ?? config.token;
    if (token === null) {
      throw new McpFailure(
        errorObject(
          "unauthenticated",
          "no token: send the header Authorization: Bearer <token>, or set BASHREACTOR_TOKEN on the MCP server",
        ),
        401,
      );
    }

    const client = new ApiClient({ baseUrl: config.apiUrl, token, fetch: fetchFn });
    // One call per request, and the only way this server knows a scope: the API says who the token is,
    // so a revoked token stops being able to write on the very next request.
    const identity = await client.whoami();
    who.name = `${identity.name}:${identity.scope}`;

    const server = buildMcpServer(config, identity, client, (name, isError) => {
      // Which tool the request turned into, so one log line says what an agent did and whether it
      // came back with an error. The `!` is the difference between the two.
      who.tool = isError ? `${name}!` : name;
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      // Nothing outlives the request, which is the whole point.
      await closeQuietly(server.close());
      await closeQuietly(transport.close());
    }
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const started = Date.now();
    const who = { name: "-", tool: "" };
    let response: Response;
    try {
      response = await dispatch(request, url, who);
    } catch (error) {
      response = errorResponse(error);
    }
    const call = who.tool === "" ? "" : ` ${who.tool}`;
    log(`${request.method} ${url.pathname} ${response.status} ${Date.now() - started}ms ${who.name}${call}`);
    return response;
  }

  return { fetch: handle, config };
}

function bearerOf(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token === "" ? null : token;
}

function errorResponse(error: unknown): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const status = statusOf(error, 500);
  if (status === 401) headers["www-authenticate"] = 'Bearer realm="bashreactor"';
  return new Response(JSON.stringify(errorBodyOf(error)), { status, headers });
}

async function closeQuietly(closing: Promise<void>): Promise<void> {
  await closing.catch(() => {});
}
