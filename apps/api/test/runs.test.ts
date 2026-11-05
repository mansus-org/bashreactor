import { afterAll, describe, expect, test } from "bun:test";
import { FAILING_BLOCK, HELLO_BLOCK, SLOW_BLOCK, pipelineYaml, startApi } from "./helpers.ts";

const server = startApi();
afterAll(() => server.cleanup());

const body = async (response: Response) => (await response.json()) as Record<string, any>;

const HELLO_PIPELINE = pipelineYaml("hello-pipeline", "  greet:\n    uses: hello@1\n");
const SLOW_PIPELINE = pipelineYaml("slow-pipeline", "  sleep:\n    uses: slow@1\n    with:\n      seconds: 30\n");
const FAILING_PIPELINE = pipelineYaml("failing-pipeline", "  boom:\n    uses: failing@1\n");
const INPUT_PIPELINE = pipelineYaml(
  "input-pipeline",
  `  greet:
    uses: hello@1
    with:
      name: \${{ inputs.who }}`,
  "inputs:\n  who:\n    type: string\n",
);

async function start(pipeline: string): Promise<{ id: string; status: string }> {
  const response = await server.call("POST", "/v1/runs", { body: { pipeline } });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; status: string };
}

describe("starting a run", () => {
  test("the blocks and pipelines are there before anything runs", async () => {
    for (const block of [HELLO_BLOCK, SLOW_BLOCK, FAILING_BLOCK]) {
      expect((await server.call("POST", `/v1/blocks/${block.name}/versions`, { body: { content: block.content } })).status).toBe(201);
    }
    for (const [name, yaml] of [
      ["hello-pipeline", HELLO_PIPELINE],
      ["slow-pipeline", SLOW_PIPELINE],
      ["failing-pipeline", FAILING_PIPELINE],
      ["input-pipeline", INPUT_PIPELINE],
    ] as const) {
      const created = await server.call("POST", `/v1/pipelines/${name}/versions`, { body: { yaml } });
      expect(created.status).toBe(201);
    }
  });

  test("a run is accepted with its steps pending, and finishes on its own", async () => {
    const run = await start("hello-pipeline");
    expect(run.status).toBe("running");
    expect(run.id).toMatch(/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/);
    expect((run as any).steps.greet.status).toBe("pending");

    const done = await server.waitForRun(run.id);
    expect(done.status).toBe("succeeded");
    expect(done.steps.greet.outputs).toEqual({ greeting: "hello world", bytes: 11 });
    expect(done.steps.greet.attempts_used).toBe(1);
  });

  test("a run can be started from YAML that was never stored", async () => {
    const response = await server.call("POST", "/v1/runs", { body: { yaml: HELLO_PIPELINE, inputs: {} } });
    expect(response.status).toBe(201);
    expect((await server.waitForRun(((await response.json()) as { id: string }).id)).status).toBe("succeeded");
  });

  test("a run's inputs are the engine's to check, and its errors are the spec's", async () => {
    const missing = await server.call("POST", "/v1/runs", { body: { pipeline: "input-pipeline" } });
    expect(missing.status).toBe(422);
    expect(await body(missing)).toMatchObject({ code: "missing_input", path: "inputs.who" });

    const unknown = await server.call("POST", "/v1/runs", { body: { pipeline: "input-pipeline", inputs: { who: "a", nope: 1 } } });
    expect(unknown.status).toBe(422);
    expect(await body(unknown)).toMatchObject({ code: "unknown_input", path: "inputs.nope" });

    const wrong = await server.call("POST", "/v1/runs", { body: { pipeline: "input-pipeline", inputs: { who: 7 } } });
    expect(wrong.status).toBe(422);
    expect(await body(wrong)).toMatchObject({ code: "type_mismatch", path: "inputs.who" });

    const good = await server.call("POST", "/v1/runs", { body: { pipeline: "input-pipeline", inputs: { who: "bashreactor" } } });
    expect(good.status).toBe(201);
    const done = await server.waitForRun(((await good.json()) as { id: string }).id);
    expect(done.steps.greet.outputs).toEqual({ greeting: "hello bashreactor", bytes: 17 });
  });

  test("a version can be asked for by number, and a version that is not there is 404", async () => {
    const byNumber = await server.call("POST", "/v1/runs", { body: { pipeline: "hello-pipeline", version: 1 } });
    expect(byNumber.status).toBe(201);
    await server.waitForRun(((await byNumber.json()) as { id: string }).id);

    const missing = await server.call("POST", "/v1/runs", { body: { pipeline: "hello-pipeline", version: 9 } });
    expect(missing.status).toBe(404);
    expect(await body(missing)).toMatchObject({ code: "pipeline_not_found" });

    expect((await server.call("POST", "/v1/runs", { body: { pipeline: "nope" } })).status).toBe(404);
    expect((await server.call("POST", "/v1/runs", { body: {} })).status).toBe(422);
    expect((await server.call("POST", "/v1/runs", { body: { pipeline: "hello-pipeline", yaml: "x" } })).status).toBe(422);
  });
});

