// `runs files`, `runs download` and `runs archive` (BASHR-47), against a real API on a real socket.
// The point of a download command is that the bytes on disk match the bytes the server had, so that
// is what these measure — not that a request was made.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "./helpers.ts";
import { blockFile, cli, parsed, sha256Hex, startServer } from "./helpers.ts";

let server: Server;
const dirs: string[] = [];

const FILES_BLOCK = blockFile(
  `name: writes-files
description: Write a file output and a couple of files in the work directory.
outputs:
  report:
    type: file`,
  `printf 'name,value\\nembeddings,3\\n' > "$OUTPUT_REPORT"`,
);

const FILES_PIPELINE = `name: files-pipeline
outputs:
  report: \${{ steps.write.outputs.report }}
steps:
  write:
    uses: writes-files@1
`;

const runDir = (id: string) => join(server.home, "runs", id);

async function startAndWait(): Promise<string> {
  const started = await cli(["runs", "start", "files-pipeline", "--json"], { url: server.url });
  const id = parsed(started).id as string;
  for (let i = 0; i < 100; i++) {
    if ((await cli(["runs", "get", id, "--json"], { url: server.url })).stdout.includes('"succeeded"')) return id;
    await Bun.sleep(50);
  }
  throw new Error(`run ${id} never finished`);
}

let runId = "";

