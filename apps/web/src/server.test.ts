// The entry the image runs, as a real process over a real socket — the same probe apps/api's own
// server test makes of main.ts, plus the two things this entry adds: /app and /mcp answer from the
// same port. The image is built from this file, so this is the test that says the build is still
// honest.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ADMIN = "web_process_admin";

async function serve(env: Record<string, string>): Promise<{ port: string; stop(): Promise<void> }> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "server.ts")], {
    env: { ...process.env, PORT: "0", ...env },
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
    port,
    stop: async () => {
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
    },
  };
}

test("the web entry serves the app and the API from one port, and stops on SIGTERM", async () => {
  const home = mkdtempSync(join(tmpdir(), "bashreactor-web-main-"));
  const server = await serve({
    BASHREACTOR_HOME: home,
    BASHREACTOR_ADMIN_TOKEN: ADMIN,
    BASHREACTOR_VERSION: "ci-web",
  });
  try {
    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", version: "ci-web" });

    // `/` reaches the app: the redirect the deploy probe used to expect now lands on the UI.
    const root = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(root.status).toBe(200);
    expect(root.url).toBe(`http://127.0.0.1:${server.port}/app/`);

    const app = await fetch(`http://127.0.0.1:${server.port}/app/`);
    expect(app.status).toBe(200);
    expect(await app.text()).toContain('<script type="module" src="/app/assets/app.js">');

    const font = await fetch(`http://127.0.0.1:${server.port}/app/assets/fonts/atkinson-next.woff2`);
    expect(font.headers.get("content-type")).toBe("font/woff2");

    const whoami = await fetch(`http://127.0.0.1:${server.port}/v1/whoami`, {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(await whoami.json()).toEqual({ name: "admin", scope: "admin", admin: true });
  } finally {
    await server.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("with no admin token the app still comes up, and /v1 says why it is closed", async () => {
  const home = mkdtempSync(join(tmpdir(), "bashreactor-web-main-"));
  const server = await serve({ BASHREACTOR_HOME: home, BASHREACTOR_VERSION: "ci-web" });
  try {
    expect((await fetch(`http://127.0.0.1:${server.port}/app/`)).status).toBe(200);
    const closed = await fetch(`http://127.0.0.1:${server.port}/v1/runs`);
    expect(closed.status).toBe(503);
    expect(((await closed.json()) as { code: string }).code).toBe("runtime_missing");
  } finally {
    await server.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

// The cluster ends TLS at the proxy and its routers answer on https only, so a redirect that says
// http sends the browser to a port nothing listens on. This is the difference between the site being
// up and it being reachable.
test("behind a proxy that ends TLS, the redirects keep the visitor on the scheme they came in on", async () => {
  const home = mkdtempSync(join(tmpdir(), "bashreactor-web-main-"));
  const server = await serve({ BASHREACTOR_HOME: home, BASHREACTOR_ADMIN_TOKEN: ADMIN, BASHREACTOR_VERSION: "ci-web" });
  const proxied = { "x-forwarded-proto": "https" };
  try {
    const root = await fetch(`http://127.0.0.1:${server.port}/`, { headers: proxied, redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe(`https://127.0.0.1:${server.port}/app/`);

    const app = await fetch(`http://127.0.0.1:${server.port}/app`, { headers: proxied, redirect: "manual" });
    expect(app.status).toBe(301);
    expect(app.headers.get("location")).toBe(`https://127.0.0.1:${server.port}/app/`);

    // With no header the process is not behind anything, and it keeps saying what it sees.
    const plain = await fetch(`http://127.0.0.1:${server.port}/`, { redirect: "manual" });
    expect(plain.headers.get("location")).toBe(`http://127.0.0.1:${server.port}/app/`);
  } finally {
    await server.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

// The image used to build the MCP server and never run it, so `/mcp` answered the API's 404 and the
// agents' endpoint existed only in someone's terminal. It is served on the API's own port now, which
// is the port the cluster's Service and the ingress already point at.
test("the MCP endpoint is served beside the API it fronts", async () => {
  const home = mkdtempSync(join(tmpdir(), "bashreactor-web-main-"));
  const server = await serve({ BASHREACTOR_HOME: home, BASHREACTOR_ADMIN_TOKEN: ADMIN, BASHREACTOR_VERSION: "ci-web" });
  const post = (body: unknown, token: string | null = ADMIN): Promise<Response> =>
    fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The transport answers 406 to anything that will not take both, which is how a browser tab
        // poking at the endpoint is turned away before the token is even looked at.
        accept: "application/json, text/event-stream",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });
  try {
    const hello = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
    });
    expect(hello.status).toBe(200);
    const announced = (await hello.json()) as { result: { serverInfo: { name: string; version: string } } };
    expect(announced.result.serverInfo).toEqual({ name: "bashreactor", version: "ci-web" });

    // The caller's token is spent on the API, so a caller without one hears the API's own refusal
    // rather than a 404 that says the path does not exist.
    const anonymous = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, null);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");
    expect(((await anonymous.json()) as { code: string }).code).toBe("unauthenticated");
  } finally {
    await server.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
