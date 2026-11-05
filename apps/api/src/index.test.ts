import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createHandler, resolvePort, resolveVersion } from "./index.ts";

const handler = createHandler({ version: "sha-abc1234" });
const request = (method: string, path: string) => new Request(`http://test${path}`, { method });

describe("createHandler", () => {
  test("GET /healthz answers 200 with the version", async () => {
    const response = handler(request("GET", "/healthz?probe=1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", version: "sha-abc1234" });
  });

  test.each([
    ["GET", "/"],
    ["GET", "/api/runs"],
    ["GET", "/healthz/extra"],
    ["POST", "/healthz"],
    ["DELETE", "/anything"],
  ])("%s %s answers 501 with the JSON error body", async (method, path) => {
    const response = handler(request(method, path));
    expect(response.status).toBe(501);
    expect(response.headers.get("content-type")).toStartWith("application/json");
    expect(await response.json()).toEqual({
      code: "not_implemented",
      message: `${method} ${path} is not implemented yet`,
    });
  });
});

describe("resolvePort", () => {
  test("defaults to 8080 when PORT is unset or empty", () => {
    expect(resolvePort({})).toBe(8080);
    expect(resolvePort({ PORT: "" })).toBe(8080);
  });

  test("reads PORT", () => {
    expect(resolvePort({ PORT: "9090" })).toBe(9090);
  });

  test.each(["abc", "-1", "65536", "80.5"])("rejects %p", (PORT) => {
    expect(() => resolvePort({ PORT })).toThrow(expect.objectContaining({ code: "runtime_missing" }));
  });
});

describe("resolveVersion", () => {
  test("prefers the version the image was tagged with", () => {
    expect(resolveVersion({ BASHREACTOR_VERSION: "pr-7-abc1234" }, "0.0.0")).toBe("pr-7-abc1234");
  });

  test("falls back when the image was built without one", () => {
    expect(resolveVersion({}, "0.0.0")).toBe("0.0.0");
    expect(resolveVersion({ BASHREACTOR_VERSION: "" }, "0.0.0")).toBe("0.0.0");
  });
});

describe("main", () => {
  test("serves on PORT and exits cleanly on SIGTERM", async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
      env: { ...process.env, PORT: "0", BASHREACTOR_VERSION: "test-version" },
      stdout: "pipe",
    });
    try {
      const reader = proc.stdout.getReader();
      const { value } = await reader.read();
      const port = /listening on :(\d+)/.exec(new TextDecoder().decode(value))?.[1];
      expect(port).toBeDefined();

      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(await response.json()).toEqual({ status: "ok", version: "test-version" });

      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
    } finally {
      proc.kill("SIGKILL");
    }
  });
});