beforeAll(async () => {
  server = await startServer();

  const blockDir = mkTemp("block-");
  const blockPath = join(blockDir, "writes-files.sh");
  writeFileSync(blockPath, FILES_BLOCK);
  expect((await cli(["blocks", "add", "writes-files", blockPath], { url: server.url })).code).toBe(0);

  const pipelineDir = mkTemp("pipeline-");
  const yamlPath = join(pipelineDir, "files-pipeline.yaml");
  writeFileSync(yamlPath, FILES_PIPELINE);
  expect((await cli(["pipelines", "add", "files-pipeline", yamlPath], { url: server.url })).code).toBe(0);

  runId = await startAndWait();
  // The test PATH holds only the binaries SPEC 2.6 promises a block may call, and `mkdir` is not one
  // of them; the work directory is filled from here instead, which is the same thing on disk.
  const chunks = join(runDir(runId), "steps/write/work/chunks");
  mkdirSync(chunks, { recursive: true });
  writeFileSync(join(chunks, "chunks.jsonl"), '{"chunk":0}\n');
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

function mkTemp(prefix: string): string {
  const dir = join(server.home, `${prefix}${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

describe("runs files", () => {
  test("prints the manifest, with the sizes the server gave", async () => {
    const result = await cli(["runs", "files", runId, "--json"], { url: server.url });
    expect(result.code).toBe(0);
    const manifest = parsed(result);
    expect(manifest.run).toBe(runId);
    expect(manifest.status).toBe("succeeded");
    expect(manifest.outputs[0]).toEqual({
      name: "report",
      type: "file",
      step: "write",
      attempt: 1,
      path: "steps/write/attempts/1/outputs/report",
      size: 24,
    });
    expect(manifest.steps.write.attempts[0].work[0].path).toBe("steps/write/work/chunks/chunks.jsonl");
  });

  test("reads like the other read commands, and narrows with --step and --scope", async () => {
    const human = await cli(["runs", "files", runId], { url: server.url });
    expect(human.code).toBe(0);
    expect(human.stdout).toInclude(runId);
    expect(human.stdout).toInclude("steps/write/attempts/1/outputs/report");

    const logsOnly = await cli(["runs", "files", runId, "--step", "write", "--scope", "logs", "--json"], {
      url: server.url,
    });
    expect(logsOnly.code).toBe(0);
    expect(parsed(logsOnly).steps.write.attempts[0].work).toBeUndefined();
  });

  test("an unknown run or step is the API's own error object and exit 1", async () => {
    const missing = await cli(["runs", "files", "20261104T101500Z-3fa9c2d1", "--json"], { url: server.url });
    expect(missing.code).toBe(1);
    expect(parsed(missing).code).toBe("run_not_found");

    const step = await cli(["runs", "files", runId, "--step", "nope", "--json"], { url: server.url });
    expect(parsed(step).code).toBe("step_not_found");
  });
});

describe("runs download", () => {
  const path = "steps/write/work/chunks/chunks.jsonl";

  test("the file on disk is byte for byte the file the server had", async () => {
    const dir = mkTemp("out-");
    const result = await cli(["runs", "download", runId, path, "-o", join(dir, "chunks.jsonl")], { url: server.url });
    expect(result.code).toBe(0);
    const source = readFileSync(join(runDir(runId), path));
    const downloaded = new Uint8Array(readFileSync(join(dir, "chunks.jsonl")));
    // The bytes, not a placeholder for them: a write that handed the stream object over wrote a
    // 23-byte "[object ReadableStream]" and still exited 0, and this is what catches that.
    expect(downloaded.length).toBe(source.length);
    expect(sha256Hex(downloaded)).toBe(sha256Hex(new Uint8Array(source)));
    expect(result.stdout).toInclude(`${source.length} B`);
  });

  test("with no -o it takes the file's own name, in the directory it runs in", async () => {
    const dir = mkTemp("cwd-");
    const result = await cli(["runs", "download", runId, path], { url: server.url, cwd: dir });
    expect(result.code).toBe(0);
    expect(existsSync(join(dir, "chunks.jsonl"))).toBe(true);
    expect(sha256Hex(new Uint8Array(readFileSync(join(dir, "chunks.jsonl"))))).toBe(
      sha256Hex(new Uint8Array(readFileSync(join(runDir(runId), path)))),
    );
  });

  test("it will not overwrite a file that is already there, and --force does", async () => {
    const dir = mkTemp("force-");
    const target = join(dir, "report");
    writeFileSync(target, "mine\n");

    const refused = await cli(["runs", "download", runId, "steps/write/attempts/1/outputs/report", "-o", target], {
      url: server.url,
    });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toInclude("--force");
    expect(readFileSync(target, "utf8")).toBe("mine\n");

    expect((await cli(["runs", "download", runId, "steps/write/attempts/1/outputs/report", "-o", target, "--force"], { url: server.url })).code).toBe(0);
    expect(readFileSync(target, "utf8")).toInclude("embeddings");
  });

  test("a symlink the block left is the API's file_not_found, not a local write", async () => {
    const work = join(runDir(runId), "steps/write/work");
    writeFileSync(join(server.home, "not-yours.txt"), "no\n");
    symlinkSync(join(server.home, "not-yours.txt"), join(work, "escape.txt"));

    const dir = mkTemp("link-");
    const result = await cli(["runs", "download", runId, "steps/write/work/escape.txt", "-o", join(dir, "x"), "--json"], {
      url: server.url,
    });
    expect(result.code).toBe(1);
    expect(parsed(result).code).toBe("file_not_found");
    expect(existsSync(join(dir, "x"))).toBe(false);
  });

  test("a missing file is the API's error object and exit 1", async () => {
    const result = await cli(["runs", "download", runId, "steps/write/attempts/1/outputs/nope", "--json"], {
      url: server.url,
    });
    expect(result.code).toBe(1);
    expect(parsed(result).code).toBe("file_not_found");
  });
});

describe("runs archive", () => {
  test("the whole run unpacks to the same files, with the same hashes", async () => {
    const dir = mkTemp("archive-");
    const file = join(dir, "run.tar.gz");
    const result = await cli(["runs", "archive", runId, "-o", file], { url: server.url });
    expect(result.code).toBe(0);

    const listing = Bun.spawnSync(["tar", "tzf", file]);
    expect(listing.exitCode).toBe(0);
    const names = listing.stdout.toString().split("\n").filter(Boolean);
    expect(names.includes("run.json")).toBe(true);
    expect(names.includes("steps/write/attempts/1/outputs/report")).toBe(true);

    const unpack = join(dir, "unpacked");
    mkdirSync(unpack, { recursive: true });
    expect(Bun.spawnSync(["tar", "xzf", file, "-C", unpack]).exitCode).toBe(0);
    expect(sha256Hex(new Uint8Array(readFileSync(join(unpack, "steps/write/attempts/1/outputs/report"))))).toBe(
      sha256Hex(new Uint8Array(readFileSync(join(runDir(runId), "steps/write/attempts/1/outputs/report")))),
    );
  });

  test("one step's archive is that step, and the name says so", async () => {
    const dir = mkTemp("step-");
    const file = join(dir, "step.tar.gz");
    expect((await cli(["runs", "archive", runId, "--step", "write", "-o", file], { url: server.url })).code).toBe(0);
    const names = Bun.spawnSync(["tar", "tzf", file]).stdout.toString().split("\n").filter(Boolean);
    expect(names.includes("work/chunks/chunks.jsonl")).toBe(true);
    expect(names.some((name) => name.startsWith("run.json"))).toBe(false);
  });

  test("it says how many links it skipped rather than quietly dropping them", async () => {
    const work = join(runDir(runId), "steps/write/work");
    if (!existsSync(join(work, "escape.txt"))) {
      writeFileSync(join(server.home, "not-yours.txt"), "no\n");
      symlinkSync(join(server.home, "not-yours.txt"), join(work, "escape.txt"));
    }
    const dir = mkTemp("skipped-");
    const result = await cli(["runs", "archive", runId, "-o", join(dir, "a.tar.gz")], { url: server.url });
    expect(result.code).toBe(0);
    expect(result.stdout).toInclude("skipped");
    const names = Bun.spawnSync(["tar", "tzf", join(dir, "a.tar.gz")]).stdout.toString();
    expect(names).not.toInclude("escape.txt");
  });
});
