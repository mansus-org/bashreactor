# @bashreactor/web

The web UI, and the process the image runs.

One process answers everything. `src/server.ts` is `apps/api/src/main.ts` with `mountApp` wrapped
around the API's `fetch`: `/app` and everything under it is served here, and every other path — `/v1`,
`/healthz` — goes straight back to the API over the same socket. It is a separate file because BASHR-8
may not edit `apps/api/`, and it keeps main.ts's config resolution, resume-on-startup and signal
handling on purpose: a container that is PID 1 gets no default signal handling and drops a rollout's
runs if it skips them.

The browser is a client of `/v1` like the CLI and the MCP server: bearer token, same scopes, same
error objects. There is no websocket and no second API — the screens poll. A run reads
`GET /v1/runs/:id` once a second (`POLL_MS` in `src/client/run-shared.ts`) and stops asking once it is
finished; the Runs list (`src/client/runs-list.ts`) reads `GET /v1/runs` once a second while anything
on it is running and every fifteen seconds (`IDLE_POLL_MS`) while nothing is, because a run started
from the CLI has to turn up by itself. Neither reads while the tab is hidden, and both read the moment
it is looked at again.

## What it serves

The asset table is built once, at startup, in memory (`buildAssets()` in `src/assets.ts`):

| Path | What answers it |
| --- | --- |
| `/app` | 301 to `/app/` |
| `/app/`, and any `/app` path that is not a file | `src/client/index.html`, so a deep link survives a reload |
| `/app/assets/<name>.js` | each `src/client/*.ts`, transpiled at startup |
| `/app/assets/yaml-lib.js` | the YAML parser the editor edits with, bundled (see *Build*) |
| `/app/assets/style.css` | `src/client/styles/*.css`, joined in the fixed order below |
| `/app/assets/fonts/*.woff2` | the three faces, from `src/fonts.ts` |
| `/app/OFL.txt` | the font licence, served as itself so a person can read it |
| anything else, and any method that is not `GET` or `HEAD` | the API, which answers `not_found` 404 for a path it does not have |

Fonts are `immutable` and cached for a year; everything else is `no-cache` with an etag, and an
`if-none-match` gets a 304. The CSP allows nothing but this origin: no inline script, no CDN, no form
that posts elsewhere. A missing `assets/` path is a real 404 — the client's own routes are the `/app`
paths that are not files.

### The stylesheet

The browser asks for one file and the server joins `src/client/styles/` into it in this order:

1. `base.css` — font faces, tokens, reset, type, the components and the shared controls;
2. `shell.css` — the sidebar, the top bar and its menu, and the token gate;
3. `dashboard.css`;
4. `runs-list.css`;
5. `run-page.css`;
6. `pipelines.css`;
7. `editor.css`;
8. `blocks.css`;
9. `settings.css`.

`STYLE_FILES` in `src/assets.ts` is that list, and `src/raw.js` imports each file. A screen file that
has no rules yet holds one comment naming the screen. A rule used by two screens lives in `base.css`,
not in either screen's file. `src/assets.test.ts` fails when a CSS file on disk is missing from the
list, and checks that the served `style.css` is exactly the files joined in that order.

### The shell and the routes

`src/client/index.html` is the shell: the sidebar (wordmark, the four screens and Settings, who is
signed in and Sign out), and, below 940 px, a top bar with a Menu button and the same items in a
panel. `src/client/app.ts` draws the nav from the 7×7 bitmaps, marks the current section with
`aria-current="page"`, and routes under `/app`:

| Path | Screen |
| --- | --- |
| `/` | Dashboard (BASHR-56) |
| `/runs`, `/runs/:id` | the Runs list and one run |
| `/pipelines`, `/pipelines/:name` | Pipelines and one pipeline (BASHR-57) |
| `/pipelines/:name/edit`, `/pipelines-new` | the editor |
| `/blocks`, `/blocks/:name`, `/blocks/:name/edit`, `/blocks-new` | the library and its writer |
| `/settings` | Settings (BASHR-60) |

A screen whose ticket has not landed answers `not_implemented` with its ticket number, rather than
drawing a fake one. `/pipeline` rewrites to `/pipelines-new`, and `/pipeline/:name/:version` to
`/pipelines/:name/edit?version=:version`, with `history.replaceState` so Back does not loop.

