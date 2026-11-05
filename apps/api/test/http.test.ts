import { afterAll, describe, expect, test } from "bun:test";
import { startApi } from "./helpers.ts";

const server = startApi();
afterAll(() => server.cleanup());

describe("the surface every surface must keep", () => {
  test("GET /healthz answers without a token, with the version the image was tagged with", async () => {
    const response = await server.call("GET", "/healthz?probe=1", { token: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", version: "test-version" });
  });

  test("a route this API does not have is 501 not_implemented, which is what the CI image job probes", async () => {
    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/api/runs"],
      ["GET", "/healthz/extra"],
      ["POST", "/healthz"],
      ["DELETE", "/anything"],
    ] as const) {
      const response = await server.call(method, path, { token: null });
      expect(response.status).toBe(501);
      expect(response.headers.get("content-type")).toStartWith("application/json");
      expect(await response.json()).toEqual({
        code: "not_implemented",
        message: `${method} ${path} is not implemented yet`,
      });
    }
  });

  test("a known route with a method it does not take is 501 too, not a wrong 405", async () => {
    const response = await server.call("PUT", "/v1/whoami");
    expect(response.status).toBe(501);
  });

  test("every error body is the spec's error object and nothing else", async () => {
    const response = await server.call("GET", "/v1/runs/nope");
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(["code", "message"]);
    expect(body.code).toBe("run_not_found");
    expect(typeof body.message).toBe("string");
  });
});
