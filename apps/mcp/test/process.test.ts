import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { TestEnv } from "./helpers.ts";
import { connect, seed, startEnv } from "./helpers.ts";
import { TOOLS } from "../src/index.ts";

// The manifest's own entry point, as a real process over a real socket: the same thing the image
// runs, so a config that only works when a test built it by hand still shows up here.
async function spawnMcp(env: Record<string, string>): Promise<{ port: number; stop(): Promise<void> }> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts")], {
    env: { ...process.env, BASHREACTOR_MCP_PORT: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  let port: string | undefined;
  while (port === undefined) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
    port = /listening on :(\d+)/.exec(seen)?.[1];
  }
  if (port === undefined) throw new Error(`the server did not say its port: ${seen}`);
  reader.releaseLock();
  return {
    port: Number(port),
    stop: async () => {
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
    },
  };
}

let env: TestEnv;

beforeAll(async () => {
  env = await startEnv();
  await seed(env);
});

afterAll(() => {
  env.cleanup();
});

describe("the process", () => {
  test("starts, answers its probe, and stops on SIGTERM", async () => {
    const server = await spawnMcp({
      BASHREACTOR_URL: env.apiUrl,
      BASHREACTOR_TOKEN: env.admin,
      BASHREACTOR_VERSION: "mcp-test",
    });
    try {
      const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(health.status).toBe(200);
      const body = (await health.json()) as Record<string, string>;
      expect(body).toEqual({
        status: "ok",
        version: "mcp-test",
        api: env.apiUrl,
        token: "configured",
      });

      const session = await connect(`http://127.0.0.1:${server.port}/mcp`, env.reader);
      expect((await session.client.listTools()).tools).toHaveLength(TOOLS.length);
      expect((await session.call("list_block_versions", { name: "hello" })).isError).toBe(false);
      await session.close();
    } finally {
      await server.stop();
    }
  });

  test("with no token of its own it still listens, and asks the caller for one", async () => {
    const server = await spawnMcp({ BASHREACTOR_URL: env.apiUrl });
    try {
      const refused = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
        }),
      });
      expect(refused.status).toBe(401);
      expect(((await refused.json()) as { code: string }).code).toBe("unauthenticated");

      // A caller that brings a token needs nothing from the server's environment.
      const session = await connect(`http://127.0.0.1:${server.port}/mcp`, env.admin);
      expect((await session.call("whoami")).json.admin).toBe(true);
      await session.close();
    } finally {
      await server.stop();
    }
  });

  test("refuses to start without an API to front, and names the variable", async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts")], {
      env: { ...process.env, BASHREACTOR_URL: "", BASHREACTOR_MCP_PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).not.toBe(0);
    expect(stderr).toContain("BASHREACTOR_URL");
  });
});
