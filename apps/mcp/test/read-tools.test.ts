import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Session, TestEnv } from "./helpers.ts";
import { HELLO_BLOCK, helloPipeline, seed, startEnv } from "./helpers.ts";

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

describe("whoami", () => {
  test("says who the token is", async () => {
    const { json, isError } = await session.call("whoami");
    expect(isError).toBe(false);
    expect(json).toEqual({ name: "writer", scope: "write", admin: false });
  });
});

describe("the block library", () => {
  test("lists a block's versions", async () => {
    const { json, isError } = await session.call("list_block_versions", { name: "hello" });
    expect(isError).toBe(false);
    expect(json.name).toBe("hello");
    expect(json.latest).toBe(1);
    expect(json.versions).toHaveLength(1);
    expect(json.versions[0].version).toBe(1);
    expect(String(json.versions[0].sha256)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("reads one version's metadata, by number and as latest", async () => {
    expect((await session.call("get_block_version", { name: "hello", version: "1" })).json.version).toBe(1);
    expect((await session.call("get_block_version", { name: "hello" })).json.version).toBe(1);
    expect((await session.call("get_block_version", { name: "hello", version: "latest" })).json.version).toBe(1);
  });

  test("reads a block's source, which is where its contract is", async () => {
    const { json, isError } = await session.call("get_block_content", { name: "hello" });
    expect(isError).toBe(false);
    expect(json.content).toBe(HELLO_BLOCK);
    expect(json.content).toContain("inputs:");
    expect(json.content).toContain("outputs:");
    expect(json.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("pipeline versions", () => {
  test("lists them and reads one back exactly", async () => {
    const listed = await session.call("list_pipeline_versions", { name: "hello-pipeline" });
    expect(listed.json.latest).toBe(1);

    const one = await session.call("get_pipeline_version", { name: "hello-pipeline", version: "1" });
    expect(one.isError).toBe(false);
    expect(one.json.yaml).toBe(helloPipeline());
    expect(one.json.parsed.name).toBe("hello-pipeline");
  });
});

describe("validate_pipeline", () => {
  test("says a good document is good", async () => {
    const { json, isError } = await session.call("validate_pipeline", { yaml: helloPipeline("other") });
    expect(isError).toBe(false);
    expect(json).toEqual({ valid: true, issues: [] });
  });

  test("reports every issue of a bad one as a result, not as a failure", async () => {
    const yaml = `name: broken\nsteps:\n  a:\n    uses: nosuch@1\n  b:\n    uses: hello@1\n    with:\n      nope: 3\n`;
    const { json, isError } = await session.call("validate_pipeline", { yaml });
    expect(isError).toBe(false);
    expect(json.valid).toBe(false);
    expect(json.issues.length).toBeGreaterThan(1);
    const codes = json.issues.map((issue: { code: string }) => issue.code);
    expect(codes).toContain("block_not_found");
    expect(codes).toContain("unknown_input");
    for (const issue of json.issues) {
      expect(typeof issue.message).toBe("string");
    }
  });
});

describe("runs", () => {
  let id: string;

  test("start_run answers before the run is done, and get_run follows it", async () => {
    const started = await session.call("start_run", { pipeline: "hello-pipeline" });
    expect(started.isError).toBe(false);
    // 201, the API's own answer: created, and nothing has run yet.
    expect(started.json.status).toBe(201);
    expect(started.json.run.status).toBe("running");
    expect(started.json.run.steps.greet.status).toBe("pending");
    id = started.json.run.id;

    const deadline = Date.now() + 30_000;
    for (;;) {
      const record = await session.call("get_run", { id });
      expect(record.isError).toBe(false);
      if (record.json.status !== "running" || Date.now() > deadline) break;
      await Bun.sleep(50);
    }

    const run = (await session.call("get_run", { id })).json;
    expect(run.status).toBe("succeeded");
    expect(run.steps.greet.status).toBe("succeeded");
    expect(run.steps.greet.outputs.greeting).toBe("hello world");
    expect(run.steps.greet.attempts).toHaveLength(1);
    // The pipeline declares no top-level outputs, so the mapping is empty, not missing.
    expect(run.outputs).toEqual({});
  });

  test("list_runs shows it, newest first", async () => {
    const { json, isError } = await session.call("list_runs");
    expect(isError).toBe(false);
    expect(json.map((run: { id: string }) => run.id)).toContain(id);
    expect(json[0].id).toBe(id);
    expect(Object.keys(json[0]).toSorted()).toEqual([
      "cancel_requested_at",
      "created_at",
      "finished_at",
      "id",
      "pipeline",
      "status",
    ]);
  });

  test("a log is read by offset, and the offset comes back", async () => {
    const first = await session.call("get_run_log", { id, step: "greet", attempt: 1, offset: 0 });
    expect(first.isError).toBe(false);
    expect(first.json.text).toContain("hello world");
    expect(first.json.offset).toBe(0);
    expect(first.json.next_offset).toBe(new TextEncoder().encode(first.json.text).length);
    expect(first.json.truncated).toBe(false);

    // The cursor a client keeps: come back with what you were given and get only what is new.
    const second = await session.call("get_run_log", { id, step: "greet", attempt: 1, offset: first.json.next_offset });
    expect(second.json.text).toBe("");
    expect(second.json.next_offset).toBe(first.json.next_offset);

    // Offset is optional and means the start.
    expect((await session.call("get_run_log", { id, step: "greet", attempt: 1 })).json.offset).toBe(0);
  });
});
