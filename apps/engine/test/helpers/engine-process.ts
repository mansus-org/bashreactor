// A child process that drives one run to completion and reports success by exit code. The restart
// test kills this process mid-step and then resumes the run from a fresh Engine over the same store.

import { Engine } from "../../src/engine.ts";
import { FsRunStore } from "../../src/run-store.ts";

const root = process.argv[2];
const runId = process.argv[3];
if (root === undefined || runId === undefined) {
  console.error("usage: bun engine-process.ts <root> <runId>");
  process.exit(2);
}

const engine = new Engine({ store: new FsRunStore(root) });
const record = await engine.drive(runId);
console.log(`engine-process: run ${record.id} ended ${record.status}`);
process.exit(record.status === "succeeded" ? 0 : 1);
