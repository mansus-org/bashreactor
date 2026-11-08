// The entry the image runs: `bun server.js`, built from this file.
//
// This is apps/api/src/main.ts with two additions — the web UI mounted in front of the API, and the
// MCP endpoint beside it — and it is a separate file because BASHR-8 may not edit apps/api/.
// Everything else is kept the same on purpose: the same fatal config resolution, the same
// resume-on-startup, the same signal handling, because a container's PID 1 gets no default signal
// handling and drops a rollout's runs if it is skipped. `startServer`'s `build` hook is the seam:
// the API is built exactly as main.ts builds it, and only its `fetch` is wrapped.

import manifest from "../package.json";
import { createApi, resolveConfig, resolveVersion, resumeRunningRuns, announceRetention, startServer, stopOnSignals } from "@bashreactor/api";
import type { Api, ApiConfig } from "@bashreactor/api";
import { createMcpServer, resolveConfig as resolveMcpConfig } from "@bashreactor/mcp";
import type { McpOptions } from "@bashreactor/mcp";
import { mountApp } from "./index.ts";
import { withForwardedScheme } from "./proxy.ts";

const config = resolveConfig(process.env, resolveVersion(process.env, manifest.version));

const startup = startServer({
  config,
  build: (builtConfig: ApiConfig, log: (line: string) => void): Api => {
    const built = createApi({ config: builtConfig, log });
    const ui = mountApp((request) => built.fetch(request), { log });

    // The MCP server runs in this process rather than as a second one, because the platform's chart
    // renders exactly one container and exactly one Service port: a second process on its own port
    // would have no Service and no route, so nothing outside this pod could reach it, and a process
    // nothing watches dies silently while the pod still reads Ready. Mounted here it is published on
    // the port the Service already points at, behind the ingress the app already has, and it cannot
    // be up while the API is down or the other way round.
    //
    // It still speaks to the API the way every other client does — a bearer token spent on a URL —
    // except the call goes to the API's own handler instead of leaving through the socket and
    // coming back. `BASHREACTOR_URL` keeps its meaning for anything that reads it back.
    const mcpUrl = process.env.BASHREACTOR_URL ?? `http://127.0.0.1:${builtConfig.port}`;
    // The client behind the MCP server hands this a URL string and an init, never a Request; Bun
    // types `fetch` as carrying a `preconnect` static, which no stand-in can have.
    const toApi = ((input: string | Request, init?: RequestInit) =>
      built.fetch(input instanceof Request ? input : new Request(input, init))) as McpOptions["fetch"];
    const mcp = createMcpServer(
      resolveMcpConfig({ ...process.env, BASHREACTOR_URL: mcpUrl }, builtConfig.version),
      { log, fetch: toApi },
    );
    const mcpPath = mcp.config.path;

    return {
      ...built,
      fetch: async (request: Request): Promise<Response> => {
        // The scheme is put back before anything reads the URL, so the API's own `/` redirect is
        // fixed by the same line and apps/api/ does not have to know it sits behind a proxy.
        const original = withForwardedScheme(request);
        if (new URL(original.url).pathname === mcpPath) return await mcp.fetch(original);
        return await ui(original);
      },
    };
  },
});
const { api } = startup;

// Stopped before the engine, so a sweep is never mid-delete when the process is going away.
let stopRetention: () => Promise<void> = async () => {};

if (api !== null) {
  if (config.adminHash === null) {
    console.log("bashreactor: /v1 is disabled, no admin token is set in the environment");
  }

  // A rollout replaces the pod mid-run, so every run still marked `running` is taken up again before
  // anything else is served (SPEC 4.7). With no engine there is nothing to take up.
  void resumeRunningRuns(api.engine).catch((error: unknown) => {
    console.log(`bashreactor: could not resume runs: ${error instanceof Error ? error.message : String(error)}`);
  });

  // The other half of what a long-lived pod owes the volume it mounts: a size, and a run that never
  // stops writing to it (SPEC 4.11). This is the entry the image runs, so the trim that keeps it from
  // filling has to be started here and not only in apps/api's own main.
  stopRetention = announceRetention(api.engine, config.retentionMs);
}

stopOnSignals(startup, { onStop: () => stopRetention() });
