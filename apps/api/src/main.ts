import manifest from "../package.json";
import { resolveConfig, resolveVersion } from "./config.ts";
import { resumeRunningRuns } from "./resume.ts";
import { startServer } from "./startup.ts";

// A config the environment did not give us stays fatal, because there is nothing sane to fall back
// to: without a port there is no socket to bind, and the message the process dies with names the
// variable. Everything past this line is the filesystem and the engine, and those degrade instead.
const config = resolveConfig(process.env, resolveVersion(process.env, manifest.version));

const { server, api } = startServer({ config });

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

// A container's PID 1 gets no default signal handling, so without this every rollout would wait out
// the pod's whole termination grace period before being killed. Runs left `running` are picked up by
// the next process, which is what the resume above is for.
process.on("SIGTERM", () => {
  void server.stop().then(() => {
    api?.close();
    process.exit(0);
  });
});
