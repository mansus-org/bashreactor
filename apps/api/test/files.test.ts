// A run's files (BASHR-47): three read-only routes over one run's own directory. What matters here
// is not that a file arrives — that it arrives *only from inside the run directory*, that nothing
// follows a symlink a block planted, that the bytes are streamed rather than read, and that a
// download can never be rendered by a browser on the app's origin.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blockFile, pipelineYaml, startApi } from "./helpers.ts";

const server = startApi();
afterAll(() => server.cleanup());

const body = async (response: Response) => (await response.json()) as Record<string, any>;

const FILE_BLOCK = blockFile(
  "writes-files",
  `name: writes-files
description: Write one file output and a few files in its work directory.
outputs:
  report:
    type: file
  lines:
    type: integer`,
  `printf 'name,value\\nembeddings,3\\n' > "$OUTPUT_REPORT"
printf '3' > "$OUTPUT_LINES"
mkdir -p chunks
printf '{"chunk":0}\\n{"chunk":1}\\n' > chunks/chunks.jsonl
mkdir -p chunks/empty
printf '<!doctype html><script>alert(1)</script>' > chunks/page.html`,
);

const FILE_PIPELINE = pipelineYaml(
  "files-pipeline",
  "  write:\n    uses: writes-files@1\n",
  "outputs:\n  report: ${{ steps.write.outputs.report }}\n  lines: ${{ steps.write.outputs.lines }}\n",
);

const SLOW_BLOCK = blockFile(
  "slow-writer",
  `name: slow-writer
description: Write a file and then keep going, so a reader can catch it half-written.
outputs:
  report:
    type: file`,
  `printf 'part-one' > "$OUTPUT_REPORT"
sleep 6
printf '-part-two' >> "$OUTPUT_REPORT"`,
);
const SLOW_PIPELINE = pipelineYaml("slow-files-pipeline", "  write:\n    uses: slow-writer@1\n");

const runDir = (id: string) => join(server.root, "runs", id);
const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(typeof bytes === "string" ? bytes : new Uint8Array(bytes)).digest("hex");
const diskSha = (path: string) => sha256(new Uint8Array(readFileSync(path)));

/**
 * The test PATH holds only the binaries SPEC 2.6 demands a block may call. These are for the test
 * block's own tidying, not anything a real block would need.
 */
function allow(...names: string[]): void {
  for (const name of names) {
    const target = join(server.root, "bin", name);
    if (existsSync(target)) continue;
    const real = (process.env.PATH ?? "").split(":").map((dir) => join(dir, name)).find((c) => existsSync(c));
    if (real === undefined) throw new Error(`this suite needs ${name} on PATH`);
    symlinkSync(real, target);
  }
}
allow("mkdir", "sleep");

/** A path the file route is asked for, percent-encoded the way a client would encode it. */
const fileUrl = (id: string, path: string) => `/v1/runs/${id}/file?path=${encodeURIComponent(path)}`;

let runId = "";
let otherRunId = "";

async function start(pipeline: string): Promise<string> {
  const response = await server.call("POST", "/v1/runs", { body: { pipeline } });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** The hostile things a block can leave behind, planted where a block would have planted them. */
function plantHostiles(id: string): void {
  const dir = runDir(id);
  // A real tokens.json next to the run, so a symlink into the home directory has something to find.
  writeFileSync(join(server.root, "tokens.json"), JSON.stringify({ tokens: [{ name: "whoever" }] }));
  writeFileSync(join(server.root, "secret-outside.txt"), "not yours\n");

  const work = join(dir, "steps/write/work");
  symlinkSync(join(server.root, "tokens.json"), join(work, "tokens.json"));
  symlinkSync(join(server.root, "secret-outside.txt"), join(work, "note.txt"));
  symlinkSync(join(server.root, "store"), join(work, "the-store"));
  symlinkSync(join(server.root, "runs", otherRunId), join(work, "other-run"));
  symlinkSync("/etc/passwd", join(work, "passwd"));

  // A symlinked directory: the walk must report it and must not descend through it.
  const outside = join(server.root, "outside-dir");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "private.txt"), "outside bytes\n");
  symlinkSync(outside, join(work, "linked-dir"));

  // A link reached through a real directory, so the escape is not obvious from the first component.
  mkdirSync(join(work, "real-dir"), { recursive: true });
  symlinkSync(join(server.root, "secret-outside.txt"), join(work, "real-dir", "via-dir-link"));
}

