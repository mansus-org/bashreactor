import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { INSTRUCTIONS } from "../src/instructions.ts";
import { createMcpServer, TOOLS } from "../src/index.ts";
import { resolveConfig } from "../src/config.ts";
import type { Session, TestEnv } from "./helpers.ts";
import { connect, startEnv } from "./helpers.ts";

let env: TestEnv;
let session: Session;

beforeAll(async () => {
  env = await startEnv();
  session = await env.session();
});

afterAll(async () => {
  await session.close();
  env.cleanup();
});

describe("initialize", () => {
  test("names itself and carries instructions an agent can act on", () => {
    const init = session.client.getServerVersion();
    expect(init?.name).toBe("bashreactor");
    expect(init?.version).toBe("test-version");
    expect(session.client.getServerCapabilities()?.tools).toBeDefined();
    expect(session.client.getInstructions()).toBe(INSTRUCTIONS);
  });

  test("the instructions answer the four questions a tool name cannot", () => {
    const text = INSTRUCTIONS.toLowerCase();
    // validate before storing, runs are polled, logs are read by offset, a block's header is its contract
    expect(text).toContain("validate");
    expect(text).toContain("poll get_run");
    expect(text).toContain("next_offset");
    expect(text).toContain("contract is its header");
    expect(text).toContain("201");
  });
});

describe("tools/list", () => {
  test("lists every tool with a description and an input schema", async () => {
    const listed = await session.client.listTools();
    expect(listed.tools.length).toBe(TOOLS.length);
    for (const tool of listed.tools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect((tool.description ?? "").length).toBeGreaterThan(60);
      expect(tool.inputSchema).toBeObject();
      expect((tool.inputSchema as Record<string, unknown>).type).toBe("object");
      expect(tool.annotations).toBeObject();
    }
  });

  test("the table is the same set the task asked for", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      "whoami",
      "list_blocks",
      "list_block_versions",
      "get_block_version",
      "get_block_content",
      "list_pipelines",
      "list_pipeline_versions",
      "get_pipeline_version",
      "validate_pipeline",
      "list_runs",
      "get_run",
      "get_run_log",
      "list_run_files",
      "store_block_version",
      "store_pipeline_version",
      "start_run",
      "cancel_run",
      "retry_run",
      "resume_run",
      "list_agent_tokens",
      "create_agent_token",
      "revoke_agent_token",
    ]);
  });

  test("every write tool says so in its description, instead of hiding", () => {
    for (const tool of TOOLS.filter((entry) => entry.access !== "read")) {
      expect(tool.description).toContain("token");
    }
  });
});

describe("the endpoint", () => {
  test("answers /healthz without a token", async () => {
    const response = await fetch(`http://127.0.0.1:${new URL(env.mcpUrl).port}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, string>;
    expect(body.status).toBe("ok");
    expect(body.version).toBe("test-version");
    expect(body.api).toBe(env.apiUrl);
  });

  test("is stateless: no session id is issued, so any replica can answer next", async () => {
    const response = await env.raw("POST", {
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } },
      headers: { accept: "application/json, text/event-stream" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });

  test("answers a path that is not its own with the spec's error object", async () => {
    const response = await fetch(`${new URL(env.mcpUrl).origin}/nope`, {
      headers: { authorization: `Bearer ${env.admin}` },
    });
    expect(response.status).toBe(501);
    expect(((await response.json()) as { code: string }).code).toBe("not_implemented");
  });

  test("answers a method that is not POST with the same object", async () => {
    const response = await env.raw("DELETE");
    expect(response.status).toBe(405);
    expect(((await response.json()) as { code: string }).code).toBe("not_implemented");
  });

  test("one log line per request names the caller and the tool it turned into", async () => {
    const lines: string[] = [];
    const mcp = createMcpServer(
      resolveConfig({ BASHREACTOR_URL: env.apiUrl, BASHREACTOR_TOKEN: env.admin }, "test"),
      { log: (line) => lines.push(line) },
    );
    const server = Bun.serve({ port: 0, fetch: (request) => mcp.fetch(request) });
    try {
      const reader = await connect(`http://127.0.0.1:${server.port}/mcp`, env.reader);
      await reader.call("whoami");
      await reader.call("start_run", { pipeline: "hello-pipeline" });
      await reader.close();
    } finally {
      server.stop();
    }

    // One line per HTTP request — the connect's initialize and notification, its stream, and the two
    // calls — and the two calls are the ones that say what the caller did.
    expect(lines.filter((line) => line.includes("whoami"))).toHaveLength(1);
    // The `!` is a tool that came back with an error, which is the whole log's point.
    expect(lines.filter((line) => line.includes("start_run!"))).toHaveLength(1);
    expect(lines.every((line) => /^(POST|GET) \/mcp \d{3} \d+ms (\S+)( \S+)?$/.test(line))).toBe(true);
  });
});
