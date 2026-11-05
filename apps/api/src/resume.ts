// SPEC 4.7: a server engine calls resume at startup on every run whose status is still `running`,
// and skips the ones another engine holds. Without this, a rollout would leave every long job sitting
// in a run directory until somebody asked for it by hand.

import { BashreactorError } from "@bashreactor/core";
import type { Engine } from "@bashreactor/engine";

/** Takes on every resumable run and keeps driving it in the background. Returns the ids taken on. */
export async function resumeRunningRuns(
  engine: Engine,
  log: (line: string) => void = (line) => console.log(line),
): Promise<string[]> {
  const taken: string[] = [];
  for (const id of await engine.listRuns()) {
    const record = await engine.getRun(id);
    if (record === null || record.status !== "running") continue;
    taken.push(id);
    engine.resume(id).catch((error: unknown) => {
      // A live claim is not a failure: another engine has that run. Everything else is.
      if (error instanceof BashreactorError && error.code === "run_claimed") {
        log(`run ${id}: left with the engine that holds it`);
        return;
      }
      log(`run ${id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  return taken;
}
