import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_TOKEN } from "./helpers.ts";

// SPEC 4.7, graceful shutdown, against a real server process: Bun.spawn leaves SIGINT at its default,
// which a shell's `&` job would not (it starts with SIGINT ignored, and a test through one proves
// nothing). Every check reads the run directory, which is what the next engine will read.

const TRAPPER = `#!/usr/bin/env bash
# ---
# name: trapper
# description: Saves progress when told to stop, and finishes when it finds that progress.
# outputs:
#   done:
#     type: string
# ---

if [ -f saved ]; then
  echo resumed > "$OUTPUT_DONE"
  exit 0
fi
trap 'echo progress > saved; exit 143' TERM
echo working
sleep 60 &
wait
`;

const STUBBORN = `#!/usr/bin/env bash
# ---
# name: stubborn
# description: Ignores SIGTERM.
# ---

trap '' TERM
while true; do sleep 1; done
`;

const pipeline = (block: string, grace: string) =>
  `name: ${block}-pipeline\nsteps:\n  work:\n    uses: ${block}@1\n    kill_grace: ${grace}\n`;

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

interface Server {
  port: string;
  proc: ReturnType<typeof Bun.spawn>;
}

async function serve(home: string): Promise<Server> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts")], {
    env: { ...process.env, PORT: "0", BASHREACTOR_HOME: home, BASHREACTOR_ADMIN_TOKEN: ADMIN_TOKEN },
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
  return { port, proc };
}

async function call(server: Server, method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await response.json();
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error("waitFor timed out");
}

const runJson = (home: string, id: string) => JSON.parse(readFileSync(join(home, "runs", id, "run.json"), "utf8"));
const alive = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !stat.includes(") Z");
  } catch {
    return false;
  }
};

async function startBlockRun(server: Server, home: string, block: string, content: string, grace: string) {
  await call(server, "POST", `/v1/blocks/${block}/versions`, { content });
  const run = await call(server, "POST", "/v1/runs", { yaml: pipeline(block, grace) });
  await waitFor(() => runJson(home, run.id).steps.work.attempts[0]?.pid != null);
  return { id: run.id as string, pid: runJson(home, run.id).steps.work.attempts[0].pid as number };
}

describe("a server stopped with a block running", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`${signal}: the block gets its grace, the run stays running, and a new server finishes it`, async () => {
      const home = mkdtempSync(join(tmpdir(), "bashreactor-shutdown-"));
      homes.push(home);
      const first = await serve(home);
      const { id, pid } = await startBlockRun(first, home, "trapper", TRAPPER, "5s");

      first.proc.kill(signal);
      expect(await first.proc.exited).toBe(0);

      const record = runJson(home, id);
      expect(alive(pid)).toBe(false);
      expect(existsSync(join(home, "runs", id, "lock"))).toBe(false);
      expect(existsSync(join(home, "runs", id, "steps/work/work/saved"))).toBe(true);
      expect(record.status).toBe("running");
      expect(record.steps.work.status).toBe("pending");
      expect(record.steps.work.attempts).toHaveLength(1);
      expect(record.steps.work.attempts[0].status).toBe("interrupted");
      expect(record.steps.work.attempts[0].failure.code).toBe("interrupted");
      expect(record.steps.work.attempts_used).toBe(0);

      const second = await serve(home);
      try {
        await waitFor(async () => (await call(second, "GET", `/v1/runs/${id}`)).status === "succeeded");
        const done = await call(second, "GET", `/v1/runs/${id}`);
        expect(done.steps.work.attempts.map((a: { status: string }) => a.status)).toEqual(["interrupted", "succeeded"]);
        expect(done.steps.work.outputs).toEqual({ done: "resumed" });
      } finally {
        second.proc.kill("SIGTERM");
        await second.proc.exited;
      }
    }, 60_000);
  }

  test("a block that ignores TERM is SIGKILLed after kill_grace; a second signal does not wait for it", async () => {
    const home = mkdtempSync(join(tmpdir(), "bashreactor-shutdown-"));
    homes.push(home);
    const server = await serve(home);
    const { id, pid } = await startBlockRun(server, home, "stubborn", STUBBORN, "2s");

    const started = Date.now();
    server.proc.kill("SIGTERM");
    expect(await server.proc.exited).toBe(0);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(1_900);
    expect(alive(pid)).toBe(false);
    expect(existsSync(join(home, "runs", id, "lock"))).toBe(false);
    expect(runJson(home, id).steps.work.attempts[0].status).toBe("interrupted");

    const again = await serve(home);
    const long = await startBlockRun(again, home, "stubborn", STUBBORN, "60s");
    const stopStart = Date.now();
    again.proc.kill("SIGTERM");
    await Bun.sleep(500);
    again.proc.kill("SIGTERM");
    expect(await again.proc.exited).toBe(0);
    expect(Date.now() - stopStart).toBeLessThan(10_000);
    expect(alive(long.pid)).toBe(false);
    expect(runJson(home, long.id).steps.work.attempts[0].status).toBe("interrupted");
    expect(existsSync(join(home, "runs", long.id, "lock"))).toBe(false);
  }, 60_000);

  test("kill -9 still leaves a run the next server recovers", async () => {
    const home = mkdtempSync(join(tmpdir(), "bashreactor-shutdown-"));
    homes.push(home);
    const first = await serve(home);
    const { id, pid } = await startBlockRun(first, home, "trapper", TRAPPER, "5s");

    first.proc.kill("SIGKILL");
    await first.proc.exited;
    // Nothing ran a shutdown, so the old state is what the next engine has to cope with.
    expect(runJson(home, id).steps.work.attempts[0].status).toBe("running");

    const second = await serve(home);
    try {
      await waitFor(async () => (await call(second, "GET", `/v1/runs/${id}`)).status === "succeeded");
      const done = await call(second, "GET", `/v1/runs/${id}`);
      expect(done.steps.work.attempts.map((a: { status: string }) => a.status)).toEqual(["interrupted", "succeeded"]);
      expect(alive(pid)).toBe(false);
    } finally {
      second.proc.kill("SIGTERM");
      await second.proc.exited;
    }
  }, 60_000);
});
