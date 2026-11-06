import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { HELLO_BLOCK, pipelineYaml, startApi } from "./helpers.ts";

const server = startApi();
afterAll(() => server.cleanup());

const body = async (response: Response) => (await response.json()) as Record<string, any>;

/** What `<dataDir>/stage` holds: every refused request must leave it exactly this empty. */
const staged = () => readdirSync(join(server.root, "stage"));

const HELLO_PIPELINE = pipelineYaml("hello-pipeline", "  greet:\n    uses: hello@1\n");

// Documents that parse as one YAML document but are not a mapping, which is what an agent sends when
// it posts a shell variable, a JSON scalar, or a list where a pipeline was expected.
const NOT_A_MAPPING = ["null", "5", "true", "just a word", "[]", "- a\n- b"];

// Storing the same bytes twice is the same version, so a test can make its own run without ordering.
async function helloRun(): Promise<string> {
  expect((await server.call("POST", "/v1/blocks/hello/versions", { body: { content: HELLO_BLOCK.content } })).status).toBe(201);
  expect((await server.call("POST", "/v1/pipelines/hello-pipeline/versions", { body: { yaml: HELLO_PIPELINE } })).status).toBe(201);
  const run = await body(await server.call("POST", "/v1/runs", { body: { pipeline: "hello-pipeline" } }));
  expect((await server.waitForRun(run.id)).status).toBe("succeeded");
  return run.id;
}

describe("a document that is not a mapping", () => {
  test("validate reports pipeline_schema_invalid for every one of them, instead of crashing", async () => {
    for (const yaml of NOT_A_MAPPING) {
      const response = await server.call("POST", "/v1/pipelines/validate", { body: { yaml } });
      expect(response.status).toBe(200);
      const report = await body(response);
      expect(report.valid).toBe(false);
      expect(report.issues.map((issue: { code: string }) => issue.code)).toContain("pipeline_schema_invalid");
      expect(JSON.stringify(report)).not.toInclude("internal_error");
    }
  });

  test("starting a run with one is 422 with its first issue, the same as any invalid pipeline", async () => {
    for (const yaml of NOT_A_MAPPING) {
      const response = await server.call("POST", "/v1/runs", { body: { yaml } });
      expect(response.status).toBe(422);
      const failure = await body(response);
      expect(failure.code).toBe("pipeline_schema_invalid");
      expect(Object.keys(failure).toSorted()).toEqual(["code", "message", "path"]);
    }
  });

  test("five refused requests leave nothing in the staging directory", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await server.call("POST", "/v1/pipelines/validate", { body: { yaml: "null" } })).status).toBe(200);
      expect((await server.call("POST", "/v1/runs", { body: { yaml: "5" } })).status).toBe(422);
      expect((await server.call("POST", "/v1/pipelines/litter/versions", { body: { yaml: "5" } })).status).toBe(422);
      expect(staged()).toEqual([]);
    }
  });

  test("a pipeline that does stage is cleaned up too, so the directory stays empty either way", async () => {
    expect(await helloRun()).toMatch(/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/);
    expect(staged()).toEqual([]);
  });
});

describe("a step id that names the prototype chain", () => {
  test("an inherited property is not a step of the run, so it is 404 step_not_found", async () => {
    const id = await helloRun();

    for (const step of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      const response = await server.call("GET", `/v1/runs/${id}/logs/${step}/1`);
      expect(response.status).toBe(404);
      const failure = await body(response);
      expect(failure.code).toBe("step_not_found");
      expect(failure.path).toBe(`steps.${step}`);
      expect(JSON.stringify(failure)).not.toInclude("internal_error");
    }

    // The step that is really there still answers, so this is a guard and not a block.
    const log = await body(await server.call("GET", `/v1/runs/${id}/logs/greet/1`));
    expect(log.text).toInclude("hello world");
  });
});
