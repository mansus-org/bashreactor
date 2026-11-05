// Everything this server takes from the environment, resolved once at startup the way
// `apps/api/src/config.ts` does it: the API it is a front for, the token it may fall back to, and
// what to listen on. A value the environment did not give and that has no sane default is fatal
// here, with the variable named in the message — there is nothing to degrade into when there is no
// API to talk to.

import { BashreactorError } from "@bashreactor/core";

const DEFAULT_PORT = 8090;
const DEFAULT_PATH = "/mcp";

export interface McpConfig {
  /** The REST API to call, without a trailing slash. Never the store, never the engine. */
  apiUrl: string;
  /** The token to use for a caller that brought none. Null means every caller brings its own. */
  token: string | null;
  port: number;
  /** Where the endpoint lives, so a proxy can move it without a rebuild. */
  path: string;
  version: string;
}

/**
 * `BASHREACTOR_URL`, normalised to a base with no trailing slash. It may carry a path prefix, for
 * an API mounted behind a proxy.
 */
export function resolveApiUrl(env: Record<string, string | undefined>): string {
  const raw = env.BASHREACTOR_URL?.trim();
  if (raw === undefined || raw === "") {
    throw new BashreactorError(
      "runtime_missing",
      "BASHREACTOR_URL must name the Bashreactor API to front, for example http://127.0.0.1:8080",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BashreactorError("runtime_missing", `BASHREACTOR_URL is not a URL: "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BashreactorError("runtime_missing", `BASHREACTOR_URL must be http or https, got "${url.protocol}"`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new BashreactorError("runtime_missing", `BASHREACTOR_URL must not carry a query or a fragment: "${raw}"`);
  }
  return url.toString().replace(/\/$/, "");
}

/** `BASHREACTOR_TOKEN`, or null when the caller is expected to bring its own on every request. */
export function resolveToken(env: Record<string, string | undefined>): string | null {
  const token = env.BASHREACTOR_TOKEN?.trim();
  return token === undefined || token === "" ? null : token;
}

/** `BASHREACTOR_MCP_PORT`, falling back to `PORT`, so one variable can drive a single-container deploy. */
export function resolvePort(env: Record<string, string | undefined>): number {
  const raw = env.BASHREACTOR_MCP_PORT ?? env.PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new BashreactorError(
      "runtime_missing",
      `BASHREACTOR_MCP_PORT must be an integer from 0 to 65535, got "${raw}"`,
    );
  }
  return port;
}

/** `BASHREACTOR_MCP_PATH`, the one path this server answers on. */
export function resolvePath(env: Record<string, string | undefined>): string {
  const raw = env.BASHREACTOR_MCP_PATH?.trim() || DEFAULT_PATH;
  if (raw.includes("?") || raw.includes("#")) {
    throw new BashreactorError("runtime_missing", `BASHREACTOR_MCP_PATH must not carry a query: "${raw}"`);
  }
  return raw.startsWith("/") ? raw : `/${raw}`;
}

export function resolveVersion(env: Record<string, string | undefined>, fallback: string): string {
  return env.BASHREACTOR_VERSION || fallback;
}

export function resolveConfig(
  env: Record<string, string | undefined>,
  version: string,
): McpConfig {
  return {
    apiUrl: resolveApiUrl(env),
    token: resolveToken(env),
    port: resolvePort(env),
    path: resolvePath(env),
    version,
  };
}
