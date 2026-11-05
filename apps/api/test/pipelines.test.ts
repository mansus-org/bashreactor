import { afterAll, describe, expect, test } from "bun:test";
import { HELLO_BLOCK, HELLO_PIPELINE, pipelineYaml, startApi } from "./helpers.ts";

const server = startApi();
afterAll(() => server.cleanup());

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

const TWO_STEPS = pipelineYaml(
  "test-pipeline",
  `  one:
    uses: hello@1
  two:
    uses: hello@1
    with:
      name: \${{ steps.one.outputs.greeting }}`,
);

describe("pipeline versions", () => {
  test("a pipeline can only be stored once its blocks exist", async () => {
    const early = await server.call("POST", "/v1/pipelines/test-pipeline/versions", {
      body: { yaml: HELLO_PIPELINE },
    });
    expect(early.status).toBe(422);
    expect(await body(early)).toMatchObject({ code: "block_not_found", path: "steps.greet.uses" });

    expect((await server.call("POST", "/v1/blocks/hello/versions", { body: { content: HELLO_BLOCK.content } })).status).toBe(201);
  });

  test("creating a version keeps the YAML exactly as written", async () => {
    const created = await server.call("POST", "/v1/pipelines/test-pipeline/versions", { body: { yaml: HELLO_PIPELINE } });
    expect(created.status).toBe(201);
    const record = await body(created);
    expect(record.name).toBe("test-pipeline");
    expect(record.version).toBe(1);
    expect(record.yaml).toBe(HELLO_PIPELINE);
    expect((record.parsed as Record<string, unknown>).name).toBe("test-pipeline");
  });

  test("the same YAML is the same version, and a change is the next one", async () => {
    expect(((await body(await server.call("POST", "/v1/pipelines/test-pipeline/versions", { body: { yaml: HELLO_PIPELINE } }))).version as number)).toBe(1);

    const next = await server.call("POST", "/v1/pipelines/test-pipeline/versions", { body: { yaml: TWO_STEPS } });
    expect(((await body(next)).version as number)).toBe(2);

    const listed = await body(await server.call("GET", "/v1/pipelines/test-pipeline"));
    expect(listed.latest).toBe(2);
    expect((listed.versions as Record<string, unknown>[]).map((entry) => entry.version)).toEqual([1, 2]);
    // The list is for picking a version, not for reading the whole library.
    expect(JSON.stringify(listed.versions)).not.toInclude("uses:");
  });

  test("one version is readable by number and by latest, with its YAML and its parsed form", async () => {
    const one = await body(await server.call("GET", "/v1/pipelines/test-pipeline/1"));
    expect(one.yaml).toBe(HELLO_PIPELINE);
    const latest = await body(await server.call("GET", "/v1/pipelines/test-pipeline/latest"));
    expect(latest.version).toBe(2);
    expect(latest.yaml).toBe(TWO_STEPS);
  });

  test("a pipeline or version that is not there is 404", async () => {
    expect((await server.call("GET", "/v1/pipelines/nope")).status).toBe(404);
    expect((await server.call("GET", "/v1/pipelines/nope/latest")).status).toBe(404);
    expect((await server.call("GET", "/v1/pipelines/test-pipeline/9")).status).toBe(404);
  });

  test("a file that declares another name is not filed under this one", async () => {
    const response = await server.call("POST", "/v1/pipelines/wrong-name/versions", { body: { yaml: HELLO_PIPELINE } });
    expect(response.status).toBe(422);
    expect(await body(response)).toMatchObject({ code: "pipeline_schema_invalid", path: "name" });
  });
});

describe("validation", () => {
  test("a valid pipeline validates with no issues, and creates nothing", async () => {
    const response = await server.call("POST", "/v1/pipelines/validate", { body: { yaml: HELLO_PIPELINE } });
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ valid: true, issues: [] });
    expect((await server.call("GET", "/v1/pipelines/validated-already")).status).toBe(404);
  });

  test("validation reports every rule broken, not only the first", async () => {
    const yaml = `name: broken\nsteps:\n  one:\n    uses: hello@1\n    with:\n      nope: 3\n  two:\n    uses: nowhere@1\n  three:\n    uses: hello@1\n    needs: [nope]\n`;
    const response = await server.call("POST", "/v1/pipelines/validate", { body: { yaml } });
    expect(response.status).toBe(200);
    const report = (await response.json()) as { valid: boolean; issues: { code: string; path?: string }[] };
    expect(report.valid).toBe(false);
    const codes = report.issues.map((issue) => issue.code).toSorted();
    expect(codes).toContain("unknown_input");
    expect(codes).toContain("block_not_found");
    expect(codes).toContain("unknown_step");
    expect(report.issues.length).toBeGreaterThan(2);
  });

  test("a broken pipeline is 422 with the first issue, and is not stored", async () => {
    const response = await server.call("POST", "/v1/pipelines/broken/versions", {
      body: { yaml: "name: broken\nsteps:\n  one:\n    uses: hello@1\n    with:\n      name: [unclosed\n" },
    });
    expect(response.status).toBe(422);
    expect((await body(response)).code).toBe("pipeline_yaml_invalid");
    expect((await server.call("GET", "/v1/pipelines/broken")).status).toBe(404);
  });

  test("a body without yaml is 422 with a path", async () => {
    const response = await server.call("POST", "/v1/pipelines/validate", { body: {} });
    expect(response.status).toBe(422);
    expect(await body(response)).toMatchObject({ code: "missing_input", path: "yaml" });
  });
});
