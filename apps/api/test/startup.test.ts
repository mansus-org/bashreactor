import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Startup } from "../src/startup.ts";
import { startServer, stopOnSignals } from "../src/startup.ts";
import { resolveConfig } from "../src/config.ts";
import { fakeRuntimeDir } from "./helpers.ts";

// What these pin down is the gap between "the process started" and "the socket is listening": nothing
// that touches the filesystem may take the listener down with it, and nothing that a block needs from
// the image may go unnoticed until a run asks for it. SPEC 1.5 and SPEC 2.6.

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

  test("a container built without jq is degraded from its first probe, not from its first run", async () => {
    // The review's repro, without a container: an image that has everything except the one package
    // blocks call. It used to answer `{"status":"ok"}` here and refuse at the first POST /v1/runs.
    const root = mkdtempSync(join(tmpdir(), "bashreactor-startup-"));
    roots.push(root);
    const bin = fakeRuntimeDir(root);
    rmSync(join(bin, "jq"));

    const lines: string[] = [];
    const { server, api, problem } = startServer({
      config: resolveConfig({ BASHREACTOR_HOME: root, PORT: "0", PATH: bin }, "test-version"),
      log: (line) => lines.push(line),
    });
    try {
      expect(api).toBeNull();
      expect(problem).toBe("missing on PATH: jq");
      expect(lines.some((line) => line.includes("missing on PATH: jq"))).toBe(true);

      const health = await get(server);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({
        status: "degraded",
        version: "test-version",
        problem: "missing on PATH: jq",
      });

      // Publishing a block into a server that can never run it is the second half of the finding.
      const publish = await fetch(`http://127.0.0.1:${server.port}/v1/blocks/hello/versions`, { method: "POST" });
      expect(publish.status).toBe(503);
      expect(await publish.json()).toEqual({
        code: "runtime_missing",
        message: "bashreactor could not start: missing on PATH: jq",
      });
    } finally {
      server.stop();
    }
  });

  test("checks the PATH it will hand the engine, not the one the process happens to have", async () => {
    const root = mkdtempSync(join(tmpdir(), "bashreactor-startup-"));
    roots.push(root);
    const complete = resolveConfig({ BASHREACTOR_HOME: root, PORT: "0", PATH: fakeRuntimeDir(root) }, "test-version");

    // The process's own PATH goes empty for the duration, so a check that read `process.env` instead
    // of the config would come back degraded here and the assertion below would be the one to say so.
    const saved = process.env.PATH;
    process.env.PATH = "";
    const { server, api, problem } = startServer({ config: complete, log: () => {} });
    process.env.PATH = saved;
    try {
      expect(problem).toBeNull();
      expect(api).not.toBeNull();
      expect((await get(server)).status).toBe(200);
    } finally {
      server.stop();
      api?.close();
    }
  });

  test("says which runtime is missing before whatever the build would have complained about", async () => {
    // Both are wrong, and the person reading `/healthz` fixes the image first: an unwritable data
    // directory is often only what a missing binary's error would have turned into anyway.
    const root = mkdtempSync(join(tmpdir(), "bashreactor-startup-"));
    roots.push(root);
    const bin = fakeRuntimeDir(root);
    rmSync(join(bin, "jq"));

    const { server, problem } = startServer({
      config: resolveConfig({ BASHREACTOR_HOME: root, PORT: "0", PATH: bin }, "test-version"),
      log: () => {},
      build: broken("the store would not open"),
    });
    try {
      expect(problem).toBe("missing on PATH: jq");
    } finally {
      server.stop();
    }
  });
});

describe("stopOnSignals", () => {
  test("what the entry point started is stopped before the engine goes", async () => {
    // The order is the whole point. A retention sweep that is still walking `runs/` when the engine
    // shuts down is a delete that will be cut in half by SIGKILL, and a half-deleted run directory is
    // worse than the full one: it is in no listing, so nothing will ever try to remove it again.
    const order: string[] = [];
    const startup = {
      server: { stop: async (forced: boolean) => void order.push(`server:${forced ? "forced" : "clean"}`) },
      api: { engine: { shutdown: async () => void order.push("engine") } },
    } as unknown as Startup;

    stopOnSignals(startup, {
      log: () => {},
      exit: () => void order.push("exit"),
      onStop: async () => {
        order.push("timer");
        await Bun.sleep(10);
      },
    });

    process.emit("SIGTERM", "SIGTERM");
    for (let i = 0; i < 100 && !order.includes("exit"); i += 1) await Bun.sleep(5);

    expect(order).toEqual(["timer", "engine", "server:clean", "exit"]);
  });
});
