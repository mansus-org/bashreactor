# Bashreactor

Run long bash jobs as pipelines of blocks, and drive them from the CLI, the web or an agent.

A **block** is a bash file that declares its inputs and outputs. A **pipeline** is a YAML file that
wires blocks together: step dependencies, outputs feeding inputs, retries and timeouts. Shaped like
GitHub Actions workflows, but for jobs that run for hours.

Status: being built. The spec is in [`docs/SPEC.md`](docs/SPEC.md).

## Layout

| Path | What |
| --- | --- |
| `docs/SPEC.md` | The block format and the pipeline YAML schema. Everything else follows it. |
| `docs/examples/` | The worked example pipeline the tests run against. |
| `packages/core/` | Block + pipeline types and the parser, shared by everything. |
| `packages/store/` | Pipelines, runs, block versions, artifacts. |
| `apps/engine/` | The run engine: scheduling, state, logs, resume/cancel/retry. |
| `apps/api/` | REST API with token auth. |
| `apps/mcp/` | MCP server for agents. |
| `apps/cli/` | `bashreactor` CLI, local and remote mode. |
| `apps/web/` | Web UI: pipeline editor, live run view, block library. |
| `mockup/` | Static UI mockup, no build step. |

## One command

```bash
bun install
bun run check     # lint + typecheck + test
```

## Deploy

Push to `main` builds the Dockerfile and pushes `sha-<commit>` to GHCR; the cluster picks it up at
`bashreactor.mansus.org`. A pull request pushes `pr-<number>-<commit>` and gets
`https://bashreactor-pr-<number>.mansus.org` until it closes. See
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).
