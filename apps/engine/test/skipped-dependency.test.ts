// Skipped dependencies, docs/SPEC.md 4.4: when a step fails, every pending step that depends on it
// becomes skipped at once, and everything that does not depend on it carries on. Skipped means never
// started, and it is final until somebody retries the run.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../src/engine.ts";
import { FsRunStore } from "../src/run-store.ts";
import type { RunRecord } from "../src/run.ts";

const fixtures = new URL("./fixtures/", import.meta.url);
const fixture = (name: string) => fileURLToPath(new URL(name, fixtures));

const roots: string[] = [];
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bashreactor-skip-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const statusMap = (record: RunRecord) =>
  Object.fromEntries(Object.entries(record.steps).map(([id, step]) => [id, step.status]));

describe("skipped dependencies", () => {
  test("one fatal step skips everything below it and nothing beside it", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(fixture("skip-graph.yaml"));
    const final = await engine.drive(record.id);

    // skip-graph.yaml: root leaves 78; left, right, leaf, join and referrer are below it in one way
    // or another; independent and late are not.
    expect(statusMap(final)).toEqual({
      root: "failed",
      independent: "succeeded",
      left: "skipped",
      right: "skipped",
      leaf: "skipped",
      join: "skipped",
      late: "succeeded",
      referrer: "skipped",
    });

    // The same states are what is on disk, because that is all the API and the CLI can read.
    const stored = (await store.loadRun(record.id))!;
    expect(statusMap(stored)).toEqual(statusMap(final));

    for (const stepId of ["left", "right", "leaf", "join", "referrer"]) {
      const step = final.steps[stepId]!;
      // Skipped means never started: nothing bound, no attempt, no outputs, and no failure of its own.
      expect(step.attempts).toEqual([]);
      expect(step.attempts_used).toBe(0);
      expect(step.with).toBeNull();
      expect(step.outputs).toBeNull();
      expect(step.failure).toBeNull();
      expect(step.next_attempt_at).toBeNull();
      // Not even a directory for an attempt that never happened.
      expect((await store.stat(record.id, `steps/${stepId}/attempts`)).kind).toBe("missing");
    }

    // leaf sits under left, which was skipped rather than failed: a skip propagates through a skip.
    expect(final.steps.leaf!.needs).toEqual(["left"]);
    // join had one parent that succeeded and one that was skipped, and still must not run. The list
    // is in declaration order of the steps named, not the order they were written in (4.9).
    expect(final.steps.join!.needs).toEqual(["independent", "right"]);
    // referrer never mentions root in `needs`; its dependency is the expression in its `with` (3.6).
    expect(final.steps.referrer!.needs).toEqual(["root"]);

    // root spent its single attempt: 78 is block_fatal, which no budget retries.
    expect(final.steps.root!.failure).toEqual({ code: "block_fatal", message: "block_fatal" });
    expect(final.steps.root!.attempts_used).toBe(1);

    // The branch that had nothing to do with root ran, including the step that only became eligible
    // once another step had finished: a failure stops what depends on it and nothing else (4.4).
    expect(final.steps.independent!.attempts).toHaveLength(1);
    expect(final.steps.late!.attempts).toHaveLength(1);

    // Skipped and failed together make the run failed, not cancelled (4.4).
    expect(final.status).toBe("failed");
    expect(final.finished_at).not.toBeNull();
    expect(final.outputs).toBeNull();
    expect(final.cancel_requested_at).toBeNull();
  }, 30_000);

  test("a manual retry takes the skipped steps back to pending and runs them", async () => {
    // skip-retry.yaml: a gate that fails its only attempt and a step behind it. The gate is flaky.sh,
    // which finishes when it finds the marker its first attempt left in the work directory.
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(fixture("skip-retry.yaml"));
    const first = await engine.drive(record.id);

    expect(statusMap(first)).toEqual({ gate: "failed", downstream: "skipped" });
    expect(first.steps.downstream!.attempts).toHaveLength(0);

    const final = await engine.retry(record.id);

    expect(statusMap(final)).toEqual({ gate: "succeeded", downstream: "succeeded" });
    expect(final.status).toBe("succeeded");

    // 4.6: the retry resets the budget but not the attempt numbers, and the old attempts stay.
    const gate = final.steps.gate!;
    expect(gate.attempts.map((attempt) => attempt.status)).toEqual(["failed", "succeeded"]);
    expect(gate.attempts_used).toBe(1);
    expect(gate.failure).toBeNull();

    // The dependant ran for the first time, and its inputs were bound then, not before.
    const downstream = final.steps.downstream!;
    expect(downstream.attempts).toHaveLength(1);
    expect(downstream.with).toEqual({ exit_code: 0, note: "" });
    expect(downstream.outputs).toEqual({ done: "done" });
    expect(final.outputs).toEqual({}); // skip-retry.yaml declares no pipeline outputs
  }, 30_000);
});