beforeAll(async () => {
  for (const block of [FILE_BLOCK, SLOW_BLOCK]) {
    const created = await server.call("POST", `/v1/blocks/${block.name}/versions`, { body: { content: block.content } });
    expect(created.status).toBe(201);
  }
  for (const [name, yaml] of [
    ["files-pipeline", FILE_PIPELINE],
    ["slow-files-pipeline", SLOW_PIPELINE],
  ] as const) {
    expect((await server.call("POST", `/v1/pipelines/${name}/versions`, { body: { yaml } })).status).toBe(201);
  }

  otherRunId = await start("files-pipeline");
  expect((await server.waitForRun(otherRunId)).status).toBe("succeeded");
  runId = await start("files-pipeline");
  expect((await server.waitForRun(runId)).status).toBe("succeeded");
  plantHostiles(runId);
});

describe("who may read a run's files", () => {
  for (const path of ["/files", "/file?path=run.json", "/archive"]) {
    test(`no token is 401 on ${path}`, async () => {
      const response = await server.call("GET", `/v1/runs/${runId}${path}`, { token: null });
      expect(response.status).toBe(401);
      expect((await body(response)).code).toBe("unauthenticated");
    });
  }

  test("a read-scope token is enough for all three", async () => {
    const token = await server.agentToken("read");
    for (const path of ["/files", "/file?path=run.json", "/archive"]) {
      const response = await server.call("GET", `/v1/runs/${runId}${path}`, { token });
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }
  });

  test("an unknown run is the normal run_not_found on all three", async () => {
    for (const path of ["/files", "/file?path=run.json", "/archive"]) {
      const response = await server.call("GET", `/v1/runs/20261104T101500Z-3fa9c2d1${path}`);
      expect(response.status).toBe(404);
      expect((await body(response)).code).toBe("run_not_found");
    }
  });

  test("an unknown step and attempt are the normal 404s", async () => {
    const noStep = await server.call("GET", `/v1/runs/${runId}/files?step=nope`);
    expect(noStep.status).toBe(404);
    expect((await body(noStep)).code).toBe("step_not_found");

    const noAttempt = await server.call("GET", `/v1/runs/${runId}/files?step=write&attempt=9`);
    expect(noAttempt.status).toBe(404);
    expect((await body(noAttempt)).code).toBe("attempt_not_found");

    const archiveNoStep = await server.call("GET", `/v1/runs/${runId}/archive?step=nope`);
    expect(archiveNoStep.status).toBe(404);
    expect((await body(archiveNoStep)).code).toBe("step_not_found");

    const archiveNoAttempt = await server.call("GET", `/v1/runs/${runId}/archive?step=write&attempt=9`);
    expect(archiveNoAttempt.status).toBe(404);
    expect((await body(archiveNoAttempt)).code).toBe("attempt_not_found");
  });
});