describe("reading runs", () => {
  test("the list is newest first and carries what a client needs to pick one", async () => {
    const runs = await body(await server.call("GET", "/v1/runs"));
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.length).toBeGreaterThan(2);
    const ids = runs.map((run: { id: string }) => run.id);
    expect(ids).toEqual(ids.toSorted().toReversed());
    expect(Object.keys(runs[0]).toSorted()).toEqual([
      "cancel_requested_at",
      "created_at",
      "finished_at",
      "id",
      "pipeline",
      "status",
    ]);
  });

  test("one run is the whole run.json", async () => {
    const run = await start("hello-pipeline");
    const done = await server.waitForRun(run.id);
    expect(done.schema).toBe(1);
    expect(done.id).toBe(run.id);
    expect(done.pipeline).toBe("hello-pipeline");
    expect(done.cancel_requested_at).toBeNull();
    expect(Object.keys(done.steps)).toEqual(["greet"]);
    expect(done.steps.greet.block.name).toBe("hello");
  });

  test("a run that does not exist is 404", async () => {
    expect((await server.call("GET", "/v1/runs/20260101T000000Z-00000000")).status).toBe(404);
  });
});

describe("following a log by offset", () => {
  test("the first read gives the whole log and the offset to come back with", async () => {
    const run = await start("hello-pipeline");
    await server.waitForRun(run.id);

    const first = await body(await server.call("GET", `/v1/runs/${run.id}/logs/greet/1?offset=0`));
    expect(first.text).toInclude("attempt 1 of run");
    expect(first.offset).toBe(0);
    expect(first.next_offset).toBe(first.text.length);
    expect(first.truncated).toBe(false);

    const second = await body(await server.call("GET", `/v1/runs/${run.id}/logs/greet/1?offset=${first.next_offset}`));
    expect(second.text).toBe("");
    expect(second.next_offset).toBe(first.next_offset);
  });

  test("an offset in the middle resumes in the middle", async () => {
    const run = await start("hello-pipeline");
    await server.waitForRun(run.id);
    const all = await body(await server.call("GET", `/v1/runs/${run.id}/logs/greet/1`));
    const tail = await body(await server.call("GET", `/v1/runs/${run.id}/logs/greet/1?offset=8`));
    expect(tail.text).toBe(all.text.slice(8));
    expect(tail.offset).toBe(8);
  });

  test("a step, an attempt or a run that is not there is 404", async () => {
    const run = await start("hello-pipeline");
    await server.waitForRun(run.id);
    expect((await server.call("GET", `/v1/runs/${run.id}/logs/nope/1`)).status).toBe(404);
    expect((await server.call("GET", `/v1/runs/${run.id}/logs/greet/9`)).status).toBe(404);
    expect((await server.call("GET", `/v1/runs/nope/logs/greet/1`)).status).toBe(404);
    expect((await server.call("GET", `/v1/runs/${run.id}/logs/greet/0`)).status).toBe(422);
    expect((await server.call("GET", `/v1/runs/${run.id}/logs/greet/1?offset=-3`)).status).toBe(422);
  });
});

