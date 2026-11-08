// Taking a run away again (SPEC 4.2) and knowing when you have to (SPEC 4.11), from the CLI:
// `bashreactor runs rm` and `bashreactor disk`.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "./helpers.ts";
import { HELLO_BLOCK, SLOW_BLOCK, cli, helloPipeline, parsed, startServer } from "./helpers.ts";

let server: Awaited<ReturnType<typeof startServer>> | null = null;
const dirs: string[] = [];

function write(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bashreactor-cli-rm-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const RUN_ID = /[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}/;

function runId(result: Result): string {
  const id = result.stdout.match(RUN_ID)?.[0];
  if (id === undefined) throw new Error(`no run id in: ${result.stdout}`);
  return id;
}

/** Poll until the run leaves `running`, the way a person following one does. */
async function statusOf(id: string, tries = 60): Promise<string> {
  for (let i = 0; i < tries; i += 1) {
    const run = await cli(["runs", "get", id, "--json"], { url: server!.url });
    const status = parsed(run).status as string;
    if (status !== "running") return status;
    await Bun.sleep(50);
  }
  return "running";
}

afterEach(async () => {
  await server?.stop();
  server = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** `hello@1` and `slow@1`, and one pipeline of each, so a run can be started and finished. */
async function library(): Promise<string> {
  if (server === null) throw new Error("start the server first");
  for (const [name, body] of [["hello", HELLO_BLOCK], ["slow", SLOW_BLOCK]] as const) {
    const added = await cli(["blocks", "add", name, write(`${name}.sh`, body)], { url: server.url });
    expect(added.code).toBe(0);
  }
  for (const [name, yaml] of [
    ["hello-run", helloPipeline("hello-run")],
    [
      "slow-run",
      `name: slow-run
inputs:
  seconds:
    type: integer
    default: 5
steps:
  talk:
    uses: slow@1
    with:
      seconds: \${{ inputs.seconds }}
`,
    ],
  ] as const) {
    const stored = await cli(["pipelines", "add", name, write(`${name}.yaml`, yaml)], { url: server.url });
    expect(stored.code).toBe(0);
  }
  return server.url;
}

describe("bashreactor runs rm", () => {
  test("a finished run goes, and with it the directory it wrote into", async () => {
    server = await startServer();
    const url = await library();

    const started = await cli(["runs", "start", "hello-run", "--json"], { url });
    const id = runId(started);
    expect(await statusOf(id)).toBe("succeeded");
    const dir = join(server.home, "runs", id);
    expect(existsSync(dir)).toBe(true);

    const removed = await cli(["runs", "rm", id, "--json"], { url });
    expect(removed.code).toBe(0);
    expect(parsed(removed)).toEqual({ deleted: id });
    expect(existsSync(dir)).toBe(false);

    const gone = await cli(["runs", "get", id, "--json"], { url });
    expect(gone.code).not.toBe(0);
    expect(parsed(gone).code).toBe("run_not_found");
  });

  test("the plain answer names the run that went", async () => {
    server = await startServer();
    const url = await library();

    const started = await cli(["runs", "start", "hello-run", "--json"], { url });
    const id = runId(started);
    await statusOf(id);

    const text = await cli(["runs", "rm", id], { url });
    expect(text.code).toBe(0);
    expect(text.stdout.trim()).toBe(`deleted ${id}`);
  });

  test("a run with an engine holding it is left alone, and says who holds it", async () => {
    server = await startServer();
    const url = await library();

    const started = await cli(["runs", "start", "slow-run", "--input", "seconds=4", "--json"], { url });
    const id = runId(started);

    const tooSoon = await cli(["runs", "rm", id, "--json"], { url });
    expect(tooSoon.code).not.toBe(0);
    expect(parsed(tooSoon).code).toBe("run_claimed");
    // The answer is only worth anything if the run is still there to be taken after it is cancelled.
    expect(existsSync(join(server.home, "runs", id))).toBe(true);
    expect(await statusOf(id)).toBe("succeeded");
  });

  test("a run that is not there is a run_not_found, the same one every other command gives", async () => {
    server = await startServer();
    const url = await library();

    const missing = await cli(["runs", "rm", "20260101T000000Z-deadbeef", "--json"], { url });
    expect(missing.code).not.toBe(0);
    expect(parsed(missing).code).toBe("run_not_found");
  });
});

describe("bashreactor disk", () => {
  test("the server says how much room it has left to write in", async () => {
    server = await startServer();

    const answer = await cli(["disk", "--json"], { url: server.url });
    const body = parsed(answer);

    expect(body.path).toBe(server.home);
    expect(body.total_bytes).toBeGreaterThan(0);
    expect(body.free_bytes).toBeGreaterThan(0);
    expect(typeof body.low).toBe("boolean");
    // The filesystem's numbers can belong to a bigger disk than the volume; this one is ours.
    expect(body.runs_bytes).toBeNumber();
    // `low` is the news, so it is also the exit code — but the test must not depend on how full the
    // machine running it happens to be.
    expect(answer.code).toBe(body.low ? 1 : 0);
  });

  test("the plain answer is readable without being a paragraph", async () => {
    server = await startServer();

    const text = await cli(["disk"], { url: server.url });
    expect(text.stdout).toContain(server.home);
    expect(text.stdout).toContain("free");
    expect(text.stdout).toContain("used");
    expect(text.stdout).toContain("runs/");
  });
});