describe("the manifest", () => {
  test("the declared outputs are listed by name, with the attempt that made them", async () => {
    const manifest = await body(await server.call("GET", `/v1/runs/${runId}/files`));
    expect(manifest.run).toBe(runId);
    expect(manifest.status).toBe("succeeded");
    expect(manifest.partial).toBe(false);

    const report = manifest.outputs.find((entry: any) => entry.name === "report");
    expect(report).toEqual({
      name: "report",
      type: "file",
      step: "write",
      attempt: 1,
      path: "steps/write/attempts/1/outputs/report",
      size: 24,
    });
    // `lines` is an integer output, so it is not a file and is not listed here.
    expect(manifest.outputs.find((entry: any) => entry.name === "lines")).toBeUndefined();
  });

  test("a declared output whose file is gone is listed with a null size, not dropped", async () => {
    const path = join(runDir(runId), "steps/write/attempts/1/outputs/report");
    renameSync(path, `${path}.held`);
    try {
      const manifest = await body(await server.call("GET", `/v1/runs/${runId}/files`));
      expect(manifest.outputs.find((entry: any) => entry.name === "report").size).toBeNull();
    } finally {
      renameSync(`${path}.held`, path);
    }
  });

  test("a run that is still running says so, and its files are marked partial", async () => {
    const id = await start("slow-files-pipeline");
    try {
      const log = join(runDir(id), "steps/write/attempts/1/outputs/report");
      const deadline = Date.now() + 10_000;
      while (!existsSync(log) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(log)).toBe(true);

      const manifest = await body(await server.call("GET", `/v1/runs/${id}/files`));
      expect(manifest.status).toBe("running");
      expect(manifest.partial).toBe(true);
      expect(manifest.steps.write.attempts[0].partial).toBe(true);

      const download = await server.call("GET", fileUrl(id, "steps/write/attempts/1/outputs/report"));
      expect(download.headers.get("x-run-partial")).toBe("true");
      expect(await download.text()).toBe("part-one");
    } finally {
      await server.call("POST", `/v1/runs/${id}/cancel`);
      await server.waitForRun(id);
    }
  }, 30_000);

  test("steps are walked with sizes from the disk, recursively, and links without sizes", async () => {
    const manifest = await body(await server.call("GET", `/v1/runs/${runId}/files`));
    const attempt = manifest.steps.write.attempts[0];
    expect(attempt.n).toBe(1);
    expect(attempt.status).toBe("succeeded");
    expect(attempt.partial).toBe(false);

    const logPath = "steps/write/attempts/1/log";
    expect(attempt.log).toEqual({ path: logPath, size: lstatSync(join(runDir(runId), logPath)).size });

    expect(attempt.outputs).toEqual([
      { name: "lines", path: "steps/write/attempts/1/outputs/lines", size: 1 },
      { name: "report", path: "steps/write/attempts/1/outputs/report", size: 24 },
    ]);

    const byPath = new Map(attempt.work.map((entry: any) => [entry.path, entry]));
    expect(byPath.get("steps/write/work/chunks/chunks.jsonl")).toEqual({
      path: "steps/write/work/chunks/chunks.jsonl",
      size: 24,
    });
    // A link is visible — a block that plants one must not be able to hide it — and it has no size.
    expect(byPath.get("steps/write/work/tokens.json")).toEqual({ path: "steps/write/work/tokens.json", kind: "link" });
    expect(byPath.get("steps/write/work/linked-dir")).toEqual({ path: "steps/write/work/linked-dir", kind: "link" });
    // Nothing from beyond a link is listed, and an empty directory is walked, not listed as a file.
    expect(byPath.has("steps/write/work/linked-dir/private.txt")).toBe(false);
    expect(byPath.has("steps/write/work/chunks/empty")).toBe(false);
    expect(byPath.has("steps/write/work/other-run")).toBe(true);
  });

  test("scope narrows what is walked, and step and attempt narrow which", async () => {
    const outputsOnly = await body(await server.call("GET", `/v1/runs/${runId}/files?scope=outputs`));
    const attempt = outputsOnly.steps.write.attempts[0];
    expect(attempt.outputs.length).toBe(2);
    expect(attempt.work).toBeUndefined();
    expect(attempt.log).toBeUndefined();

    const workOnly = await body(await server.call("GET", `/v1/runs/${runId}/files?scope=work`));
    expect(workOnly.steps.write.attempts[0].work.length).toBeGreaterThan(0);
    expect(workOnly.steps.write.attempts[0].outputs).toBeUndefined();

    const logsOnly = await body(await server.call("GET", `/v1/runs/${runId}/files?scope=logs`));
    expect(logsOnly.steps.write.attempts[0].log.path).toBe("steps/write/attempts/1/log");
    expect(logsOnly.steps.write.attempts[0].work).toBeUndefined();

    const narrowed = await body(await server.call("GET", `/v1/runs/${runId}/files?step=write&attempt=1`));
    expect(Object.keys(narrowed.steps)).toEqual(["write"]);
    expect(narrowed.steps.write.attempts.length).toBe(1);
    expect(narrowed.outputs.length).toBe(1);

    const badScope = await server.call("GET", `/v1/runs/${runId}/files?scope=everywhere`);
    expect(badScope.status).toBe(422);
    expect((await body(badScope)).code).toBe("type_mismatch");
  });
});

