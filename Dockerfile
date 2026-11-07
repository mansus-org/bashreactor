FROM oven/bun:1-alpine AS build
WORKDIR /app
# A frozen install needs every workspace manifest. Copying only those keeps this layer cached until
# dependencies actually change.
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/store/package.json packages/store/
COPY apps/engine/package.json apps/engine/
COPY apps/api/package.json apps/api/
COPY apps/mcp/package.json apps/mcp/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN bun run build

FROM oven/bun:1-alpine
WORKDIR /app
# SPEC 2.6: an engine checks these on PATH at startup and refuses to start without them. The base
# image already brings bun and busybox's awk, grep, gzip, sed, tar and coreutils; these four are what
# it is missing, so without them the image we ship would reject its first block. Before USER, as apk
# needs root.
RUN apk add --no-cache bash curl jq uv
COPY --from=build /app/dist/server.js ./server.js
# The process runs as a uid with no entry in /etc/passwd, so it has no home to fall back on and
# $BASHREACTOR_HOME resolves under /, which 10001 cannot write: the store's first mkdir threw here
# and the container died before it ever listened. Give it a directory it owns, and make that its home
# so anything else that asks for one lands somewhere writable. A deploy mounts its volume here.
RUN mkdir -p /data && chown 10001:10001 /data
ENV BASHREACTOR_HOME=/data
ENV HOME=/data
# Declared after the build stage so a new version only touches this metadata, not the cached build.
ARG VERSION
ENV BASHREACTOR_VERSION=${VERSION}
ENV PORT=8080
USER 10001:10001
EXPOSE 8080
# One process, one port: it serves the UI at /app, the API at /v1, the MCP endpoint at /mcp and
# /healthz. Do not add a second process here — nothing would watch it, and the readiness probe only
# asks the API. docs/DEPLOY.md has the reasoning and what a deploy still needs.
CMD ["bun", "server.js"]
