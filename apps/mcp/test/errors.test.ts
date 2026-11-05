import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMcpServer } from "../src/index.ts";
import { resolveConfig } from "../src/config.ts";
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

describe("what the API answers is what the tool carries", () => {
  test("a run that is not there is run_not_found", async () => {
    expect(await session.error("get_run", { id: "20261104T101500Z-00000000" })).toMatchObject({ code: "run_not_found" });
    // An id that cannot be one never reaches the filesystem, and the API says so the same way.
    expect(await session.error("get_run", { id: "../../etc/passwd" })).toMatchObject({ code: "run_not_found" });
  });

  test("a step or an attempt that is not there says which", async () => {
    const id = (await env.waitForRun((await session.call("start_run", { pipeline: "hello-pipeline" })).json.run.id)).id;
    expect(await session.error("get_run_log", { id, step: "nope", attempt: 1 })).toMatchObject({
      code: "step_not_found",
      path: "steps.nope",
    });
    expect(await session.error("get_run_log", { id, step: "greet", attempt: 9 })).toMatchObject({
      code: "attempt_not_found",
    });
  });

  test("a block whose header is not valid is refused with its own code and path", async () => {
    expect(await session.error("store_block_version", { name: "bad", content: "#!/bin/sh\necho hi\n" })).toMatchObject({
      code: "block_header_malformed",
      file: "bad.sh",
    });

    const wrongType =
      "#!/usr/bin/env bash\n# ---\n# name: bad-two\n# inputs:\n#   n:\n#     type: string\n#     default: 5\n# ---\n\necho hi\n";
    expect(await session.error("store_block_version", { name: "bad-two", content: wrongType })).toMatchObject({
      code: "block_schema_invalid",
      path: "inputs.n.default",
    });

    // The name in the header has to be the name it is stored under.
    expect(await session.error("store_block_version", { name: "other", content: "#!/usr/bin/env bash\n# ---\n# name: bad\n# ---\n\ntrue\n" })).toMatchObject(
      { code: "block_schema_invalid", path: "name", file: "other.sh" },
    );
  });

  test("storing an invalid pipeline is its first issue, not a shrug", async () => {
    const body = await session.error("store_pipeline_version", {
      name: "broken",
      yaml: "name: broken\nsteps:\n  a:\n    uses: nosuch@1\n",
    });
    expect(body).toMatchObject({ code: "block_not_found", path: "steps.a.uses", file: "broken.yaml" });
  });

  test("starting a run with a bad document creates nothing and says why", async () => {
    const before = (await session.call("list_runs")).json.length;
    const body = await session.error("start_run", {
      yaml: "name: bad-run\nsteps:\n  a:\n    uses: hello@1\n    with:\n      name: 7\n",
    });
    expect(body).toMatchObject({ code: "type_mismatch", path: "steps.a.with.name" });
    // SPEC 4.3: an invalid pipeline never became a run, so the list has not moved.
    expect((await session.call("list_runs")).json).toHaveLength(before);
  });

  test("a run input that does not fit names the input", async () => {
    const yaml = "name: needs-input\ninputs:\n  lines:\n    type: integer\nsteps:\n  a:\n    uses: hello@1\n";
    expect(await session.error("start_run", { yaml, inputs: { lines: "many" } })).toMatchObject({
      code: "type_mismatch",
      path: "inputs.lines",
    });
    expect(await session.error("start_run", { yaml })).toMatchObject({
      code: "missing_input",
      path: "inputs.lines",
    });
    expect(await session.error("start_run", { yaml, inputs: { nope: 1 } })).toMatchObject({
      code: "unknown_input",
      path: "inputs.nope",
    });
  });

  test("either pipeline or yaml, and the API's own word for both", async () => {
    expect(await session.error("start_run", { pipeline: "hello-pipeline", yaml: "name: x\n" })).toMatchObject({
      code: "unknown_input",
    });
    expect(await session.error("start_run", {})).toMatchObject({ code: "missing_input" });
  });

  test("a run in the wrong state for the call says which state", async () => {
    const finished = await env.waitForRun((await session.call("start_run", { pipeline: "hello-pipeline" })).json.run.id);
    expect(await session.error("cancel_run", { id: finished.id })).toMatchObject({ code: "run_not_active" });
    expect(await session.error("retry_run", { id: finished.id })).toMatchObject({ code: "run_not_retryable" });
    expect(await session.error("resume_run", { id: finished.id })).toMatchObject({ code: "run_not_active" });

    const failed = await env.waitForRun((await session.call("start_run", { pipeline: "fail-pipeline" })).json.run.id);
    expect(failed.status).toBe("failed");
    expect(await session.error("resume_run", { id: failed.id })).toMatchObject({ code: "run_not_active" });
  });

  test("a run this engine is driving cannot be resumed", async () => {
    const started = await session.call("start_run", { pipeline: "sleep-pipeline" });
    const id = started.json.run.id;
    for (;;) {
      const step = (await session.call("get_run", { id })).json.steps.nap.status;
      if (step === "running") break;
      await Bun.sleep(25);
    }
    expect(await session.error("resume_run", { id })).toMatchObject({ code: "run_claimed" });
    await session.call("cancel_run", { id });
    await env.waitForRun(id);
  });

  test("a block that fails leaves its failure on the step, where get_run shows it", async () => {
    const record = await env.waitForRun((await session.call("start_run", { pipeline: "fail-pipeline" })).json.run.id);
    expect(record.steps.boom.failure).toMatchObject({ code: "exit_nonzero" });
    expect(record.steps.boom.attempts[0].exit_code).toBe(3);
    const log = await session.call("get_run_log", { id: record.id, step: "boom", attempt: 1 });
    expect(log.json.text).toContain("about to fail");
  });

  test("a pipeline that is not stored is block_not_found or pipeline_not_found, from the API", async () => {
    expect(await session.error("start_run", { pipeline: "never-stored" })).toMatchObject({
      code: "pipeline_not_found",
    });
    expect(await session.error("get_block_version", { name: "never-stored" })).toMatchObject({ code: "block_not_found" });
    expect(await session.error("get_pipeline_version", { name: "never-stored", version: "3" })).toMatchObject({
      code: "pipeline_not_found",
    });
  });
});

