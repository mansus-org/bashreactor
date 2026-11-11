import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Session, TestEnv } from "./helpers.ts";
import { seed, startEnv } from "./helpers.ts";

let env: TestEnv;
let session: Session;
let succeeded: string;
let failed: string;

beforeAll(async () => {
  env = await startEnv();
  session = await env.session(env.writer);
  await seed(env);
  succeeded = (
    await env.waitForRun((await session.call("start_run", { pipeline: "hello-pipeline" })).json.run.id)
  ).id;
  failed = (
    await env.waitForRun((await session.call("start_run", { pipeline: "fail-pipeline" })).json.run.id)
  ).id;
});

afterAll(async () => {
  await session.close();
  env.cleanup();
});

const idsOf = (result: { json: { id: string }[] }): string[] => result.json.map((run) => run.id);

describe("list_runs filters", () => {
  test("the tool offers them as optional arguments beside the run fields", async () => {
    const listed = await session.client.listTools();
    const tool = listed.tools.find((entry) => entry.name === "list_runs")!;
    const schema = tool.inputSchema as {
      required?: string[];
      properties: Record<string, { type: string; items?: { type: string } }>;
    };

    expect(schema.required).toBeUndefined();
    for (const key of ["pipeline", "status", "since", "limit"]) expect(schema.properties[key]).toBeDefined();
    expect(schema.properties.status!.type).toBe("array");
    expect(schema.properties.status!.items!.type).toBe("string");
    expect(tool.description).toContain("step_counts");
    expect(tool.description).toContain("pipeline_version");
  });

  test("pipeline, status, since and limit reach the API as its query", async () => {
    expect(idsOf(await session.call("list_runs", { pipeline: "hello-pipeline" }))).toEqual([succeeded]);
    expect(idsOf(await session.call("list_runs", { status: ["failed"] }))).toEqual([failed]);

    const anyOf = await session.call("list_runs", { status: ["succeeded", "failed"] });
    expect(new Set(idsOf(anyOf))).toEqual(new Set([succeeded, failed]));

    const sincePast = await session.call("list_runs", { since: "2000-01-01T00:00:00Z" });
    expect(new Set(idsOf(sincePast))).toEqual(new Set([succeeded, failed]));
    expect(idsOf(await session.call("list_runs", { since: "2999-01-01T00:00:00Z" }))).toEqual([]);

    expect(idsOf(await session.call("list_runs", { limit: 1 }))).toHaveLength(1);

    const combined = await session.call("list_runs", {
      pipeline: "fail-pipeline",
      status: ["failed"],
      since: "2000-01-01T00:00:00Z",
      limit: 5,
    });
    expect(idsOf(combined)).toEqual([failed]);
  });

  test("a malformed value is a type_mismatch with the argument as its path", async () => {
    for (const [args, path] of [
      [{ pipeline: "Not-A-Name" }, "pipeline"],
      [{ status: ["done"] }, "status"],
      [{ status: "failed" }, "status"],
      [{ since: "yesterday" }, "since"],
      [{ limit: "many" }, "limit"],
    ] as const) {
      expect(await session.error("list_runs", args)).toMatchObject({ code: "type_mismatch", path });
    }
  });
});
