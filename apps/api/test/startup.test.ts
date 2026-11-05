import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Startup } from "../src/startup.ts";
import { startServer } from "../src/startup.ts";
import { resolveConfig } from "../src/config.ts";

// What these pin down is the gap between "the process started" and "the socket is listening": nothing
// that touches the filesystem may take the listener down with it. SPEC 1.5.

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function config(): ReturnType<typeof resolveConfig> {
  const root = mkdtempSync(join(tmpdir(), "bashreactor-startup-"));
  roots.push(root);
  return resolveConfig({ BASHREACTOR_HOME: root, PORT: "0" }, "test-version");
}

function get(server: Startup["server"], path = "/healthz"): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`);
}

function broken(message: string): () => never {
  return () => {
    throw new Error(message);
  };
}

describe("startServer", () => {
  test("serves the API it built", async () => {
    const { server, api, problem } = startServer({ config: config() });
    try {
      expect(api).not.toBeNull();
      expect(problem).toBeNull();
      const health = await get(server);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok", version: "test-version" });
    } finally {
      server.stop();
      api?.close();
    }
  });

  test("a build that throws still binds the socket and says why at /healthz", async () => {
    const lines: string[] = [];
    const { server, api, problem } = startServer({
      config: config(),
      log: (line) => lines.push(line),
      build: broken("EACCES: permission denied, mkdir '/.bashreactor'"),
    });
    try {
      expect(api).toBeNull();
      expect(problem).toBe("EACCES: permission denied, mkdir '/.bashreactor'");
      expect(lines.some((line) => line.includes("degraded"))).toBe(true);

      const health = await get(server);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({
        status: "degraded",
        version: "test-version",
        problem: "EACCES: permission denied, mkdir '/.bashreactor'",
      });
    } finally {
      server.stop();
    }
  });

  test("degraded answers every other route with the error object at 503", async () => {
    const { server } = startServer({ config: config(), log: () => {}, build: broken("the store would not open") });
    try {
      for (const [method, path] of [
        ["GET", "/"],
        ["GET", "/v1/runs"],
        ["POST", "/v1/runs"],
      ] as const) {
        const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          code: "runtime_missing",
          message: "bashreactor could not start: the store would not open",
        });
      }
    } finally {
      server.stop();
    }
  });

  test("the real build degrades on a data directory it cannot make", async () => {
    // The container's failure, without a container: the store's mkdir is what throws, so this goes
    // red again the moment anything starts throwing before the socket is bound.
    const root = mkdtempSync(join(tmpdir(), "bashreactor-startup-"));
    roots.push(root);
    const blocked = join(root, "not-a-directory");
    await Bun.write(blocked, "");

    const { server, api, problem } = startServer({
      config: resolveConfig({ BASHREACTOR_HOME: join(blocked, "home"), PORT: "0" }, "test-version"),
      log: () => {},
    });
    try {
      expect(api).toBeNull();
      expect(problem).toContain("mkdir");
      expect((await get(server)).status).toBe(200);
    } finally {
      server.stop();
    }
  });
});
