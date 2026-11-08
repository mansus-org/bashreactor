import manifest from "../package.json";
import { resolveConfig, resolveVersion } from "./config.ts";
import { resumeRunningRuns } from "./resume.ts";
import { announceRetention } from "./retention.ts";
import { startServer, stopOnSignals } from "./startup.ts";

// A config the environment did not give us stays fatal, because there is nothing sane to fall back
// to: without a port there is no socket to bind, and the message the process dies with names the
// variable. Everything past this line is the filesystem and the engine, and those degrade instead.
const config = resolveConfig(process.env, resolveVersion(process.env, manifest.version));

const startup = startServer({ config });
const { api } = startup;

// Handed to `stopOnSignals` below, so the trim stops before the engine does: a sweep must not still be
// deleting runs at the moment the data directory is being walked away from.
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

  // SPEC 4.11: the volume has a size and a run never stops writing to it, so what happens to old runs
  // is said out loud at startup either way. "Off" is the default and a legitimate answer — an operator
  // trims from outside — but it must not be a silent one. After the resume, so that the first thing to
  // walk the home is the thing that decides which runs are live.
  stopRetention = announceRetention(api.engine, config.retentionMs);
}

// SPEC 4.7: SIGTERM and SIGINT stop the engine's runs gracefully; runs left `running` are picked up by
// the next process, which is what the resume above is for.
stopOnSignals(startup, { onStop: () => stopRetention() });
