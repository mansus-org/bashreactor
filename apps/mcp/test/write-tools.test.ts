import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Session, TestEnv } from "./helpers.ts";
import { blockFile, helloPipeline, seed, startEnv } from "./helpers.ts";

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

describe("store_block_version", () => {
  test("adds a version, and the same bytes do not add another", async () => {
    const first = await session.call("store_block_version", { name: "counter", content: counterBlock("1") });
    expect(first.isError).toBe(false);
    expect(first.json).toEqual({
      name: "counter",
      version: 1,
      sha256: first.json.sha256,
      size: new TextEncoder().encode(counterBlock("1")).length,
      created_at: first.json.created_at,
    });

    const again = await session.call("store_block_version", { name: "counter", content: counterBlock("1") });
    expect(again.json.version).toBe(1);

    const second = await session.call("store_block_version", { name: "counter", content: counterBlock("2") });
    expect(second.json.version).toBe(2);

    // And the read side sees what the write side wrote, through the same API.
    expect((await session.call("list_block_versions", { name: "counter" })).json.latest).toBe(2);
  });
});

describe("store_pipeline_version", () => {
  test("stores a document and keeps its bytes", async () => {
    const yaml = helloPipeline("stored-by-tool");
    const stored = await session.call("store_pipeline_version", { name: "stored-by-tool", yaml });
    expect(stored.isError).toBe(false);
    expect(stored.json.version).toBe(1);

    const read = await session.call("get_pipeline_version", { name: "stored-by-tool", version: "1" });
    expect(read.json.yaml).toBe(yaml);

    const changed = await session.call("store_pipeline_version", {
      name: "stored-by-tool",
      yaml: `${yaml}description: now with a description\n`,
    });
    expect(changed.json.version).toBe(2);
  });
});

describe("start_run", () => {
  test("runs a stored pipeline by name", async () => {
    const started = await session.call("start_run", { pipeline: "hello-pipeline", version: "1" });
    expect(started.json.status).toBe(201);
    expect(started.json.run.pipeline).toBe("hello-pipeline");
    await env.waitForRun(started.json.run.id);
  });

  test("runs a document that was never stored, with inputs", async () => {
    const yaml =
      'name: named-here\ninputs:\n  who:\n    type: string\nsteps:\n  greet:\n    uses: hello@1\n    with:\n      name: ${{ inputs.who }}\n';
    const started = await session.call("start_run", { yaml, inputs: { who: "from the tool" } });
    expect(started.isError).toBe(false);
    const record = await env.waitForRun(started.json.run.id);
    expect(record.status).toBe("succeeded");
    expect(record.steps.greet.outputs.greeting).toBe("hello from the tool");
  });
});

describe("cancel, retry and resume", () => {
  test("cancel stops a run that is going and answers before it is final", async () => {
    const started = await session.call("start_run", { pipeline: "sleep-pipeline" });
    const id = started.json.run.id;
    // Wait for the attempt to be live, so this is a cancel of work and not of a pending step.
    for (;;) {
      const step = (await session.call("get_run", { id })).json.steps.nap.status;
      if (step === "running") break;
      await Bun.sleep(25);
    }

    const cancelled = await session.call("cancel_run", { id });
    expect(cancelled.isError).toBe(false);
    expect(cancelled.json.status).toBe(202);

    const record = await env.waitForRun(id);
    expect(record.status).toBe("cancelled");
    expect(String(record.cancel_requested_at)).toMatch(/^\d{4}-/);
    expect(record.steps.nap.status).toBe("cancelled");
  });

  test("retry takes a failed run back over", async () => {
    const started = await session.call("start_run", { pipeline: "fail-pipeline" });
    const id = started.json.run.id;
    expect((await env.waitForRun(id)).status).toBe("failed");

    const retried = await session.call("retry_run", { id });
    expect(retried.isError).toBe(false);
    // Either it settled inside the request (200) or it is going still (202); both are the API's answer.
    expect([200, 202]).toContain(retried.json.status);

    const record = await env.waitForRun(id);
    expect(record.status).toBe("failed");
    expect(record.steps.boom.attempts.length).toBeGreaterThan(1);
  });

  test("resume answers with what the engine really says about the run", async () => {
    // A run this engine is driving has a live claim, and a finished one is not active: both are the
    // spec's own answers, and a successful resume needs an engine that died, which is the engine's
    // own restart test to stage.
    const finished = await env.waitForRun((await session.call("start_run", { pipeline: "hello-pipeline" })).json.run.id);
    expect(await session.error("resume_run", { id: finished.id })).toMatchObject({ code: "run_not_active" });
  });
});

describe("the token routes", () => {
  test("the admin token may list, issue and revoke", async () => {
    const admin = await env.session(env.admin);

    const created = await admin.call("create_agent_token", { name: "issued-by-tool", scope: "read" });
    expect(created.isError).toBe(false);
    expect(String(created.json.token)).toStartWith("br_");
    expect(created.json.name).toBe("issued-by-tool");
    expect(created.json.scope).toBe("read");

    const listed = await admin.call("list_agent_tokens");
    expect(listed.isError).toBe(false);
    const entry = listed.json.find((token: { name: string }) => token.name === "issued-by-tool");
    expect(entry).toBeDefined();
    expect(entry.token).toBeUndefined();

    expect((await admin.call("revoke_agent_token", { id: entry.id })).json).toEqual({ deleted: entry.id });
    expect((await admin.call("list_agent_tokens")).json.some((t: { id: string }) => t.id === entry.id)).toBe(false);

    // The secret is dead now, which is the whole point of a revoke: a session cannot even open.
    let refused = false;
    try {
      const revoked = await env.session(created.json.token as string);
      await revoked.close();
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    await admin.close();
  });
});

function counterBlock(number: string): string {
  return blockFile(
    "counter",
    `name: counter\ndescription: Print a number.\noutputs:\n  n:\n    type: integer`,
    `echo attempt ${number}\nprintf '%s' ${number} > "$OUTPUT_N"`,
  );
}
