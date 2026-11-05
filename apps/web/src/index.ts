// The web UI, mounted in front of the API's fetch handler.
//
// One process is deployed, so the UI cannot be a second server: `mountApp` takes the handler that
// answers /v1 and returns one that answers `/app` and everything under it first, and hands the rest
// straight back. That is the whole integration — the browser then talks to /v1 with a bearer token
// exactly like the CLI and the MCP server do, over the same socket.
//
// The shape is the one the reference app ships (myself/internal/server/ui.go): static files under
// /app, every /app path that is not a file gets index.html so a deep link survives a reload, fonts
// cached forever and everything else revalidated, and a CSP that allows nothing but this origin.

import { buildAssets } from "./assets.ts";
import type { Asset } from "./assets.ts";

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface MountOptions {
  /**
   * Where to mount the UI. `/app` is what the client's own links are written against, so this exists
   * for tests and for nothing else.
   */
  path?: string;
  /** Same sink the API logs to, so one request is one line whatever it hit. */
  log?: (line: string) => void;
}

/** Nothing but this origin: no inline script, no third party, no form that posts elsewhere. */
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function mountApp(fallback: FetchHandler, options: MountOptions = {}): FetchHandler {
  const base = (options.path ?? "/app").replace(/\/+$/, "");
  const log = options.log ?? null;
  const assets = buildAssets();

  function send(asset: Asset, request: Request): Response {
    const headers = new Headers({
      "content-type": asset.ctype,
      etag: asset.etag,
      "cache-control": asset.immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    if (request.headers.get("if-none-match") === asset.etag) return new Response(null, { status: 304, headers });
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(asset.data, { status: 200, headers });
  }

  function serve(request: Request, path: string): Response {
    if (path === "") return send(assets.index, request);
    const file = assets.files.get(path);
    if (file !== undefined) return send(file, request);
    // A missing asset is a 404; anything else is a route the client draws itself.
    if (path.startsWith("assets/")) {
      return Response.json({ code: "not_found", message: `there is no asset "${path}" in the web UI` }, { status: 404 });
    }
    return send(assets.index, request);
  }

  return (request: Request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path !== base && !path.startsWith(`${base}/`)) return fallback(request);
    // The API owns every method: a POST to /app is 501 not_implemented, like any route it does not have.
    if (request.method !== "GET" && request.method !== "HEAD") return fallback(request);
    if (path === base) return Response.redirect(new URL(`${base}/`, url).href, 301);

    const started = Date.now();
    const response = serve(request, path.slice(base.length + 1));
    log?.(`${request.method} ${path} ${response.status} ${Date.now() - started}ms -`);
    return response;
  };
}

export type { Asset };
