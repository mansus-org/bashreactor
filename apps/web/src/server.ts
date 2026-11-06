// The entry the image runs: `bun server.js`, built from this file.
//
// This is apps/api/src/main.ts with one addition — the web UI mounted in front of the API — and it
// is a separate file because BASHR-8 may not edit apps/api/. Everything else is kept the same on
// purpose: the same fatal config resolution, the same resume-on-startup, the same signal handling,
// because a container's PID 1 gets no default signal handling and drops a rollout's runs if it is
// skipped. `startServer`'s `build` hook is the seam: the API is built exactly as main.ts builds it,
// and only its `fetch` is wrapped.

import manifest from "../package.json";
import { createApi, resolveConfig, resolveVersion, resumeRunningRuns, startServer, stopOnSignals } from "@bashreactor/api";
import type { Api, ApiConfig } from "@bashreactor/api";
import { mountApp } from "./index.ts";

const config = resolveConfig(process.env, resolveVersion(process.env, manifest.version));

const startup = startServer({
  config,
  build: (builtConfig: ApiConfig, log: (line: string) => void): Api => {
    const built = createApi({ config: builtConfig, log });
    const ui = mountApp((request) => built.fetch(request), { log });
    return { ...built, fetch: async (request: Request) => await ui(request) };
  },
});
const { api } = startup;

if (api !== null) {
  if (config.adminHash === null) {
    console.log("bashreactor: /v1 is disabled, no admin token is set in the environment");
  }

  // A rollout replaces the pod mid-run, so every run still marked `running` is taken up again before
  // anything else is served (SPEC 4.7). With no engine there is nothing to take up.
  void resumeRunningRuns(api.engine).catch((error: unknown) => {
    console.log(`bashreactor: could not resume runs: ${error instanceof Error ? error.message : String(error)}`);
  });
}

stopOnSignals(startup);
