// The entry the image runs, as a real process over a real socket — the same probe apps/api's own
// server test makes of main.ts, plus the one thing this entry adds: /app answers from the same port.
// The image is built from this file, so this is the test that says the build is still honest.

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
