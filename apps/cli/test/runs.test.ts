import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "./helpers.ts";
import { HELLO_BLOCK, SLOW_BLOCK, blockFile, cli, helloPipeline, libraryDir, parsed, startServer, treeDigest } from "./helpers.ts";

let server: Awaited<ReturnType<typeof startServer>> | null = null;
const dirs: string[] = [];

const FAIL_BLOCK = blockFile(
  `name: failing
description: Fail with a plain non-zero exit.`,
  `echo about to fail
exit 3`,
);

// Exit 75 is EX_TEMPFAIL, which SPEC 2.8 reads as "retry me", so this step gets a second attempt
// that carries on. The bytes each attempt writes name the attempt, so a test can tell them apart.
const FLAKY_BLOCK = blockFile(
  `name: flaky
description: Ask for a retry on the first attempt, then carry on and succeed.`,
  `echo "attempt $BR_ATTEMPT starting"
if [ "$BR_ATTEMPT" = "1" ]; then
  echo "attempt 1 stopping, asking to be retried"
  exit 75
fi
echo "attempt 2 carrying on"`,
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

/** The run ids a `runs ls --json` answer holds. */
function listedIds(result: Result): string[] {
  return parsed(result).map((run: { id: string }) => run.id);
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
    ["flaky", FLAKY_BLOCK],
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

// `delay: 1s` so the retry is due while a test is still watching; the default is 30s (SPEC 3.5).
const FLAKY_PIPELINE = `name: flaky-run
steps:
  flaky:
    uses: flaky@1
    retry:
      max_attempts: 2
      delay: 1s
`;

/** `two` cannot start until `one` has slept, so it has no attempt for a while. */
const WAITS_PIPELINE = `name: waits-run
inputs:
  seconds:
    type: integer
    default: 3
steps:
  one:
    uses: slow@1
    with:
      seconds: \${{ inputs.seconds }}
  two:
    uses: hello@1
    needs: [one]
`;

/** `boom` fails in a moment, `talk` keeps the run `running` for seconds after it. */
const HALF_PIPELINE = `name: half-run
inputs:
  seconds:
    type: integer
    default: 20
steps:
  boom:
    uses: failing@1
  talk:
    uses: slow@1
    with:
      seconds: \${{ inputs.seconds }}
`;

/** `after` is skipped the moment `boom` fails, and never has an attempt of its own. */
const SKIPPED_PIPELINE = `name: skipped-run
steps:
  boom:
    uses: failing@1
  after:
    uses: hello@1
    needs: [boom]
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

  // A typo in a flag used to publish the blocks beside the file on the way to the error, because the
  // file was published before the command line was read. Publishing the same bytes twice is silent,
  // so this runs against a library that holds nothing yet: the proof is the empty directory.
  test("a bad --input is refused before anything is published", async () => {
    server = await startServer();
    const dir = mkdtempSync(join(tmpdir(), "bashreactor-cli-files-"));
    dirs.push(dir);
    writeFileSync(join(dir, "hello.sh"), HELLO_BLOCK);
    const yaml = join(dir, "local.yaml");
    writeFileSync(yaml, `name: local-run\nsteps:\n  greet:\n    uses: ./hello.sh\n`);
    expect(treeDigest(libraryDir(server))).toEqual([]);

    for (const bad of [["--input", "bad"], ["--input", "name"]]) {
      const refused = await cli(["runs", "start", yaml, ...bad], { url: server.url });
      expect(refused.code).toBe(2);
      expect(parsed({ ...refused, stdout: refused.stderr }).code).toBe("invalid_argument");
      expect(refused.stderr).not.toContain("published");
      expect(treeDigest(libraryDir(server))).toEqual([]);
    }
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

  test("the table says each run's steps and pipeline version", async () => {
    server = await startServer();
    await library();
    await store("hello-run", helloPipeline("hello-run"));

    const stored = runId(
      await cli(["runs", "start", "hello-run", "--wait", "--interval", "100"], { url: server.url }),
    );
    const inlinePath = write("inline-run.yaml", "name: inline-run\nsteps:\n  greet:\n    uses: hello@1\n");
    const inline = runId(
      await cli(["runs", "start", inlinePath, "--wait", "--interval", "100"], { url: server.url }),
    );

    const list = await cli(["runs", "ls"], { url: server.url });
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/^RUN\s+PIPELINE\s+VERSION\s+STATUS\s+STEPS\s+CREATED\s+FINISHED\s+TOOK$/m);
    expect(list.stdout).toMatch(new RegExp(`${stored}\\s+hello-run\\s+v1\\s+succeeded\\s+1/1`));
    expect(list.stdout).toMatch(new RegExp(`${inline}\\s+inline-run\\s+-\\s+succeeded\\s+1/1`));
  });

  test("--pipeline, --status, --since and --limit are the API's own filters", async () => {
    server = await startServer();
    await library();
    await store("hello-run", helloPipeline("hello-run"));
    await store("failing-run", FAILING_PIPELINE);

    const hello = runId(
      await cli(["runs", "start", "hello-run", "--wait", "--interval", "100"], { url: server.url }),
    );
    const failed = runId(
      await cli(["runs", "start", "failing-run", "--wait", "--interval", "100"], { url: server.url }),
    );

    const byPipeline = await cli(["runs", "ls", "--pipeline", "hello-run", "--json"], { url: server.url });
    expect(listedIds(byPipeline)).toEqual([hello]);

    const byStatus = await cli(["runs", "ls", "--status", "failed", "--json"], { url: server.url });
    expect(listedIds(byStatus)).toEqual([failed]);

    const anyOf = await cli(["runs", "ls", "--status", "succeeded,failed", "--json"], { url: server.url });
    expect(new Set(listedIds(anyOf))).toEqual(new Set([hello, failed]));

    const sincePast = await cli(["runs", "ls", "--since", "2000-01-01T00:00:00Z", "--json"], { url: server.url });
    expect(new Set(listedIds(sincePast))).toEqual(new Set([hello, failed]));
    const sinceFuture = await cli(["runs", "ls", "--since", "2999-01-01T00:00:00Z", "--json"], {
      url: server.url,
    });
    expect(listedIds(sinceFuture)).toEqual([]);

    const limited = await cli(["runs", "ls", "--limit", "1", "--json"], { url: server.url });
    expect(listedIds(limited)).toHaveLength(1);
  });

  test("a malformed filter is the API's type_mismatch, not a second check here", async () => {
    server = await startServer();
    for (const [flag, value, path] of [
      ["--pipeline", "Not-A-Name", "pipeline"],
      ["--status", "stuck", "status"],
      ["--since", "yesterday", "since"],
      ["--limit", "many", "limit"],
    ] as const) {
      const result = await cli(["runs", "ls", flag, value], { url: server.url });
      expect(result.code).toBe(1);
      expect(parsed({ ...result, stdout: result.stderr })).toMatchObject({ code: "type_mismatch", path });
    }
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

  for (const size of [3_000_005, 1 << 20]) {
    test(`a ${size} byte log is printed whole, with and without --follow`, async () => {
      server = await startServer();
      await library();
      // Builtins only, like the other test blocks: the server's PATH is not the developer's.
      const block = blockFile(
        `name: biglog
description: Write a log of a given size ending in END.
inputs:
  size:
    type: integer`,
        `chunk=$(printf 'x%.0s' {1..1024})
body=$((INPUT_SIZE - 5))
for ((i = 0; i < body / 1024; i++)); do printf '%s' "$chunk"; done
printf '%s' "\${chunk:0:body % 1024}"
printf '\\nEND\\n'`,
      );
      expect((await cli(["blocks", "add", "biglog", write("biglog.sh", block)], { url: server.url })).code).toBe(0);
      await store(
        "big-run",
        `name: big-run
inputs:
  size:
    type: integer
steps:
  big:
    uses: biglog@1
    with:
      size: \${{ inputs.size }}
`,
      );
      const started = await cli(["runs", "start", "big-run", "--input", `size=${size}`, "--wait", "--interval", "100"], {
        url: server.url,
      });
      const id = runId(started);
      const expected = "x".repeat(size - 5) + "\nEND\n";

      const plain = await cli(["runs", "logs", id, "big"], { url: server.url });
      expect(plain.stdout.length).toBe(size);
      expect(plain.stdout === expected).toBe(true);
      expect(plain.stderr.trim()).toBe(`next offset ${size}`);

      const followed = await cli(["runs", "logs", id, "big", "--follow", "--interval", "100"], { url: server.url });
      expect(followed.stdout === expected).toBe(true);
      expect(followed.stderr).toContain(`next offset ${size}`);

      // --json is one chunk per read, and the chunks join up.
      const json = await cli(["runs", "logs", id, "big", "--json"], { url: server.url });
      const chunks = json.stdout.trim().split("\n").map((line) => JSON.parse(line));
      expect(chunks.length).toBe(Math.ceil(size / (1 << 20)));
      expect(chunks.map((chunk) => chunk.text).join("") === expected).toBe(true);
      expect(chunks.at(-1).truncated).toBe(false);
    }, 60_000);
  }

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

describe("runs logs --follow", () => {
  test("reads every attempt of a step that retried, in order, marking each on stderr", async () => {
    server = await startServer();
    await library();
    await store("flaky-run", FLAKY_PIPELINE);

    const started = await cli(["runs", "start", "flaky-run", "--json"], { url: server.url });
    const id = parsed(started).id as string;

    const followed = await cli(["runs", "logs", id, "flaky", "--follow", "--interval", "100"], { url: server.url });
    expect(followed.code).toBe(0);
    // Both attempts' bytes, in the order they were written (SPEC 4.8), and nothing of the reader's
    // own on stdout: the boundary markers are notes, so they go to stderr.
    expect(followed.stdout).toBe(
      "attempt 1 starting\n" +
        "attempt 1 stopping, asking to be retried\n" +
        "attempt 2 starting\n" +
        "attempt 2 carrying on\n",
    );
    expect(followed.stdout).not.toContain("==>");
    expect(followed.stderr).toMatch(/==> attempt 1 <==[\s\S]*==> attempt 2 <==/);
    expect(followed.stderr).toContain(`run ${id} succeeded`);

    // Under --json there is no marker to read: each chunk says which attempt it is from, and the
    // chunks of both attempts join up to the whole log.
    const json = await cli(["runs", "logs", id, "flaky", "--follow", "--interval", "100", "--json"], {
      url: server.url,
    });
    expect(json.stderr).toBe("");
    const chunks = json.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(new Set(chunks.map((chunk) => chunk.attempt))).toEqual(new Set([1, 2]));
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(
      "attempt 1 starting\n" +
        "attempt 1 stopping, asking to be retried\n" +
        "attempt 2 starting\n" +
        "attempt 2 carrying on\n",
    );
  });

  test("a retried step that is already finished still prints every attempt", async () => {
    server = await startServer();
    await library();
    await store("flaky-run", FLAKY_PIPELINE);

    const started = await cli(["runs", "start", "flaky-run", "--json"], { url: server.url });
    const id = parsed(started).id as string;
    expect(await statusOf(id)).toBe("succeeded");

    // Nothing is live any more, so the wait is over the moment it starts. That is no reason to drop
    // the attempts before the last one: the step's log is all of them (SPEC 4.8).
    const followed = await cli(["runs", "logs", id, "flaky", "--follow", "--interval", "100"], { url: server.url });
    expect(followed.code).toBe(0);
    expect(followed.stdout).toBe(
      "attempt 1 starting\n" +
        "attempt 1 stopping, asking to be retried\n" +
        "attempt 2 starting\n" +
        "attempt 2 carrying on\n",
    );
    expect(followed.stderr).toMatch(/==> attempt 1 <==[\s\S]*==> attempt 2 <==/);
  });

  test("--attempt pins one attempt, with --follow and without", async () => {
    server = await startServer();
    await library();
    await store("flaky-run", FLAKY_PIPELINE);

    const started = await cli(["runs", "start", "flaky-run", "--json"], { url: server.url });
    const id = parsed(started).id as string;

    const plain = await cli(["runs", "logs", id, "flaky", "--attempt", "1"], { url: server.url });
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe("attempt 1 starting\nattempt 1 stopping, asking to be retried\n");

    const followed = await cli(["runs", "logs", id, "flaky", "--attempt", "1", "--follow", "--interval", "100"], {
      url: server.url,
    });
    expect(followed.code).toBe(0);
    expect(followed.stdout).toBe("attempt 1 starting\nattempt 1 stopping, asking to be retried\n");
    expect(followed.stdout).not.toContain("attempt 2");
    expect(followed.stderr).not.toContain("==>");
    expect(followed.stderr).toContain(`run ${id} succeeded`);
  });

  test("waits for a step that has no attempt yet, then reads it", async () => {
    server = await startServer();
    await library();
    await store("waits-run", WAITS_PIPELINE);

    const started = await cli(["runs", "start", "waits-run", "--json"], { url: server.url });
    const id = parsed(started).id as string;

    // `two` cannot start until `one` has slept, so there is no attempt 1 to read yet. That is a
    // step that has not started (SPEC 4.4), not the API's `attempt_not_found`.
    const followed = await cli(["runs", "logs", id, "two", "--follow", "--interval", "100"], { url: server.url });
    expect(followed.code).toBe(0);
    expect(followed.stdout).toBe("hello world\n");
    expect(followed.stderr).toContain("==> attempt 1 <==");
    expect(followed.stderr).not.toContain("attempt_not_found");
    expect(followed.stderr).toContain(`run ${id} succeeded`);
  });

  test("stops waiting when the run goes final and the step never had an attempt", async () => {
    server = await startServer();
    await library();
    await store("skipped-run", SKIPPED_PIPELINE);

    const started = await cli(["runs", "start", "skipped-run", "--json"], { url: server.url });
    const id = parsed(started).id as string;

    const followed = await cli(["runs", "logs", id, "after", "--follow", "--interval", "100"], { url: server.url });
    expect(followed.code).toBe(1);
    expect(followed.stdout).toBe("");
    expect(followed.stderr).toContain("step after skipped");
    expect(followed.stderr).toContain(`run ${id} failed`);
  });

  test("a step that failed while the run carries on exits non-zero and names the step", async () => {
    server = await startServer();
    await library();
    await store("half-run", HALF_PIPELINE);

    const started = await cli(["runs", "start", "half-run", "--json"], { url: server.url });
    const id = parsed(started).id as string;

    const followed = await cli(["runs", "logs", id, "boom", "--follow", "--interval", "100"], { url: server.url });
    // `talk` is still running, so the run has not decided anything yet. The step you followed failed,
    // and that is the answer.
    expect(followed.code).toBe(1);
    expect(followed.stdout).toBe("about to fail\n");
    expect(followed.stderr).toContain(`run ${id} running`);
    // SPEC 5's pair, both halves: the code for machines, the engine's message for people. Since
    // BASHR-34 that message names the exit code instead of repeating the code, so the line no longer
    // closes on the code.
    expect(followed.stderr).toMatch(/step boom failed \(exit_nonzero: .+\)/);
    expect(followed.stderr).toContain("exit 3");
  });

  test("a step the run does not have is still the API's answer, with --follow", async () => {
    server = await startServer();
    await library();
    await store("hello-run", helloPipeline("hello-run"));
    const started = await cli(["runs", "start", "hello-run", "--json"], { url: server.url });
    const id = parsed(started).id as string;

    const followed = await cli(["runs", "logs", id, "nope", "--follow", "--interval", "100"], { url: server.url });
    expect(followed.code).toBe(1);
    expect(parsed({ ...followed, stdout: followed.stderr }).code).toBe("step_not_found");
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
