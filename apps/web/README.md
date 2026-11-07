# @bashreactor/web

The web UI, and the process the image runs.

One process answers everything. `src/server.ts` is `apps/api/src/main.ts` with `mountApp` wrapped
around the API's `fetch`: `/app` and everything under it is served here, and every other path — `/v1`,
`/healthz` — goes straight back to the API over the same socket. It is a separate file because BASHR-8
may not edit `apps/api/`, and it keeps main.ts's config resolution, resume-on-startup and signal
handling on purpose: a container that is PID 1 gets no default signal handling and drops a rollout's
runs if it skips them.

The browser is a client of `/v1` like the CLI and the MCP server: bearer token, same scopes, same
error objects. There is no websocket and no second API — the run screen polls `GET /v1/runs/:id` once a
second (`POLL_MS` in `src/client/runs.ts`).

## What it serves

The asset table is built once, at startup, in memory (`buildAssets()` in `src/assets.ts`):

| Path | What answers it |
| --- | --- |
| `/app` | 301 to `/app/` |
| `/app/`, and any `/app` path that is not a file | `src/client/index.html`, so a deep link survives a reload |
| `/app/assets/<name>.js` | each `src/client/*.ts`, transpiled at startup |
| `/app/assets/yaml-lib.js` | the YAML parser the editor edits with, bundled (see *Build*) |
| `/app/assets/style.css` | `src/client/style.css` |
| `/app/assets/fonts/*.woff2` | the three faces, from `src/fonts.ts` |
| `/app/OFL.txt` | the font licence, served as itself so a person can read it |
| anything else, and any method that is not `GET` or `HEAD` | the API, which answers `not_found` 404 for a path it does not have |

Fonts are `immutable` and cached for a year; everything else is `no-cache` with an etag, and an
`if-none-match` gets a 304. The CSP allows nothing but this origin: no inline script, no CDN, no form
that posts elsewhere. A missing `assets/` path is a real 404 — the client's own routes are the `/app`
paths that are not files.

## Build

There is no build step for the UI. `bun run build` at the repo root bundles `src/server.ts` into
`dist/server.js`, and bun inlines everything the browser needs on the way:

- the client's `.ts`, the stylesheet and `index.html` arrive as text through the
  `with { type: "text" }` imports in `src/raw.js`, and each client module is transpiled by
  `Bun.Transpiler` when the server starts, so what the server holds is what the source file says;
- the three woff2 faces are base64 inside `src/fonts.ts`, which `bun apps/web/scripts/embed-fonts.ts`
  regenerates from `mockup/fonts/` — run it after touching a font;
- the YAML parser is bundled for the browser at build time by `src/yaml-lib.macro.ts`, because the
  image ships one file with nothing beside it to fetch.

## Run it

From a checkout, which is what `examples/serve.sh` execs:

```bash
BASHREACTOR_HOME=/tmp/bashreactor-dev BASHREACTOR_ADMIN_TOKEN=br_dev PORT=8080 \
  bun apps/web/src/server.ts
```

Open <http://127.0.0.1:8080/app>. Restart it to see a client change: the assets are read at startup,
not watched. Without an admin token (`BASHREACTOR_ADMIN_TOKEN`, or its sha256 in
`BASHREACTOR_ADMIN_TOKEN_SHA256`) `/app` still serves and `/healthz` still answers, and every `/v1`
route is 503 `runtime_missing` naming the variable it wants. The root `bun run serve` starts
`apps/api/src/main.ts` instead, which is the API with no UI in front of it.

The container runs the same entry point: the Dockerfile does `bun run build` in a build stage and
copies only `dist/server.js` into `oven/bun:1-alpine`, with `CMD ["bun", "server.js"]`,
`BASHREACTOR_HOME=/data`, `PORT=8080` and `USER 10001`. It installs `bash`, `curl`, `jq` and `uv`
because SPEC 2.6 says the engine refuses to start without them.

## Before you edit `src/client/`

- **A new module has to be registered twice**: imported in `src/raw.js` and named in `CLIENT_MODULES`
  in `src/assets.ts`. Miss it and the browser is served a 404 for `assets/<name>.js`, the ES module
  graph never resolves, and the screen sits on *Loading.* with nothing in the console for you.
  `src/assets.test.ts` is the check: it reads the bytes the server serves, resolves every import the
  way the browser would, and fails on a client file the table does not know.
- **Import a sibling as `./x.js`, not `./x.ts`.** The files are TypeScript; what is served is `.js`.
  The test above reads the served bytes, which cannot see `import type`, so it checks those lines on
  the source.
- **No dependencies.** The CSP is `'self'` only and there is no bundler to add one with. The one piece
  of third-party code is the YAML parser, and it is bundled on purpose.
- **Tests are colocated and run with `bun test` in this package.** A client module is tested through
  the text the server serves — a `data:` import, see `client/logs.test.ts` — rather than by importing
  `./logs.ts`: bun caches modules by path and `src/raw.js` has already loaded that path as a string.
  Files ending `.testkit.ts` are scaffolding and are never shipped.
- **Typecheck runs twice on purpose**: `tsc -p .` for the server side, `tsc -p tsconfig.client.json`
  for `src/client` against the DOM lib. `bun run typecheck` in this package does both.
- `src/server.ts` stays a near-copy of `apps/api/src/main.ts`. When that file changes, this one has to
  follow, because the container runs this one.
- The look is the Mansus 1-bit language — paper `#e4e2db`, ink `#141414`, grey only as dither. The
  reasoning is in `AGENTS.md` and the two design repos it names; `mockup/` is the static version of
  these screens, and `mockup/fonts/` is where the faces come from.

## Tests

`bun test` in this package. `src/index.test.ts` mounts the UI in front of a real API in one process,
which is how it is deployed, and re-probes the API's own routes so the mount cannot quietly change
what `/` and `/healthz` answer; it also publishes, validates, stores, starts and follows the worked
example through the one handler. `src/server.test.ts` runs this entry as a real process over a real
socket, and `src/shutdown.test.ts` checks SPEC 4.7's shutdown against both the source and the bundle
`bun run build` makes, since the image ships only the bundle.
