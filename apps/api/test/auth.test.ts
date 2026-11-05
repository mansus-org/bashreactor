import { afterAll, describe, expect, test } from "bun:test";
import { ADMIN_TOKEN, HELLO_BLOCK, startApi } from "./helpers.ts";

const server = startApi();
afterAll(() => server.cleanup());

async function errorOf(response: Response): Promise<{ code: string; message: string; path?: string }> {
  return (await response.json()) as { code: string; message: string; path?: string };
}

describe("authentication", () => {
  test("a call with no token is 401 and says how to send one", async () => {
    const response = await server.call("GET", "/v1/runs", { token: null });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="bashreactor"');
    expect(await errorOf(response)).toMatchObject({ code: "unauthenticated" });
  });

  test("a token nobody issued is 401", async () => {
    const response = await server.call("GET", "/v1/runs", { token: "br_not_a_token" });
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("unauthenticated");
  });

  test("a header that is not a bearer token is 401", async () => {
    const response = await server.call("GET", "/v1/runs", { token: null, headers: { authorization: ADMIN_TOKEN } });
    expect(response.status).toBe(401);
  });

  test("whoami names the admin token", async () => {
    const response = await server.call("GET", "/v1/whoami");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "admin", scope: "admin", admin: true });
  });

  test("whoami names an agent token by its name and scope", async () => {
    const token = await server.agentToken("read", "reader-one");
    const response = await server.call("GET", "/v1/whoami", { token });
    expect(await response.json()).toEqual({ name: "reader-one", scope: "read", admin: false });
  });

  test("with no admin token configured the whole API is disabled, but the server still answers", async () => {
    const dark = startApi({ admin: null });
    try {
      const response = await dark.call("GET", "/v1/runs", { token: ADMIN_TOKEN });
      expect(response.status).toBe(503);
      expect(await errorOf(response)).toMatchObject({ code: "runtime_missing" });
      expect((await dark.call("GET", "/healthz", { token: null })).status).toBe(200);
    } finally {
      dark.cleanup();
    }
  });
});

describe("scopes", () => {
  test("a read token reads and is refused every write", async () => {
    const token = await server.agentToken("read");

    expect((await server.call("GET", "/v1/runs", { token })).status).toBe(200);
    expect((await server.call("POST", "/v1/pipelines/validate", { token, body: { yaml: "name: x\n" } })).status).toBe(200);

    const refused = await server.call("POST", "/v1/blocks/hello/versions", { token, body: { content: HELLO_BLOCK.content } });
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toMatchObject({ code: "forbidden" });
    expect((await server.call("POST", "/v1/runs", { token, body: { pipeline: "nope" } })).status).toBe(403);
    expect((await server.call("POST", "/v1/tokens", { token, body: { name: "x", scope: "read" } })).status).toBe(403);
  });

  test("a write token writes but cannot manage tokens", async () => {
    const token = await server.agentToken("write");
    expect((await server.call("POST", "/v1/blocks/hello/versions", { token, body: { content: HELLO_BLOCK.content } })).status).toBe(201);
    expect((await server.call("GET", "/v1/tokens", { token })).status).toBe(403);
    expect((await server.call("DELETE", "/v1/tokens/whatever", { token })).status).toBe(403);
  });

  test("only the admin token manages tokens", async () => {
    expect((await server.call("GET", "/v1/tokens")).status).toBe(200);
    expect((await server.call("POST", "/v1/tokens", { body: { name: "another", scope: "read" } })).status).toBe(201);
  });
});

describe("tokens over HTTP", () => {
  test("a created token is shown once and never again", async () => {
    const created = await server.call("POST", "/v1/tokens", { body: { name: "once-only", scope: "read" } });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { token: string; name: string; scope: string; id: string };
    expect(body.token).toStartWith("br_");
    expect(body.name).toBe("once-only");
    expect(body.scope).toBe("read");
    expect(body.id).toInclude("-");

    const listed = (await (await server.call("GET", "/v1/tokens")).json()) as Record<string, string>[];
    const mine = listed.find((entry) => entry.id === body.id)!;
    expect(mine.name).toBe("once-only");
    expect(JSON.stringify(listed)).not.toInclude(body.token);
  });

  test("a new token works on the next request", async () => {
    const token = await server.agentToken("read", "works-immediately");
    expect((await server.call("GET", "/v1/whoami", { token })).status).toBe(200);
  });

  test("a revoked token fails on the next request, without a restart", async () => {
    const created = (await (
      await server.call("POST", "/v1/tokens", { body: { name: "revoked-now", scope: "write" } })
    ).json()) as { id: string; token: string };

    expect((await server.call("GET", "/v1/whoami", { token: created.token })).status).toBe(200);
    const revoked = await server.call("DELETE", `/v1/tokens/${created.id}`);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ deleted: created.id });

    const after = await server.call("GET", "/v1/whoami", { token: created.token });
    expect(after.status).toBe(401);
    expect((await errorOf(after)).code).toBe("unauthenticated");
  });

  test("revoking an unknown token is 404", async () => {
    expect((await server.call("DELETE", "/v1/tokens/no-such-id")).status).toBe(404);
  });

  test("a token request that is not a name and a scope is 422 with a path", async () => {
    const cases: [unknown, string][] = [
      [{ scope: "read" }, "missing_input"],
      [{ name: "ok" }, "missing_input"],
      [{ name: "ok", scope: "root" }, "type_mismatch"],
      [{ name: 7, scope: "read" }, "type_mismatch"],
      [{ name: "ok", scope: "read", extra: true }, "unknown_input"],
    ];
    for (const [body, code] of cases) {
      const response = await server.call("POST", "/v1/tokens", { body });
      expect(response.status).toBe(422);
      expect(await errorOf(response)).toMatchObject({ code });
    }
    expect((await server.call("POST", "/v1/tokens", { body: "not json" })).status).toBe(422);
  });
});
