// A run remembers which stored pipeline version it started from (SPEC 4.9), through every route
// that hands a run back. An old record without the field is still a run, not an error.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { FAILING_BLOCK, HELLO_BLOCK, pipelineYaml, startApi } from "./helpers.ts";

const server = startApi();
afterAll(() => server.cleanup());

const body = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const V1 = pipelineYaml("version-pipeline", "  greet:\n    uses: hello@1\n");
const V2 = pipelineYaml("version-pipeline", "  greet:\n    uses: hello@1\n    with:\n      name: second\n");
const INLINE = pipelineYaml("inline-pipeline", "  greet:\n    uses: hello@1\n");
const FAIL = pipelineYaml("failing-version", "  boom:\n    uses: failing@1\n");

async function startRun(createBody: unknown): Promise<Record<string, any>> {
  const response = await server.call("POST", "/v1/runs", { body: createBody });
  expect(response.status).toBe(201);
  const run = (await response.json()) as Record<string, any>;
  return await server.waitForRun(run.id);
}

describe("the pipeline version a run records", () => {
  test("the library and the pipelines are in place", async () => {
    expect((await server.call("POST", "/v1/blocks/hello/versions", { body: { content: HELLO_BLOCK.content } })).status).toBe(201);
    expect((await server.call("POST", "/v1/pipelines/version-pipeline/versions", { body: { yaml: V1 } })).status).toBe(201);
    expect((await server.call("POST", "/v1/pipelines/version-pipeline/versions", { body: { yaml: V2 } })).status).toBe(201);
    expect((await server.call("POST", "/v1/blocks/failing/versions", { body: { content: FAILING_BLOCK.content } })).status).toBe(201);
    expect((await server.call("POST", "/v1/pipelines/failing-version/versions", { body: { yaml: FAIL } })).status).toBe(201);
  });

  test("an explicit stored version is recorded, and GET returns the whole record with it", async () => {
    const run = await startRun({ pipeline: "version-pipeline", version: 1 });
    expect(run.pipeline_version).toBe(1);

    const read = await body<Record<string, any>>(await server.call("GET", `/v1/runs/${run.id}`));
    expect(read.pipeline_version).toBe(1);
    expect(read.pipeline).toBe("version-pipeline");
  });

  test("an omitted version and the word latest both record the stored latest", async () => {
    expect((await startRun({ pipeline: "version-pipeline" })).pipeline_version).toBe(2);
    expect((await startRun({ pipeline: "version-pipeline", version: "latest" })).pipeline_version).toBe(2);
  });

  test("retry keeps the version the record already holds", async () => {
    const failed = await startRun({ pipeline: "failing-version", version: 1 });
    expect(failed.status).toBe("failed");
    expect(failed.pipeline_version).toBe(1);

    const retried = (await (await server.call("POST", `/v1/runs/${failed.id}/retry`)).json()) as Record<string, any>;
    expect(retried.status).toBe("failed");
    expect(retried.pipeline_version).toBe(1);
  });

  test("a run started from inline YAML records null", async () => {
    const run = await startRun({ yaml: INLINE });
    expect(run.pipeline_version).toBeNull();
  });

  test("an old run.json without the field reads as null, in the run and in the list", async () => {
    const id = "20260101T000000Z-00000000";
    const dir = join(server.root, "runs", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "run.json"),
      JSON.stringify({
        schema: 1,
        id,
        pipeline: "old-pipeline",
        status: "succeeded",
        created_at: "2026-01-01T00:00:00.000Z",
        finished_at: "2026-01-01T00:00:01.000Z",
        cancel_requested_at: null,
        inputs: {},
        outputs: {},
        steps: {},
      }),
    );

    const read = await body<Record<string, any>>(await server.call("GET", `/v1/runs/${id}`));
    expect(read.pipeline_version).toBeNull();

    const listed = await body<Record<string, any>[]>(await server.call("GET", "/v1/runs?pipeline=old-pipeline"));
    expect(listed).toHaveLength(1);
    expect(listed[0]!.pipeline_version).toBeNull();
  });

  test("a version that is neither a number nor latest is the caller's mistake", async () => {
    const response = await server.call("POST", "/v1/runs", { body: { pipeline: "version-pipeline", version: "first" } });
    expect(response.status).toBe(422);
    expect(await body<Record<string, unknown>>(response)).toMatchObject({ code: "type_mismatch", path: "version" });
  });
});
