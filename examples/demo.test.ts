// The demo, run for real. Every script in this directory is executed end to end against a server
// started the way the container starts, on a throwaway data directory, and each one checks its own
// outcomes against docs/examples/README.md. The assertions live in the scripts, because they are
// what a stranger runs; this file is what stops them from rotting.
//
// It is a test and not a CI job because the demo is the repo's only end-to-end proof: engine, store,
// API, CLI, MCP server and the web entry point in one pass.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

const here = import.meta.dir;
const token = "br_demo_admin_for_tests";

interface Running {
  port: number;
  stop(): Promise<void>;
}

/** Start examples/serve.sh and take the port it actually bound, which is how the deploy finds it too. */
async function serve(home: string, adminToken: string): Promise<Running> {
  const proc = Bun.spawn(["bash", join(here, "serve.sh")], {
    env: {
      ...process.env,
      PORT: "0",
      BASHREACTOR_HOME: home,
      BASHREACTOR_VERSION: "demo-test",
      BASHREACTOR_ADMIN_TOKEN: adminToken,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  let port = 0;
  while (port === 0) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
    port = Number(/listening on :(\d+)/.exec(seen)?.[1] ?? "0");
  }
  if (port === 0) {
    throw new Error(`serve.sh did not say its port: ${seen}`);
  }
  reader.releaseLock();
  return {
    port,
    stop: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

/** A port to hand the MCP server, which has no way to pick one for itself. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = probe.port ?? 0;
  probe.stop();
  return port;
}

async function script(name: string, env: Record<string, string>): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["bash", join(here, name)], { env: { ...process.env, ...env } });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { out: `${stdout}\n${stderr}`, code: await proc.exited };
}

const demo = [
  ["demo.sh", "every outcome matched docs/examples/README.md"],
  ["api-demo.sh", "the API path matched docs/examples/README.md"],
  ["mcp-demo.sh", "the MCP path matched the API path"],
] as const;

test(
  "the three scripts walk a clean checkout from an empty server to a finished run",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "bashreactor-demo-"));
    const server = await serve(home, token);
    const env = {
      BASHREACTOR_URL: `http://127.0.0.1:${server.port}`,
      BASHREACTOR_TOKEN: token,
      BASHREACTOR_ADMIN_TOKEN: token,
      BASHREACTOR_HOME: home,
      BASHREACTOR_MCP_PORT: String(freePort()),
    };

    try {
      for (const [name, done] of demo) {
        const { out, code } = await script(name, env);
        expect(out).not.toContain("MISMATCH");
        expect(out).toContain(done);
        expect(code).toBe(0);
      }
    } finally {
      await server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  },
  240_000,
);

test(
  "the web entry point serves the UI the demo points a browser at",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "bashreactor-demo-web-"));
    const server = await serve(home, token);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const health = await fetch(`${base}/healthz`);
      expect(await health.json()).toEqual({ status: "ok", version: "demo-test" });

      // The three screens are one page that draws itself from /v1, so every deep link answers the
      // shell and every route behind them answers its document.
      for (const path of ["/app/", "/app/pipeline", "/app/runs", "/app/blocks"]) {
        const page = await fetch(`${base}${path}`);
        expect(page.status).toBe(200);
        expect(page.headers.get("content-type")).toContain("text/html");
      }
      expect((await fetch(`${base}/app/assets/app.js`)).status).toBe(200);

      // A call with no token is refused before any route runs, so the UI cannot read a deployment
      // nobody signed it into.
      expect((await fetch(`${base}/v1/whoami`)).status).toBe(401);
    } finally {
      await server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  },
  120_000,
);