## Build

There is no build step for the UI. `bun run build` at the repo root bundles `src/server.ts` into
`dist/server.js`, and bun inlines everything the browser needs on the way:

- the client's `.ts`, the stylesheet and `index.html` arrive as text through the
  `with { type: "text" }` imports in `src/raw.js`, and each client module is transpiled by
  `Bun.Transpiler` when the server starts, so what the server holds is what the source file says;
- the three woff2 faces are base64 inside `src/fonts.ts`, which `bun apps/web/scripts/embed-fonts.ts`
  regenerates from `apps/web/fonts/` — run it after touching a font;
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

## Modules

The shell is `app.ts`; each screen is a module of its own so its rules and its code can change
without another screen's file moving:

| Module | What it owns |
| --- | --- |
| `client/app.ts` | the router, the token gate and the chrome |
| `client/ui.ts` | every component a screen is built from, and the formatters |
| `client/dom.ts` | `el`, the 7×7 signs and nav glyphs, the error box and the status region |
| `client/api.ts` | the client half of `/v1`, including run filters, disk and tokens |
| `client/library.ts` | reads the block versions a stored or snapshotted pipeline names |
| `client/editor.ts` | the pipeline editor and its inspector |
| `client/start-run.ts` | the Start dialog: typed input fields and the POST that starts a run |
| `client/runs-list.ts` | `/runs`, the list on its own clock |
| `client/run-page.ts` | `/runs/:id`, steps, actions and the log pane |
| `client/run-shared.ts` | the clock, polling intervals and run-status helpers both run screens use |
| `client/blocks.ts` | the block library and its writer |
| `client/dashboard.ts`, `client/pipelines.ts`, `client/pipeline-page.ts`, `client/settings.ts` | the redesigned screens, each answering `not_implemented` until its ticket |
| `client/timeline.ts` | where BASHR-55 draws the run timeline |
| `client/logs.ts`, `client/model.ts`, `client/graph.ts`, `client/yaml*.ts` | the pieces the screens share |

A new module still has to be registered in `src/raw.js` and `CLIENT_MODULES` in `src/assets.ts`.
The screen tickets replace the body of a module that already exists; they do not add a new one.

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
  the text the server serves rather than by importing it statically: bun caches modules by path and
  `src/raw.js` has already loaded that path as a string. A pure module (like `logs.ts`) can be a
  `data:` import, see `client/logs.test.ts`; a module with siblings is written out under its own name
  by `serveModules` in `client.testkit.ts`, which is what `ui.test.ts`, `shell.test.ts`, `api.test.ts`
  and `library.test.ts` do. Files ending `.testkit.ts` are scaffolding and are never shipped. The run
  screens share `client/runs.testkit.ts`, while `client/run-page.test.ts` and
  `client/runs-list.test.ts` hold one screen's describes each.
- **Typecheck runs twice on purpose**: `tsc -p .` for the server side, `tsc -p tsconfig.client.json`
  for `src/client` against the DOM lib. `bun run typecheck` in this package does both.
- `src/server.ts` stays a near-copy of `apps/api/src/main.ts`. When that file changes, this one has to
  follow, because the container runs this one.
- The look is the Mansus 1-bit language — paper `#e4e2db`, ink `#141414`, grey only as dither. The
  reasoning is in `AGENTS.md` and the two design repos it names; `apps/web/fonts/` is where the
  faces come from.

## Tests

`bun test` in this package. `src/index.test.ts` mounts the UI in front of a real API in one process,
which is how it is deployed, and re-probes the API's own routes so the mount cannot quietly change
what `/` and `/healthz` answer; it also publishes, validates, stores, starts and follows the worked
example through the one handler. The design system is held down by `src/client/ui.test.ts` (markup,
formatters, keyed table updates), `src/client/shell.test.ts` (routes, redirects, `aria-current`, the
phone menu and the gate) and `src/client/api.test.ts` (the newer `/v1` shapes). The run screens'
tests share `src/client/runs.testkit.ts`, and are split into `run-page.test.ts` and
`runs-list.test.ts`. `src/server.test.ts` runs this entry as a real process over a real socket, and
`src/shutdown.test.ts` checks SPEC 4.7's shutdown against both the source and the bundle
`bun run build` makes, since the image ships only the bundle.
