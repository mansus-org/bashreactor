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

  test("a path this API does not have is 404 not_found, not 501", async () => {
    for (const [method, path] of [
      ["GET", "/api/runs"],
      ["GET", "/healthz/extra"],
      ["DELETE", "/anything"],
    ] as const) {
      const response = await server.call(method, path, { token: null });
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toStartWith("application/json");
      expect(await response.json()).toEqual({
        code: "not_found",
        message: `${method} ${path} is not a path this API has`,
      });
    }
  });

  test("a known path with a method it does not take is 405 and says what it takes", async () => {
    const whoami = await server.call("PUT", "/v1/whoami");
    expect(whoami.status).toBe(405);
    expect(await whoami.json()).toEqual({
      code: "method_not_allowed",
      message: "PUT /v1/whoami is not allowed here; it takes GET",
    });

    // The probe is a route too, and a POST to it is the caller's mistake, not the server's.
    const probe = await server.call("POST", "/healthz", { token: null });
    expect(probe.status).toBe(405);
    expect(((await probe.json()) as Record<string, unknown>).code).toBe("method_not_allowed");

    // A path with more than one method names all of them.
    const tokens = await server.call("DELETE", "/v1/tokens");
    expect(tokens.status).toBe(405);
    expect(await tokens.json()).toEqual({
      code: "method_not_allowed",
      message: "DELETE /v1/tokens is not allowed here; it takes GET, POST",
    });
  });

  test("a path that is not valid percent-encoded UTF-8 is 400, with no internal text in it", async () => {
    for (const path of ["/v1/blocks/%E0%A4%A", "/v1/runs/%zz", "/v1/pipelines/%C2"]) {
      const response = await server.call("GET", path);
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(Object.keys(body).toSorted()).toEqual(["code", "message"]);
      expect(body.code).toBe("bad_request");
      expect(typeof body.message).toBe("string");
    }
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
