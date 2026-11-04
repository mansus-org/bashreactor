# Working on Bashreactor

Read this before you touch anything. It is the contract between the people and agents working on
this repo at the same time.

## The order things are built in

`docs/SPEC.md` (BASHR-1) is the source of truth. If your task needs a decision the spec has not
made, make it, write it into the spec, and say so in your summary. Do not invent a second schema in
your own package.

Dependencies, so you know what you can rely on:

```
1 spec ─┬─> 3 engine ─┬─> 5 api ─┬─> 6 mcp
2 scaffold ┘          4 store ───┘   └─> 7 cli
                      └────────────────> 8 web
                        everything ────> 9 deploy + demo
```

## Directory ownership

One task owns one directory. Do not edit outside yours except to add your package to a workspace
glob (already done) or to `docs/SPEC.md` when you had to extend it.

| Task | Owns |
| --- | --- |
| BASHR-1 spec | `docs/` |
| BASHR-2 scaffold | root config, `.github/`, `Dockerfile`, `.k3s/`, `packages/core/` skeleton |
| BASHR-3 engine | `apps/engine/` |
| BASHR-4 storage | `packages/store/` |
| BASHR-5 REST API | `apps/api/` |
| BASHR-6 MCP server | `apps/mcp/` |
| BASHR-7 CLI | `apps/cli/` |
| BASHR-8 web UI | `apps/web/`, `mockup/`, `docs/design/` |
| BASHR-9 deploy + demo | `examples/` |

## Branches and worktrees

Paseo owns the git layout. One task gets one Paseo workspace, which is a git worktree on its own
branch: `bashr/<n>-<slug>`, branched off `origin/main`. Work inside your own workspace directory
only.

```bash
paseo workspace ls                 # what exists
paseo workspace create --isolation worktree --mode branch-off \
  --new-branch bashr/3-engine --worktree-slug bashr-3-engine --base origin/main
paseo run --workspace <id> "<task>"
```

Commit often, with real messages (`engine: retry a step after its timeout`, not `wip`). Do not push
to `main`, do not touch another task's branch, do not merge: the orchestrator merges in dependency
order and opens the PRs.

## Rules

- TypeScript on `bun`, strict mode. No new runtime dependency without a one-line reason in the
  commit message.
- Every behaviour you add gets a test in the same package. `bun run check` must pass before you
  stop.
- Errors are typed and carry a code, so the CLI, the API and the MCP server print the same thing.
- No placeholders. If something is not built yet, do not stub it with a fake success: return a
  `not_implemented` error and leave the test skipped with the reason.
- Comments say why, never what the line does.

## The look of the UI

The web UI and the mockup are in the Mansus 1-bit language: paper `#e4e2db`, ink `#141414`, grey
only as dither, Anybody for display (28 px and up), Atkinson Hyperlegible Next for anything people
read, Atkinson Hyperlegible Mono for code. The full reasoning is in
`mansus-org/revolution/design/README.md` and `mansus-org/myself/design/README.md` (web app
section); a local copy of both repos is at `/home/nixos/Projects/bashreactor-ref/`.
