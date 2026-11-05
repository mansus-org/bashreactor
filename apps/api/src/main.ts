import manifest from "../package.json";
import { createApi } from "./app.ts";
import { resolveConfig, resolveVersion } from "./config.ts";
import { resumeRunningRuns } from "./resume.ts";

const config = resolveConfig(process.env, resolveVersion(process.env, manifest.version));
const api = createApi({ config });

const server = Bun.serve({ port: config.port, fetch: (request) => api.fetch(request) });
console.log(`bashreactor listening on :${server.port}`);
if (config.adminHash === null) {
  console.log("bashreactor: /v1 is disabled, no admin token is set in the environment");
}

// A rollout replaces the pod mid-run, so every run still marked `running` is taken up again before
// anything else is served (SPEC 4.7).
void resumeRunningRuns(api.engine).catch((error: unknown) => {
  console.log(`bashreactor: could not resume runs: ${error instanceof Error ? error.message : String(error)}`);
});

// A container's PID 1 gets no default signal handling, so without this every rollout would wait out
// the pod's whole termination grace period before being killed. Runs left `running` are picked up by
// the next process, which is what the line above is for.
process.on("SIGTERM", () => {
  void server.stop().then(() => process.exit(0));
});