describe("arguments the caller got wrong", () => {
  test("a missing one is missing_input with the field as path", async () => {
    expect(await session.error("get_run", {})).toMatchObject({ code: "missing_input", path: "id" });
    expect(await session.error("get_run_log", { id: "x", step: "y" })).toMatchObject({
      code: "missing_input",
      path: "attempt",
    });
  });

  test("an unknown one is unknown_input", async () => {
    expect(await session.error("whoami", { nope: true })).toMatchObject({ code: "unknown_input", path: "nope" });
  });

  test("a wrong type is type_mismatch, with the same codes the API would have used", async () => {
    expect(await session.error("get_run", { id: 7 })).toMatchObject({ code: "type_mismatch", path: "id" });
    expect(await session.error("get_run_log", { id: "x", step: "y", attempt: 0 })).toMatchObject({
      code: "type_mismatch",
      path: "attempt",
    });
    expect(await session.error("get_run_log", { id: "x", step: "y", attempt: 1, offset: -1 })).toMatchObject({
      code: "type_mismatch",
      path: "offset",
    });
    expect(await session.error("get_block_version", { name: "hello", version: "zero" })).toMatchObject({
      code: "type_mismatch",
      path: "version",
    });
    expect(await session.error("start_run", { pipeline: "hello-pipeline", inputs: [] })).toMatchObject({
      code: "type_mismatch",
      path: "inputs",
    });
  });

  test("a tool that does not exist is a protocol error, not a tool error", async () => {
    await expect(session.client.callTool({ name: "no_such_tool", arguments: {} })).rejects.toThrow(/no tool/);
  });
});

describe("when the API is not there", () => {
  test("the endpoint says it could not reach it, and does not invent a spec code", async () => {
    // Port 1: nothing listens there. The caller is told the API is unreachable rather than being
    // handed a tool that appears to work and then says nothing useful.
    const mcp = createMcpServer(
      resolveConfig({ BASHREACTOR_URL: "http://127.0.0.1:1", BASHREACTOR_TOKEN: "whatever" }, "test"),
      { log: () => {} },
    );
    const server = Bun.serve({ port: 0, fetch: (request) => mcp.fetch(request) });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer whatever",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
        }),
      });
      expect(response.status).toBe(502);
      const body = (await response.json()) as { code: string; message: string };
      expect(body.code).toBe("api_unreachable");
      expect(body.message).toContain("127.0.0.1:1");
    } finally {
      server.stop();
    }
  });
});
