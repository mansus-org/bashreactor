import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../src/engine.ts";
import { readProcStartTime } from "../src/proc.ts";
import { FsRunStore } from "../src/run-store.ts";
import type { RunRecord } from "../src/run.ts";

const fixtures = new URL("./fixtures/", import.meta.url);
const fixture = (name: string) => fileURLToPath(new URL(name, fixtures));

const roots: string[] = [];
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bashreactor-shutdown-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error("waitFor timed out");
}

/** Starts a run and drives it in the background until its first step has a live process. */
async function startRunning(engine: Engine, store: FsRunStore, pipeline: string, stepId: string) {
  const record = await engine.start(fixture(pipeline));
  const driving = engine.drive(record.id);
  await waitFor(async () => {
    const current = await store.loadRun(record.id);
    return current?.steps[stepId]?.attempts[0]?.pid != null;
  });
  const running = (await store.loadRun(record.id))!;
  return { id: record.id, driving, pid: running.steps[stepId]!.attempts[0]!.pid! };
}

const alive = (pid: number) => readProcStartTime(pid) !== null;

describe("Engine.shutdown", () => {
  test("a block that traps TERM gets its kill_grace to save progress, and the run resumes from it", async () => {
    const root = newRoot();
    const store = new FsRunStore(root);
    const engine = new Engine({ store });
    const { id, driving, pid } = await startRunning(engine, store, "trap-term.yaml", "work");

    const started = Date.now();
    await engine.shutdown();
    // Stopping at once on TERM, not after the 5 s grace: the trap ended the block.
    expect(Date.now() - started).toBeLessThan(4_000);

    const record = (await driving) as RunRecord;
    expect(record.status).toBe("running");
    expect(existsSync(join(root, "runs", id, "steps/work/work/saved"))).toBe(true);
    expect(alive(pid)).toBe(false);
    expect(existsSync(store.layout(id).lock)).toBe(false);

    const stored = (await store.loadRun(id))!;
    const step = stored.steps.work!;
    expect(stored.status).toBe("running");
    expect(step.status).toBe("pending");
    expect(step.attempts).toHaveLength(1);
    expect(step.attempts[0]!.status).toBe("interrupted");
    expect(step.attempts[0]!.failure!.code).toBe("interrupted");
    // Neither a timeout, a signal death nor a retry: the budget is untouched.
    expect(step.attempts_used).toBe(0);
    expect(step.failure).toBeNull();

    const final = await new Engine({ store: new FsRunStore(root) }).resume(id);
    expect(final.status).toBe("succeeded");
    expect(final.steps.work!.attempts.map((a) => a.status)).toEqual(["interrupted", "succeeded"]);
    expect(final.steps.work!.outputs).toEqual({ done: "resumed" });
  }, 60_000);

  test("a block that ignores TERM is SIGKILLed after kill_grace, and the next step never starts", async () => {
    const root = newRoot();
    const store = new FsRunStore(root);
    const engine = new Engine({ store });
    const { id, driving, pid } = await startRunning(engine, store, "ignore-term.yaml", "stubborn");

    const started = Date.now();
    await engine.shutdown();
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(4_000);
    await driving;

    expect(alive(pid)).toBe(false);
    expect(existsSync(store.layout(id).lock)).toBe(false);
    const stored = (await store.loadRun(id))!;
    expect(stored.status).toBe("running");
    expect(stored.steps.stubborn!.status).toBe("pending");
    expect(stored.steps.stubborn!.attempts[0]!.status).toBe("interrupted");
    expect(stored.steps.after!.status).toBe("pending");
    expect(stored.steps.after!.attempts).toHaveLength(0);
  }, 30_000);

  test("a second call does not wait out the rest of the grace", async () => {
    const root = newRoot();
    const store = new FsRunStore(root);
    const engine = new Engine({ store });
    const { id, driving, pid } = await startRunning(engine, store, "ignore-term-long.yaml", "stubborn");
    const record = { id };

    // The fixture's grace is 30 s, so only the second call can explain a stop within a second.
    const first = engine.shutdown();
    await Bun.sleep(300);
    const started = Date.now();
    await engine.shutdown();
    await first;
    await driving;
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(alive(pid)).toBe(false);
    const stored = (await store.loadRun(record.id))!;
    expect(stored.steps.stubborn!.attempts[0]!.status).toBe("interrupted");
    expect(existsSync(store.layout(record.id).lock)).toBe(false);
  }, 30_000);

  test("a run driven after shutdown began starts nothing and stays running for the next engine", async () => {
    const root = newRoot();
    const store = new FsRunStore(root);
    const engine = new Engine({ store });
    const record = await engine.start(fixture("trap-term.yaml"));
    await engine.shutdown();

    const returned = await engine.drive(record.id);
    expect(returned.status).toBe("running");
    const stored = (await store.loadRun(record.id))!;
    expect(stored.steps.work!.status).toBe("pending");
    expect(stored.steps.work!.attempts).toHaveLength(0);
    expect(existsSync(store.layout(record.id).lock)).toBe(false);
  });

  test("a cancel already in its grace period stays a cancel", async () => {
    const root = newRoot();
    const store = new FsRunStore(root);
    const engine = new Engine({ store });
    const { id, driving, pid } = await startRunning(engine, store, "ignore-term.yaml", "stubborn");

    await engine.cancel(id);
    await waitFor(async () => (await store.loadRun(id))!.cancel_requested_at !== null);
    await engine.shutdown();
    const final = await driving;

    expect(alive(pid)).toBe(false);
    expect(final.steps.stubborn!.status).toBe("cancelled");
    expect(final.steps.stubborn!.attempts[0]!.status).toBe("cancelled");
    expect(final.status).toBe("cancelled");
    expect(existsSync(store.layout(id).lock)).toBe(false);
  }, 30_000);
});
