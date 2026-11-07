// The retry budget: docs/SPEC.md 4.5 (what an attempt costs), 3.5 (how long a wait is) and 2.8
// (which exits may retry). The attempt count and the final step status are what the API returns and
// the CLI prints, so they are pinned here rather than left to whatever the scheduler happens to do.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Value } from "@bashreactor/core";
import { Engine } from "../src/engine.ts";
import { FsRunStore } from "../src/run-store.ts";
import type { RunRecord } from "../src/run.ts";

const fixtures = new URL("./fixtures/", import.meta.url);
const fixture = (name: string) => fileURLToPath(new URL(name, fixtures));

const roots: string[] = [];
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bashreactor-retry-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error("waitFor timed out");
}

/** Stands a pipeline up in a temp home of its own and drives it to a final status. */
async function driveToDone(pipeline: string, inputs: Record<string, Value> = {}) {
  const store = new FsRunStore(newRoot());
  const engine = new Engine({ store });
  const record = await engine.start(fixture(pipeline), inputs);
  return { store, id: record.id, final: await engine.drive(record.id) };
}

const statuses = (record: RunRecord) => Object.values(record.steps).map((step) => step.status);

describe("retry budget", () => {
  // retry-budget.yaml: one step, max_attempts 3, delay 0s, and the exit code comes from the test.
  test("a block that asks to be retried spends one attempt each time and stops when the budget is spent", async () => {
    const { store, id, final } = await driveToDone("retry-budget.yaml", { exit_code: 75 });

    expect(final.status).toBe("failed");
    expect(final.finished_at).not.toBeNull();
    expect(final.outputs).toBeNull();

    const step = final.steps.work!;
    expect(step.status).toBe("failed");
    expect(step.failure).toEqual({ code: "retry_requested", message: "retry_requested" });
    // The number the CLI prints in its ATTEMPTS column and the API serves as attempts_used.
    expect(step.attempts_used).toBe(3);
    expect(step.next_attempt_at).toBeNull();
    expect(step.outputs).toBeNull();

    // Attempt numbers go up by one for every attempt the step ever had (4.5), and each one keeps the
    // exit that ended it, so a reader can tell three tries from one long one.
    expect(step.attempts.map((attempt) => attempt.n)).toEqual([1, 2, 3]);
    expect(step.attempts.map((attempt) => attempt.status)).toEqual(["failed", "failed", "failed"]);
    expect(step.attempts.map((attempt) => attempt.exit_code)).toEqual([75, 75, 75]);
    expect(step.attempts.map((attempt) => attempt.signal)).toEqual([null, null, null]);
    expect(step.attempts.map((attempt) => attempt.failure?.code)).toEqual([
      "retry_requested",
      "retry_requested",
      "retry_requested",
    ]);
    expect(step.attempts.every((attempt) => attempt.started_at !== null && attempt.finished_at !== null)).toBe(true);

    // Each attempt logged to its own file, and the block was told which attempt it was.
    for (const n of [1, 2, 3]) {
      const log = await store.readFile(id, `steps/work/attempts/${n}/log`);
      expect(text(log!)).toContain(`attempt ${n}: leaving 75`);
    }
  }, 30_000);

  test("an unexpected non-zero exit is retried as far as the budget reaches", async () => {
    // Row 6 of 2.8: anything else that is not zero is an accident, and the author asked for retries.
    const { final } = await driveToDone("retry-budget.yaml", { exit_code: 1 });

    expect(final.status).toBe("failed");
    const step = final.steps.work!;
    expect(step.status).toBe("failed");
    expect(step.attempts_used).toBe(3);
    expect(step.attempts.map((attempt) => attempt.exit_code)).toEqual([1, 1, 1]);
    expect(step.attempts.map((attempt) => attempt.failure?.code)).toEqual([
      "exit_nonzero",
      "exit_nonzero",
      "exit_nonzero",
    ]);
    expect(step.failure!.code).toBe("exit_nonzero");
  }, 30_000);

  test("exit 78 is fatal: one attempt of a budget of three, and no wait", async () => {
    // Row 5 of 2.8. This is the run in the verification report where a 404 URL spent one attempt of
    // three and took the whole rest of the pipeline down with it.
    const { final } = await driveToDone("retry-budget.yaml", { exit_code: 78 });

    expect(final.status).toBe("failed");
    const step = final.steps.work!;
    expect(step.status).toBe("failed");
    expect(step.failure).toEqual({ code: "block_fatal", message: "block_fatal" });
    expect(step.attempts_used).toBe(1);
    expect(step.attempts).toHaveLength(1);
    expect(step.next_attempt_at).toBeNull();
  }, 30_000);

  test("with the default budget of one, exit 75 fails the step without a second attempt", async () => {
    // 2.8: "Exit 75 with max_attempts: 1 fails the step with retry_requested".
    const { final } = await driveToDone("retry-once.yaml");

    expect(final.status).toBe("failed");
    const step = final.steps.work!;
    expect(step.attempts_used).toBe(1);
    expect(step.attempts).toHaveLength(1);
    expect(step.failure!.code).toBe("retry_requested");
  }, 30_000);

  test("a step that succeeds on a later attempt stops retrying there", async () => {
    const { store, id, final } = await driveToDone("retry-succeeds.yaml");

    expect(final.status).toBe("succeeded");
    const step = final.steps.work!;
    expect(statuses(final)).toEqual(["succeeded"]);
    expect(step.status).toBe("succeeded");
    expect(step.attempts.map((attempt) => attempt.status)).toEqual(["failed", "succeeded"]);
    // The success costs an attempt too, and it is the second one: the budget was not spent.
    expect(step.attempts_used).toBe(2);
    expect(step.failure).toBeNull();
    expect(step.next_attempt_at).toBeNull();
    expect(step.outputs).toEqual({ result: "done" });
    // The retry ran in the same work directory, which is the whole point of 4.1.
    expect(text((await store.readFile(id, "steps/work/attempts/2/log"))!)).toContain("second attempt: finished");
  }, 30_000);

  test("a retry that is waiting is waiting_retry with a due time, and it holds no slot", async () => {
    // retry-waiting.yaml: max_parallel 1, one step that has to wait 2s before its second attempt
    // and one that could use the slot while it waits.
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(fixture("retry-waiting.yaml"));
    const id = record.id;
    const driving = engine.drive(id);

    await waitFor(async () => {
      const run = await store.loadRun(id);
      const step = run?.steps.retrying;
      return (
        step?.status === "waiting_retry" &&
        step.next_attempt_at !== null &&
        Date.parse(step.next_attempt_at) > Date.now() &&
        run?.steps.other?.status === "succeeded"
      );
    });

    const held = (await store.loadRun(id))!;
    const retrying = held.steps.retrying!;
    const first = retrying.attempts[0]!;
    expect(first.status).toBe("failed");
    expect(first.failure!.code).toBe("retry_requested");
    expect(retrying.attempts_used).toBe(1);
    // The wait is the pipeline's delay counted from the attempt that failed (3.5), and it is still
    // ahead of us: the step is genuinely waiting, not running and not pending.
    expect(Date.parse(retrying.next_attempt_at!)).toBeGreaterThanOrEqual(Date.parse(first.finished_at!) + 2000);
    // A waiting step takes no slot (4.4), so the other step started and finished inside the wait.
    expect(held.steps.other!.status).toBe("succeeded");

    const final = await driving;
    expect(final.steps.retrying!.status).toBe("failed");
    expect(final.steps.retrying!.attempts.map((attempt) => attempt.n)).toEqual([1, 2]);
    expect(final.steps.retrying!.next_attempt_at).toBeNull();
    expect(final.status).toBe("failed");
  }, 30_000);
});
