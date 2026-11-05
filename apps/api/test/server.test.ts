import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_TOKEN } from "./helpers.ts";

// The scaffold's contract with the deploy: the image answers /healthz with its version, keeps 501 at
// /, and stops on SIGTERM. This runs main.ts as a real process over a real socket, because that is
// what the CI image job does.
async function serve(env: Record<string, string>): Promise<{ port: string; stop(): Promise<void> }> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts")], {
    env: { ...process.env, PORT: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  const port = /listening on :(\d+)/.exec(new TextDecoder().decode(value))?.[1];
  if (port === undefined) throw new Error(`the server did not say its port: ${new TextDecoder().decode(value)}`);
  reader.releaseLock();
  return {
    port,
    stop: async () => {
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
    },
  };
}

describe("the server process", () => {
  test("answers the probes the deploy workflow makes, and stops on SIGTERM", async () => {
    const home = mkdtempSync(join(tmpdir(), "bashreactor-main-"));
    const server = await serve({ BASHREACTOR_HOME: home, BASHREACTOR_VERSION: "ci-test" });
    try {
      const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok", version: "ci-test" });

      expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(501);

      const disabled = await fetch(`http://127.0.0.1:${server.port}/v1/runs`);
      expect(disabled.status).toBe(503);
      expect(((await disabled.json()) as { code: string }).code).toBe("runtime_missing");
    } finally {
      await server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("with an admin token it serves the API over a real socket", async () => {
    const home = mkdtempSync(join(tmpdir(), "bashreactor-main-"));
    const server = await serve({
      BASHREACTOR_HOME: home,
      BASHREACTOR_ADMIN_TOKEN: ADMIN_TOKEN,
      BASHREACTOR_VERSION: "ci-test",
    });
    try {
      const created = await fetch(`http://127.0.0.1:${server.port}/v1/tokens`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "over a socket", scope: "read" }),
      });
      expect(created.status).toBe(201);
      const { token } = (await created.json()) as { token: string };

      const whoami = await fetch(`http://127.0.0.1:${server.port}/v1/whoami`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(await whoami.json()).toEqual({ name: "over a socket", scope: "read", admin: false });
    } finally {
      await server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
