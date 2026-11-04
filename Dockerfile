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
COPY --from=build /app/dist/server.js ./server.js
# Declared after the build stage so a new version only touches this metadata, not the cached build.
ARG VERSION
ENV BASHREACTOR_VERSION=${VERSION}
ENV PORT=8080
USER 10001:10001
EXPOSE 8080
CMD ["bun", "server.js"]
