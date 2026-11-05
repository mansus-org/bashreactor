import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../src/engine.ts";
import { FsRunStore } from "../src/run-store.ts";
import type { RunRecord } from "../src/run.ts";

const examples = new URL("../../../docs/examples/", import.meta.url);
const helper = fileURLToPath(new URL("./helpers/engine-process.ts", import.meta.url));

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error("waitFor timed out");
}

describe("restart", () => {
  test("a new engine over the same store resumes an interrupted run to completion", async () => {
    const root = mkdtempSync(join(tmpdir(), "bashreactor-restart-"));
    roots.push(root);

    const engine = new Engine({ store: new FsRunStore(root) });
    const record = await engine.start(fileURLToPath(new URL("word-report.yaml", examples)), {
      lines: 80000,
      seed: 7,
      title: "Restart",
    });
    const runId = record.id;

    const procA = Bun.spawn(["bun", helper, root, runId], { stdout: "pipe", stderr: "pipe" });

    // Wait until generate's second attempt is live, then kill the engine mid-step.
    await waitFor(async () => {
      const current = await new FsRunStore(root).loadRun(runId);
      if (current === null) return false;
      return current.steps.generate!.attempts.some((a) => a.n >= 2 && a.status === "running" && a.pid !== null);
    }, 30_000);

    procA.kill("SIGKILL");
    await procA.exited;

    // A brand new engine over the same store picks the run up from what was persisted.
    const engineB = new Engine({ store: new FsRunStore(root) });
    const final = await engineB.resume(runId);

    expect(final.status).toBe("succeeded");
    expect(final.outputs!.report).toBe("steps/report/attempts/1/outputs/report");
    const generate = final.steps.generate!;
    expect(generate.attempts.some((a) => a.status === "interrupted")).toBe(true);
    expect(generate.attempts.some((a) => a.status === "succeeded")).toBe(true);

    const stored: RunRecord = (await new FsRunStore(root).loadRun(runId))!;
    expect(stored.status).toBe("succeeded");
  }, 120_000);
});
