// `DELETE /v1/runs/:id` (SPEC 4.2, SPEC 4.11): the way an operator, or the server on a schedule, takes
// a run's directory back. Everything the engine refuses, the API has to pass on as an answer rather
// than a stack trace — and a run that is still being written into is exactly the one it must refuse.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FAILING_BLOCK, HELLO_BLOCK, SLOW_BLOCK, pipelineYaml, startApi } from "./helpers.ts";

const server = startApi();
afterAll(() => server.cleanup());

const body = async (response: Response) => (await response.json()) as Record<string, any>;

const HELLO_PIPELINE = pipelineYaml("delete-hello", "  greet:\n    uses: hello@1\n");
const SLOW_PIPELINE = pipelineYaml("delete-slow", "  sleep:\n    uses: slow@1\n    with:\n      seconds: 30\n");
const FAILING_PIPELINE = pipelineYaml("delete-failing", "  boom:\n    uses: failing@1\n");

async function start(pipeline: string): Promise<{ id: string; status: string }> {
  const response = await server.call("POST", "/v1/runs", { body: { pipeline } });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; status: string };
}
const runDir = (id: string) => join(server.root, "runs", id);

describe("DELETE /v1/runs/:id", () => {
  test("every block and pipeline this file needs is in the store", async () => {
    for (const block of [HELLO_BLOCK, SLOW_BLOCK, FAILING_BLOCK]) {
      expect((await server.call("POST", `/v1/blocks/${block.name}/versions`, { body: { content: block.content } })).status).toBe(201);
    }
    for (const [name, yaml] of [
      ["delete-hello", HELLO_PIPELINE],
      ["delete-slow", SLOW_PIPELINE],
      ["delete-failing", FAILING_PIPELINE],
    ] as const) {
      expect((await server.call("POST", `/v1/pipelines/${name}/versions`, { body: { yaml } })).status).toBe(201);
    }
  });

  test("a finished run answers with what went, and its directory is gone", async () => {
    const run = await start("delete-hello");
    await server.waitForRun(run.id);
    expect(existsSync(runDir(run.id))).toBe(true);

    const response = await server.call("DELETE", `/v1/runs/${run.id}`);
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ deleted: run.id });

    expect(existsSync(runDir(run.id))).toBe(false);
    expect((await server.call("GET", `/v1/runs/${run.id}`)).status).toBe(404);
    const runs = await body(await server.call("GET", "/v1/runs"));
    expect(runs.map((each: { id: string }) => each.id)).not.toInclude(run.id);
  });

  test("a run that failed is still a finished run: it is the one a full disk needs gone", async () => {
    const run = await start("delete-failing");
    const done = await server.waitForRun(run.id);
    expect(done.status).toBe("failed");

    expect((await server.call("DELETE", `/v1/runs/${run.id}`)).status).toBe(200);
    expect(existsSync(runDir(run.id))).toBe(false);
  });

  test("a run that is still running is refused with run_claimed, and goes once it is cancelled", async () => {
    const run = await start("delete-slow");
    const lock = join(runDir(run.id), "lock");
    // The claim is written when the step is spawned, so wait for the process to actually exist
    // rather than for the status the POST already promised.
    for (let waited = 0; !existsSync(lock) && waited < 10_000; waited += 50) {
      await Bun.sleep(50);
    }
    expect(existsSync(lock)).toBe(true);

    const refused = await server.call("DELETE", `/v1/runs/${run.id}`);
    expect(refused.status).toBe(409);
    const error = await body(refused);
    expect(error.code).toBe("run_claimed");
    expect(error.message).toContain("cancel");
    expect(existsSync(runDir(run.id))).toBe(true);

    expect((await server.call("POST", `/v1/runs/${run.id}/cancel`)).status).toBe(202);
    const cancelled = await server.waitForRun(run.id);
    expect(cancelled.status).toBe("cancelled");
    // The engine lets go of the claim in the same breath it writes the status; a client that polls
    // the status and deletes immediately can arrive between the two, and gets the same 409.
    for (let waited = 0; existsSync(lock) && waited < 5_000; waited += 50) {
      await Bun.sleep(50);
    }

    expect((await server.call("DELETE", `/v1/runs/${run.id}`)).status).toBe(200);
    expect(existsSync(runDir(run.id))).toBe(false);
  });

  test("an id that is not a run id is 404, and nothing outside runs/ is touched", async () => {
    const before = (await body(await server.call("GET", "/v1/runs"))).length;
    // A folded or encoded ".." never survives as one path segment, so it is a route that does not
    // exist; a well-formed id that was never a run is the engine's own answer. Both are 404.
    for (const id of ["..%2F..%2Fhome", "%2E%2E", "run;1", "0".repeat(25), "20260101T000000Z-ZZZZZZZZ"]) {
      expect((await server.call("DELETE", `/v1/runs/${id}`)).status).toBe(404);
    }
    expect((await body(await server.call("DELETE", "/v1/runs/20260101T000000Z-00000000"))).code).toBe("run_not_found");
    expect(existsSync(join(server.root, "runs"))).toBe(true);
    expect((await body(await server.call("GET", "/v1/runs"))).length).toBe(before);
  });

  test("deleting the same run twice is a 404 the second time", async () => {
    const run = await start("delete-hello");
    await server.waitForRun(run.id);
    expect((await server.call("DELETE", `/v1/runs/${run.id}`)).status).toBe(200);
    expect((await server.call("DELETE", `/v1/runs/${run.id}`)).status).toBe(404);
  });

  test("deleting is a write: read cannot, write can, and nobody at all cannot", async () => {
    const read = await server.agentToken("read");
    const write = await server.agentToken("write");

    const guarded = await start("delete-hello");
    await server.waitForRun(guarded.id);
    expect((await server.call("DELETE", `/v1/runs/${guarded.id}`, { token: read })).status).toBe(403);
    expect(existsSync(runDir(guarded.id))).toBe(true);

    expect((await server.call("DELETE", `/v1/runs/${guarded.id}`, { token: write })).status).toBe(200);

    const open = await start("delete-hello");
    await server.waitForRun(open.id);
    expect((await server.call("DELETE", `/v1/runs/${open.id}`, { token: null })).status).toBe(401);
  });
});