describe("one file", () => {
  const path = "steps/write/work/chunks/chunks.jsonl";

  test("the bytes are the file's, and the headers make it a download and never a page", async () => {
    const response = await server.call("GET", fileUrl(runId, path));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="chunks.jsonl"');
    expect(response.headers.get("content-length")).toBe(String(lstatSync(join(runDir(runId), path)).size));
    expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(diskSha(join(runDir(runId), path)));
  });

  test("an HTML file a block wrote is not rendered: it is an attachment with a neutral type", async () => {
    const response = await server.call("GET", fileUrl(runId, "steps/write/work/chunks/page.html"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(await response.text()).toContain("<script>");
  });

  test("a filename that would break the header is made harmless", async () => {
    const dir = join(runDir(runId), "steps/write/work");
    const nasty = 'evil"name\r\nX-Evil: 1.txt';
    writeFileSync(join(dir, nasty), "x");
    try {
      const response = await server.call("GET", fileUrl(runId, `steps/write/work/${nasty}`));
      expect(response.status).toBe(200);
      const disposition = response.headers.get("content-disposition") ?? "";
      expect(disposition.includes("\r")).toBe(false);
      expect(disposition.includes("\n")).toBe(false);
      expect(disposition.match(/"/g)?.length).toBe(2);
    } finally {
      rmSync(join(dir, nasty), { force: true });
    }
  });

  test("a missing file is file_not_found, and a directory says to use the archive", async () => {
    const missing = await server.call("GET", fileUrl(runId, "steps/write/attempts/1/outputs/nope"));
    expect(missing.status).toBe(404);
    expect((await body(missing)).code).toBe("file_not_found");

    const directory = await server.call("GET", fileUrl(runId, "steps/write/work"));
    expect(directory.status).toBe(400);
    const error = await body(directory);
    expect(error.code).toBe("bad_request");
    expect(error.message).toInclude("archive");

    const noPath = await server.call("GET", `/v1/runs/${runId}/file`);
    expect(noPath.status).toBe(400);
    expect((await body(noPath)).code).toBe("bad_request");
  });

  test("a path with no file in it is refused, however it is written", async () => {
    const attempts = [
      "../tokens.json",
      "..%2ftokens.json",
      "%2e%2e%2ftokens.json",
      "%252e%252e%252ftokens.json",
      "steps/../../tokens.json",
      "steps/write/../../../tokens.json",
      "steps//write/work",
      "steps/write/./work",
      "/etc/passwd",
      "%2fetc%2fpasswd",
      "steps\u0000write/work",
      "",
    ];
    for (const attempt of attempts) {
      const response = await server.call("GET", `/v1/runs/${runId}/file?path=${encodeURIComponent(attempt)}`);
      expect([400, 404].includes(response.status)).toBe(true);
      expect(["file_not_found", "bad_request"].includes((await body(response)).code)).toBe(true);
    }
  });

  test("a symlink a block created is not served, whichever way it escapes", async () => {
    const escapes = [
      "steps/write/work/tokens.json",
      "steps/write/work/note.txt",
      "steps/write/work/the-store",
      "steps/write/work/other-run",
      "steps/write/work/passwd",
      "steps/write/work/linked-dir",
      "steps/write/work/linked-dir/private.txt",
      "steps/write/work/real-dir/via-dir-link",
    ];
    for (const escape of escapes) {
      const response = await server.call("GET", fileUrl(runId, escape));
      expect(response.status).toBe(404);
      const error = await body(response);
      expect(error.code).toBe("file_not_found");
      // A path *through* a link is refused as the missing file it is; the link itself says so.
      if (!escape.startsWith("steps/write/work/linked-dir/")) expect(error.message).toInclude("link");
    }
  });
});

/** Every regular file under a directory, by its relative path, with its sha256. */
function hashesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, prefix: string): void => {
    for (const name of readdirSync(at).toSorted()) {
      const absolute = join(at, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute, relative);
      else if (stat.isFile() && name !== "archive.tar.gz") out[relative] = diskSha(absolute);
    }
  };
  walk(dir, "");
  return out;
}

describe("the archive", () => {
  const dirs: string[] = [];

  /** Unpack an archive the way a person would, with the system's own tar, and return the directory. */
  async function untar(response: Response, name: string): Promise<string> {
    const dir = join(server.root, `untar-${name}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const file = join(dir, "archive.tar.gz");
    writeFileSync(file, new Uint8Array(await response.arrayBuffer()));
    // A tar the system cannot read is not an archive; and nothing may escape the directory either.
    expect(Bun.spawnSync(["tar", "tzf", file]).exitCode).toBe(0);
    const unpack = Bun.spawnSync(["tar", "xzf", file, "-C", dir]);
    expect(unpack.exitCode).toBe(0);
    return dir;
  }

  test("the whole run unpacks to the same files, with the same hashes", async () => {
    const response = await server.call("GET", `/v1/runs/${runId}/archive`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${runId}.tar.gz"`);

    const unpacked = hashesUnder(await untar(response, "run"));
    expect(Object.keys(unpacked).length).toBeGreaterThan(5);
    expect(unpacked).toEqual(hashesUnder(runDir(runId)));
  });

  test("a symlink escaping the run directory is not in the archive, and the count says it was skipped", async () => {
    const response = await server.call("GET", `/v1/runs/${runId}/archive`);
    expect(Number(response.headers.get("x-run-skipped"))).toBeGreaterThanOrEqual(6);

    const dir = await untar(response, "links");
    const listing = Bun.spawnSync(["tar", "tzf", join(dir, "archive.tar.gz")]).stdout.toString();
    for (const name of [
      "steps/write/work/tokens.json",
      "steps/write/work/note.txt",
      "steps/write/work/the-store",
      "steps/write/work/other-run",
      "steps/write/work/passwd",
      "steps/write/work/linked-dir",
    ]) {
      expect(listing).not.toInclude(name);
    }
    // The bytes that were only reachable through a link never left the home directory.
    expect(readFileSync(join(server.root, "secret-outside.txt"), "utf8")).toBe("not yours\n");
    expect(listing).not.toInclude("private.txt");
  });

  test("an empty directory and a zero-byte file still get an entry", async () => {
    writeFileSync(join(runDir(runId), "steps/write/work/zero.bin"), "");
    const response = await server.call("GET", `/v1/runs/${runId}/archive?step=write`);
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${runId}-write.tar.gz"`);
    const dir = await untar(response, "step");
    expect(lstatSync(join(dir, "work/chunks/empty")).isDirectory()).toBe(true);
    expect(readFileSync(join(dir, "work/zero.bin"), "utf8")).toBe("");
  });

  test("one attempt's archive holds that attempt and nothing else", async () => {
    const response = await server.call("GET", `/v1/runs/${runId}/archive?step=write&attempt=1`);
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${runId}-write-attempt1.tar.gz"`);
    expect(Object.keys(hashesUnder(await untar(response, "attempt"))).toSorted()).toEqual([
      "log",
      "outputs/lines",
      "outputs/report",
    ]);
  });

  test("?attempt without ?step is a bad request", async () => {
    const response = await server.call("GET", `/v1/runs/${runId}/archive?attempt=1`);
    expect(response.status).toBe(400);
    expect((await body(response)).code).toBe("bad_request");
  });

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
});

describe("a big file streams", () => {
  // The pod has 256 MB. A route that read a file into memory before answering would die here, so this
  // asks for a file bigger than the whole container and checks the process barely notices.
  const BIG = 300 * 1024 * 1024;

  test(`a ${BIG / 1024 / 1024} MB file arrives whole without moving into memory`, async () => {
    const path = join(runDir(runId), "steps/write/work/big.bin");
    writeFileSync(path, "");
    truncateSync(path, BIG);
    try {
      Bun.gc(true);
      const before = process.memoryUsage().rss;
      let peak = before;
      const response = await server.call("GET", fileUrl(runId, "steps/write/work/big.bin"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(String(BIG));

      let received = 0;
      const reader = response.body!.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received % (8 << 20) < chunk.value.byteLength) peak = Math.max(peak, process.memoryUsage().rss);
      }
      const grew = peak - before;
      expect(received).toBe(BIG);
      expect(grew).toBeLessThan(64 * 1024 * 1024);
    } finally {
      rmSync(path, { force: true });
    }
  }, 120_000);
});
