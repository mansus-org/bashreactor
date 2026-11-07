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

describe("a log larger than one answer", () => {
  // Builtins only: the suite's PATH holds just the binaries SPEC 2.6 requires.
  const BIGLOG = `#!/usr/bin/env bash
# ---
# name: biglog
# description: Write a log of 3000005 bytes ending in END.
# ---

chunk=$(printf 'x%.0s' {1..1024})
for ((i = 0; i < 2929; i++)); do printf '%s' "$chunk"; done
printf '%s' "\${chunk:0:704}"
printf '\\nEND\\n'
`;

  test("get_run_log called on next_offset while truncated reaches the END line", async () => {
    await env.api("POST", "/v1/blocks/biglog/versions", { body: { content: BIGLOG } });
    await env.api("POST", "/v1/pipelines/big-pipeline/versions", {
      body: { yaml: "name: big-pipeline\nsteps:\n  big:\n    uses: biglog@1\n" },
    });
    const started = await session.call("start_run", { pipeline: "big-pipeline" });
    const id = started.json.run.id;
    await env.waitForRun(id);

    let offset = 0;
    let text = "";
    for (let reads = 0; reads < 10; reads++) {
      const chunk = (await session.call("get_run_log", { id, step: "big", attempt: 1, offset })).json;
      text += chunk.text;
      offset = chunk.next_offset;
      if (!chunk.truncated) break;
    }
    expect(text.length).toBe(3_000_005);
    expect(text.endsWith("\nEND\n")).toBe(true);
    expect(offset).toBe(3_000_005);
  }, 30_000);
});

describe("a run's files", () => {
  test("list_run_files gives the manifest, and the bytes are not its business", async () => {
    const started = await session.call("start_run", { pipeline: "hello-pipeline" });
    const id = started.json.run.id;
    await env.waitForRun(id);

    const listed = await session.call("list_run_files", { id });
    expect(listed.isError).toBe(false);
    expect(listed.json.run).toBe(id);
    expect(listed.json.partial).toBe(false);
    expect(listed.json.steps.greet.attempts[0].log.path).toBe("steps/greet/attempts/1/log");
    const outputs = listed.json.steps.greet.attempts[0].outputs.map((entry: any) => entry.path);
    expect(outputs.includes("steps/greet/attempts/1/outputs/greeting")).toBe(true);

    // Narrowing is the API's answer, not a second implementation here.
    expect(Object.keys((await session.call("list_run_files", { id, step: "greet", scope: "logs" })).json.steps)).toEqual([
      "greet",
    ]);
    expect((await session.call("list_run_files", { id, step: "nope" })).json.code).toBe("step_not_found");
  }, 30_000);
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

    // The step is "running" a moment before the script's first line reaches the file.
    let first = await session.call("get_run_log", { id, step: "nap", attempt: 1, offset: 0 });
    for (let tries = 0; first.json.text === "" && tries < 100; tries++) {
      await Bun.sleep(25);
      first = await session.call("get_run_log", { id, step: "nap", attempt: 1, offset: 0 });
    }
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