describe("cancel, retry and resume", () => {
  test("a cancel reaches a running run and stops it", async () => {
    const run = await start("slow-pipeline");
    const response = await server.call("POST", `/v1/runs/${run.id}/cancel`);
    expect(response.status).toBe(202);

    const done = await server.waitForRun(run.id);
    expect(done.status).toBe("cancelled");
    expect(done.steps.sleep.status).toBe("cancelled");
  });

  test("cancelling a run that is not running is 409", async () => {
    const run = await start("hello-pipeline");
    await server.waitForRun(run.id);
    expect((await server.call("POST", `/v1/runs/${run.id}/cancel`)).status).toBe(409);
  });

  test("a run another engine holds cannot be resumed", async () => {
    const run = await start("slow-pipeline");
    // The API is driving this run itself, so its claim is live and a resume must be refused.
    const response = await server.call("POST", `/v1/runs/${run.id}/resume`);
    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({ code: "run_claimed" });
    await server.call("POST", `/v1/runs/${run.id}/cancel`);
    await server.waitForRun(run.id);
  });

  test("resuming a run that already finished is 409 run_not_active", async () => {
    const run = await start("hello-pipeline");
    await server.waitForRun(run.id);
    const response = await server.call("POST", `/v1/runs/${run.id}/resume`);
    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({ code: "run_not_active" });
  });

  test("a failed run is retried, and the old attempts stay", async () => {
    const run = await start("failing-pipeline");
    const failed = await server.waitForRun(run.id);
    expect(failed.status).toBe("failed");
    expect(failed.steps.boom.attempts.length).toBe(1);

    const response = await server.call("POST", `/v1/runs/${run.id}/retry`);
    expect(response.status).toBe(200);
    const retried = (await response.json()) as Record<string, any>;
    expect(retried.status).toBe("failed");
    expect(retried.steps.boom.attempts.length).toBe(2);
    expect(retried.steps.boom.attempts[1].n).toBe(2);
  });

  test("retrying a run that succeeded is 409", async () => {
    const run = await start("hello-pipeline");
    await server.waitForRun(run.id);
    const response = await server.call("POST", `/v1/runs/${run.id}/retry`);
    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({ code: "run_not_retryable" });
  });

  test("an operation that outlives the grace period is 202 and keeps going", async () => {
    const slowApi = startApi({ settleMs: 0 });
    try {
      for (const block of [SLOW_BLOCK]) {
        expect((await slowApi.call("POST", `/v1/blocks/${block.name}/versions`, { body: { content: block.content } })).status).toBe(201);
      }
      expect((await slowApi.call("POST", "/v1/pipelines/slow-pipeline/versions", { body: { yaml: SLOW_PIPELINE } })).status).toBe(201);
      const started = await slowApi.call("POST", "/v1/runs", { body: { pipeline: "slow-pipeline" } });
      const id = ((await started.json()) as { id: string }).id;
      await slowApi.call("POST", `/v1/runs/${id}/cancel`);
      await slowApi.waitForRun(id);

      const accepted = await slowApi.call("POST", `/v1/runs/${id}/retry`);
      expect(accepted.status).toBe(202);
      const record = (await accepted.json()) as Record<string, any>;
      expect(record.id).toBe(id);
      // It is still running: the retry restarted the sleep, and the answer came before it ended.
      expect(((await (await slowApi.call("GET", `/v1/runs/${id}`)).json()) as Record<string, any>).status).toBe("running");
      await slowApi.call("POST", `/v1/runs/${id}/cancel`);
      expect((await slowApi.waitForRun(id)).status).toBe("cancelled");
    } finally {
      slowApi.cleanup();
    }
  });
});
