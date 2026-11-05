import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "./helpers.ts";
import { HELLO_BLOCK, SLOW_BLOCK, blockFile, cli, helloPipeline, parsed, startServer } from "./helpers.ts";

let server: Awaited<ReturnType<typeof startServer>> | null = null;
const dirs: string[] = [];

const FAIL_BLOCK = blockFile(
  `name: failing
description: Fail with a plain non-zero exit.`,
  `echo about to fail
exit 3`,
);

function write(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bashreactor-cli-files-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const RUN_ID = /[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}/;

/** The run id a command printed, or a test failure that shows what it printed instead. */
function runId(result: Result): string {
  const id = result.stdout.match(RUN_ID)?.[0];
  if (id === undefined) throw new Error(`no run id in: ${result.stdout}`);
  return id;
}

/** Poll `runs get` until the run is no longer running, the way a person follows one along. */
async function statusOf(id: string, tries = 60): Promise<string> {
  for (let i = 0; i < tries; i += 1) {
    const run = await cli(["runs", "get", id, "--json"], { url: server!.url });
    const status = parsed(run).status as string;
    if (status !== "running") return status;
    await Bun.sleep(100);
  }
  return "running";
}

afterEach(async () => {
  await server?.stop();
  server = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The library the run tests need: `hello@1`, `slow@1` and `failing@1`, and one pipeline of each. */
async function library(): Promise<string> {
  if (server === null) throw new Error("start the server first");
  const url = server.url;
  for (const block of [
    ["hello", HELLO_BLOCK],
    ["slow", SLOW_BLOCK],
    ["failing", FAIL_BLOCK],
  ] as const) {
    const path = write(`${block[0]}.sh`, block[1]);
    const added = await cli(["blocks", "add", block[0], path], { url });
    expect(added.code).toBe(0);
  }
  return url;
}

async function store(name: string, yaml: string): Promise<void> {
  const path = write(`${name}.yaml`, yaml);
  const stored = await cli(["pipelines", "add", name, path], { url: server!.url });
  expect(stored.code).toBe(0);
}

const SLOW_PIPELINE = `name: slow-run
inputs:
  seconds:
    type: integer
    default: 3
steps:
  talk:
    uses: slow@1
    with:
      seconds: \${{ inputs.seconds }}
`;

const FAILING_PIPELINE = `name: failing-run
steps:
  boom:
    uses: failing@1
`;

describe("runs start", () => {
  test("returns as soon as the run exists and says how to follow it", async () => {
    server = await startServer();
    await library();
    await store("hello-run", helloPipeline("hello-run"));

    const started = await cli(["runs", "start", "hello-run", "--input", "name=ada"], { url: server.url });
    expect(started.code).toBe(0);
    const id = started.stdout.match(RUN_ID)?.[0];
    expect(id).toBeDefined();
    expect(started.stdout).toContain(`follow it: bashreactor runs logs ${id} greet --follow`);

    const json = await cli(["runs", "start", "hello-run", "--json"], { url: server.url });
    expect(json.code).toBe(0);
    expect(json.stderr).toBe("");
    const record = parsed(json);
    expect(record.status).toBe("running");
    expect(Object.keys(record.steps)).toEqual(["greet"]);
  });

  test("--input is read with the text form of the type the pipeline declares", async () => {
    server = await startServer();
    await library();
    await store("hello-run", helloPipeline("hello-run"));

    const text = await cli(["runs", "start", "hello-run", "--input", "name=grace", "--json"], {
      url: server.url,
    });
    expect(parsed(text).inputs).toEqual({ name: "grace" });

    const bad = await cli(["runs", "start", "hello-run", "--input", "name"], { url: server.url });
    expect(bad.code).toBe(2);
    expect(parsed({ ...bad, stdout: bad.stderr }).code).toBe("invalid_argument");

    // An input the pipeline never declared is the engine's to refuse, with its own code.
    const unknown = await cli(["runs", "start", "hello-run", "--input", "nope=1"], { url: server.url });
    expect(unknown.code).toBe(1);
    expect(parsed({ ...unknown, stdout: unknown.stderr }).code).toBe("unknown_input");
  });

  test("an integer input arrives as a number, not as text", async () => {
    server = await startServer();
    await library();
    await store("slow-run", SLOW_PIPELINE);

    const started = await cli(["runs", "start", "slow-run", "--input", "seconds=1", "--json"], {
      url: server.url,
    });
    expect(parsed(started).inputs).toEqual({ seconds: 1 });

    const wrong = await cli(["runs", "start", "slow-run", "--input", "seconds=soon"], { url: server.url });
    expect(wrong.code).toBe(2);
    const body = parsed({ ...wrong, stdout: wrong.stderr });
    expect(body.code).toBe("type_mismatch");
    expect(body.path).toBe("inputs.seconds");
  });

  test("a local file is published and started without being stored first", async () => {
    server = await startServer();
    const dir = mkdtempSync(join(tmpdir(), "bashreactor-cli-files-"));
    dirs.push(dir);
    writeFileSync(join(dir, "hello.sh"), HELLO_BLOCK);
    const yaml = join(dir, "local.yaml");
    writeFileSync(
      yaml,
      `name: local-run
steps:
  greet:
    uses: ./hello.sh
    with:
      name: from a file
`,
    );

    const started = await cli(["runs", "start", yaml, "--wait", "--interval", "100"], { url: server.url });
    expect(started.code).toBe(0);
    expect(started.stderr).toContain("published");
    expect(started.stdout).toMatch(/status\s+succeeded/);
    expect(started.stdout).toMatch(/greet\s+succeeded/);
  });

  test("--wait ends with the run's own status as the exit code", async () => {
    server = await startServer();
    await library();
    await store("hello-run", helloPipeline("hello-run"));
    await store("failing-run", FAILING_PIPELINE);

    const good = await cli(["runs", "start", "hello-run", "--wait", "--interval", "100"], { url: server.url });
    expect(good.code).toBe(0);
    expect(good.stdout).toMatch(/status\s+succeeded/);
    expect(good.stdout).toMatch(/greet\s+succeeded/);

    const bad = await cli(["runs", "start", "failing-run", "--wait", "--interval", "100", "--json"], {
      url: server.url,
    });
    expect(bad.code).toBe(1);
    expect(parsed(bad).status).toBe("failed");
    expect(parsed(bad).steps.boom.failure.code).toBe("exit_nonzero");
  });

  test("a pipeline that declares outputs has them printed, and --version does not apply to a file", async () => {
    server = await startServer();
    await library();
    await store(
      "greeting-run",
      `${helloPipeline("greeting-run")}outputs:\n  greeting: \${{ steps.greet.outputs.greeting }}\n`,
    );

    const started = await cli(["runs", "start", "greeting-run", "--input", "name=ada", "--wait", "--interval", "100"], {
      url: server.url,
    });
    expect(started.code).toBe(0);
    expect(started.stdout).toContain("outputs");
    expect(started.stdout).toMatch(/greeting\s+hello ada/);

    const path = write("hello-run.yaml", helloPipeline("hello-run"));
    const confused = await cli(["runs", "start", path, "--version", "2"], { url: server.url });
    expect(confused.code).toBe(2);
    expect(parsed({ ...confused, stdout: confused.stderr }).message).toContain("is a file");
  });
});

describe("runs ls and get", () => {
  test("list them newest first, and read one back in both modes", async () => {
    server = await startServer();
    await library();
    await store("hello-run", helloPipeline("hello-run"));

    const started = await cli(["runs", "start", "hello-run", "--wait", "--interval", "100"], { url: server.url });
    const id = runId(started);

    const list = await cli(["runs", "ls"], { url: server.url });
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(id);
    expect(list.stdout).toContain("hello-run");
    expect(list.stdout).toContain("succeeded");

    const listed = await cli(["runs", "ls", "--json"], { url: server.url });
    expect(Array.isArray(parsed(listed))).toBe(true);
    expect(parsed(listed)[0].id).toBe(id);

    const got = await cli(["runs", "get", id], { url: server.url });
    expect(got.code).toBe(0);
    expect(got.stdout).toContain(id);
    expect(got.stdout).toMatch(/greet\s+succeeded/);
    // A timestamp in the human mode is the reader's own local time, not the ISO string the API sent.
    expect(got.stdout).toMatch(/^created\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/m);

    const json = await cli(["runs", "get", id, "--json"], { url: server.url });
    expect(parsed(json).id).toBe(id);
    expect(parsed(json).schema).toBe(1);
  });

  test("an id that is not a run id is the API's 404", async () => {
    server = await startServer();
    const result = await cli(["runs", "get", "../../etc/passwd"], { url: server.url });
    expect(result.code).toBe(1);
    expect(parsed({ ...result, stdout: result.stderr }).code).toBe("run_not_found");
  });
});

describe("runs logs", () => {
  test("prints the log and the offset to come back with", async () => {
    server = await startServer();
    await library();
    await store("hello-run", helloPipeline("hello-run"));
    const started = await cli(["runs", "start", "hello-run", "--input", "name=ada", "--wait", "--interval", "100"], {
      url: server.url,
    });
    const id = runId(started);

    const log = await cli(["runs", "logs", id, "greet"], { url: server.url });
    expect(log.code).toBe(0);
    expect(log.stdout).toBe("hello ada\n");
    expect(log.stderr.trim()).toBe("next offset 10");

    const from = await cli(["runs", "logs", id, "greet", "--offset", "6"], { url: server.url });
    expect(from.stdout).toBe("ada\n");
    expect(from.stderr.trim()).toBe("next offset 10");

    const json = await cli(["runs", "logs", id, "greet", "--json"], { url: server.url });
    expect(json.stderr).toBe("");
    expect(parsed(json)).toEqual({
      run: id,
      step: "greet",
      attempt: 1,
      offset: 0,
      next_offset: 10,
      truncated: false,
      text: "hello ada\n",
    });
  });

  test("--follow reads until the step is final and exits with the run's status", async () => {
    server = await startServer();
    await library();
    await store("slow-run", SLOW_PIPELINE);

    const started = await cli(["runs", "start", "slow-run", "--input", "seconds=1"], { url: server.url });
    const id = runId(started);

    const followed = await cli(["runs", "logs", id, "talk", "--follow", "--interval", "100"], { url: server.url });
    expect(followed.code).toBe(0);
    expect(followed.stdout).toBe("starting\nfinished\n");
    expect(followed.stderr).toContain(`run ${id} succeeded`);

    const again = await cli(["runs", "logs", id, "talk", "--follow", "--interval", "100", "--json"], {
      url: server.url,
    });
    expect(again.code).toBe(0);
    const chunks = again.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(chunks[0].text).toBe("starting\nfinished\n");
    expect(chunks.at(-1).text).toBe("");
  });

  test("a step that never ran is the API's answer", async () => {
    server = await startServer();
    await library();
    await store("hello-run", helloPipeline("hello-run"));
    const started = await cli(["runs", "start", "hello-run", "--wait", "--interval", "100"], { url: server.url });
    const id = runId(started);

    const result = await cli(["runs", "logs", id, "nope"], { url: server.url });
    expect(result.code).toBe(1);
    expect(parsed({ ...result, stdout: result.stderr }).code).toBe("step_not_found");
  });
});

describe("runs cancel, retry and resume", () => {
  test("cancel stops a run, and a finished run refuses to be cancelled again", async () => {
    server = await startServer();
    await library();
    await store("slow-run", SLOW_PIPELINE);

    const started = await cli(["runs", "start", "slow-run", "--input", "seconds=30"], { url: server.url });
    const id = runId(started);

    const cancelled = await cli(["runs", "cancel", id], { url: server.url });
    expect(cancelled.code).toBe(0);
    expect(cancelled.stdout).toContain("cancel asked for");
    // A cancel is a request the engine acts on (SPEC 4.6), so the run is not `cancelled` the instant
    // the answer arrives. Poll it the way a person would.
    expect(await statusOf(id)).toBe("cancelled");

    const again = await cli(["runs", "cancel", id], { url: server.url });
    expect(again.code).toBe(1);
    expect(parsed({ ...again, stdout: again.stderr }).code).toBe("run_not_active");

    // A cancelled run can be taken up again, and the step that was stopped runs from the top.
    const retried = await cli(["runs", "retry", id, "--json"], { url: server.url });
    expect(retried.code).toBe(0);
    expect(["running", "succeeded"]).toContain(parsed(retried).status);
  });

  test("resume is only for a run an engine died on", async () => {
    server = await startServer();
    await library();
    await store("hello-run", helloPipeline("hello-run"));
    const started = await cli(["runs", "start", "hello-run", "--wait", "--interval", "100"], { url: server.url });
    const id = runId(started);

    const result = await cli(["runs", "resume", id], { url: server.url });
    expect(result.code).toBe(1);
    expect(parsed({ ...result, stdout: result.stderr }).code).toBe("run_not_active");
  });
});
