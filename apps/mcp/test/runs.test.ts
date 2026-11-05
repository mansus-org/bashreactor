import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Session, TestEnv } from "./helpers.ts";
import { seed, startEnv } from "./helpers.ts";

let env: TestEnv;
let session: Session;

beforeAll(async () => {
  env = await startEnv();
  session = await env.session(env.writer);
  await seed(env);
});

afterAll(async () => {
  await session.close();
  env.cleanup();
});

describe("a run that outlives the call", () => {
  let id: string;

  test("start_run comes back at once, with the work not yet done", async () => {
    const startedAt = Date.now();
    const started = await session.call("start_run", { pipeline: "sleep-pipeline" });
    const elapsed = Date.now() - startedAt;

    expect(started.isError).toBe(false);
    // The block sleeps for half a minute; the call is not allowed to wait for it.
    expect(elapsed).toBeLessThan(2000);
    expect(started.json.status).toBe(201);
    expect(started.json.run.status).toBe("running");
    expect(started.json.run.steps.nap.status).toBe("pending");
    expect(started.json.run.finished_at).toBeNull();
    id = started.json.run.id;
  });

  test("a log can be followed while it is still being written", async () => {
    for (;;) {
      const step = (await session.call("get_run", { id })).json.steps.nap.status;
      if (step === "running") break;
      await Bun.sleep(25);
    }

    const first = await session.call("get_run_log", { id, step: "nap", attempt: 1, offset: 0 });
    expect(first.json.text).toContain("starting to sleep");
    expect(first.json.next_offset).toBeGreaterThan(0);

    // Nothing new has been written, so nothing new comes back: the cursor is what makes polling cheap.
    const again = await session.call("get_run_log", { id, step: "nap", attempt: 1, offset: first.json.next_offset });
    expect(again.json.text).toBe("");
    expect(again.json.next_offset).toBe(first.json.next_offset);
  });

  test("a cancel answers before the run is final, and the run finishes on its own", async () => {
    const cancelled = await session.call("cancel_run", { id });
    expect(cancelled.json.status).toBe(202);
    expect(cancelled.json.run.status).toBe("running");

    const record = await env.waitForRun(id);
    expect(record.status).toBe("cancelled");
    expect(record.steps.nap.status).toBe("cancelled");
    expect(record.steps.nap.attempts[0].signal).toBe("SIGTERM");
  });
});

describe("an operation that outlives the API's grace", () => {
  let slow: TestEnv;
  let caller: Session;

  beforeAll(async () => {
    // The API gives a retry or a resume a moment to fail fast or finish, and answers 202 when it has
    // not. A millisecond is enough to make it not finish: the block below sleeps.
    slow = await startEnv({ settleMs: 1 });
    caller = await slow.session(slow.writer);
    await seed(slow);
  });

  afterAll(async () => {
    await caller.close();
    slow.cleanup();
  });

  test("retry says 202 and keeps going, and get_run is where the answer is", async () => {
    const started = await caller.call("start_run", { pipeline: "sleep-pipeline" });
    const id = started.json.run.id;
    for (;;) {
      const step = (await caller.call("get_run", { id })).json.steps.nap.status;
      if (step === "running") break;
      await Bun.sleep(25);
    }
    await caller.call("cancel_run", { id });
    await slow.waitForRun(id);

    const retried = await caller.call("retry_run", { id });
    expect(retried.isError).toBe(false);
    expect(retried.json.status).toBe(202);
    // The run is back in flight, and the client finds that out by polling rather than from this answer.
    for (;;) {
      if ((await caller.call("get_run", { id })).json.status === "running") break;
      await Bun.sleep(25);
    }
    await caller.call("cancel_run", { id });
    expect((await slow.waitForRun(id)).status).toBe("cancelled");
  });
});
