import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TOOLS } from "../src/index.ts";
import type { Session, TestEnv } from "./helpers.ts";
import { connect, seed, startEnv } from "./helpers.ts";

let env: TestEnv;
let reader: Session;
let writer: Session;

beforeAll(async () => {
  env = await startEnv();
  reader = await env.session(env.reader);
  writer = await env.session(env.writer);
  await seed(env);
});

afterAll(async () => {
  await reader.close();
  await writer.close();
  env.cleanup();
});

describe("the token on the request", () => {
  test("no token, and nothing configured, is refused before a single tool runs", async () => {
    const bare = await startEnv({ mcpToken: null });
    try {
      const response = await bare.raw("POST", { token: null, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
      const body = (await response.json()) as { code: string; message: string };
      expect(body.code).toBe("unauthenticated");
      // The message names both ways out: bring a token, or configure one on the server.
      expect(body.message).toContain("Authorization: Bearer");
      expect(body.message).toContain("BASHREACTOR_TOKEN");
    } finally {
      bare.cleanup();
    }
  });

  test("a token the API does not know is refused with the API's own answer", async () => {
    const response = await env.raw("POST", { token: "br_not_a_token", body: {} });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthenticated" });
    await expect(connect(env.mcpUrl, "br_not_a_token")).rejects.toThrow();
  });

  test("with nothing configured, every caller has to bring its own", async () => {
    const bare = await startEnv({ mcpToken: null });
    try {
      const session = await bare.session(bare.reader);
      expect((await session.call("whoami")).json.scope).toBe("read");
      await session.close();
    } finally {
      bare.cleanup();
    }
  });

  test("the configured token is only a fallback: the caller's wins", async () => {
    // This env is configured with the admin token and still answers as whoever asks.
    expect((await (await env.session()).call("whoami")).json.admin).toBe(true);
    expect((await reader.call("whoami")).json).toEqual({ name: "reader", scope: "read", admin: false });

    // With no caller token the configured one is spent, so the request gets through.
    const response = await env.raw("POST", {
      token: null,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
      },
      headers: { accept: "application/json, text/event-stream" },
    });
    expect(response.status).toBe(200);
  });
});

describe("scopes", () => {
  test("a read token reads everything a read token is for", async () => {
    for (const [tool, args] of [
      ["whoami", {}],
      ["list_block_versions", { name: "hello" }],
      ["get_block_version", { name: "hello" }],
      ["get_block_content", { name: "hello" }],
      ["list_pipeline_versions", { name: "hello-pipeline" }],
      ["get_pipeline_version", { name: "hello-pipeline" }],
      ["validate_pipeline", { yaml: "name: x\nsteps:\n  a:\n    uses: hello@1\n" }],
      ["list_runs", {}],
    ] as const) {
      expect(await reader.error(tool, args)).toBeNull();
    }
  });

  test("a read token is refused every write tool, and told which scope it lacked", async () => {
    const writeTools = TOOLS.filter((tool) => tool.access === "write");
    expect(writeTools.length).toBeGreaterThan(0);
    for (const tool of writeTools) {
      const body = await reader.error(tool.name);
      expect(body?.code).toBe("forbidden");
      expect(body?.message).toContain(`token "reader" is read-only`);
      expect(body?.message).toContain(tool.name);
      expect(body?.message).toContain("write token");
    }
  });

  test("the refusal is not the tool quietly missing from the list", async () => {
    const listed = await reader.client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const tool of TOOLS.filter((entry) => entry.access !== "read")) {
      expect(names).toContain(tool.name);
    }
  });

  test("a write token is refused what only the admin token may do", async () => {
    for (const tool of TOOLS.filter((entry) => entry.access === "admin")) {
      const body = await writer.error(tool.name);
      expect(body?.code).toBe("forbidden");
      expect(body?.message).toContain("admin token");
      expect(body?.message).toContain(tool.name);
    }
  });

  test("a write token is not the admin token, and the admin token is", async () => {
    expect(await writer.error("list_agent_tokens")).toMatchObject({ code: "forbidden" });
    const admin = await env.session(env.admin);
    expect(await admin.error("list_agent_tokens")).toBeNull();
    expect(await admin.error("store_block_version", { name: "any", content: "#!/usr/bin/env bash\n" })).not.toBeNull();
    await admin.close();
  });

  test("a revoked token stops working on the next request, without a restart", async () => {
    const token = await env.agentToken("read", "short-lived");
    const session = await env.session(token);
    expect(await session.error("whoami")).toBeNull();

    const listed = (await (await env.session(env.admin)).call("list_agent_tokens")).json as { id: string; name: string }[];
    const id = listed.find((entry) => entry.name === "short-lived")!.id;
    expect((await env.api("DELETE", `/v1/tokens/${id}`)).status).toBe(200);

    // The endpoint itself refuses, so a client cannot even carry on to a tool call.
    let refused = false;
    try {
      await session.error("whoami");
    } catch (error) {
      refused = String((error as Error).message).includes("unauthenticated");
    }
    expect(refused).toBe(true);
    await session.close();
  });
});
