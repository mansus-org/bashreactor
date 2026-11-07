// The round trip (BASHR-47): a real `ingest-urls` run, its files back out through the API and
// through the CLI, and the archive unpacked — every one of them hashed. A download command that
// re-encodes, truncates at a chunk boundary, or renames on the way through a tarball still produces
// plausible-looking files, so nothing short of a hash of bytes that came off a real run proves the
// routes agree with the disk.
//
// The run is the real pipeline at examples/ingest/ingest-urls.yaml, run by the real engine, against
// the same fake site and fake embeddings route examples/ingest/ingest.test.ts uses: no network, no
// key, no cost. Nothing here reaches into the API — the server is a real one on a real socket, and
// the CLI is a real subprocess, because the thing under test is bytes crossing two boundaries.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { Server } from "./helpers.ts";
import { ADMIN_TOKEN, cli, parsed, sha256Hex, startServer } from "./helpers.ts";

const INGEST_DIR = join(import.meta.dir, "../../../examples/ingest");
const PIPELINE = join(INGEST_DIR, "ingest-urls.yaml");
const dim = 16;

const kube = Array.from({ length: 240 }, (_, i) => `kubernetes pod scheduler node${i % 7}`).join(" ");
const bread = Array.from({ length: 180 }, (_, i) => `sourdough starter flour loaf${i % 5}`).join(" ");

// The same bag-of-words vector for a chunk and for a query, so nearness means shared words. Copied
// from examples/ingest/ingest.test.ts, which is the fake this run is meant to be the same one as.
function vectorOf(text: string): number[] {
  const v: number[] = Array.from({ length: dim }, () => 0);
  for (const word of text.toLowerCase().split(/\s+/)) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) % dim;
    v[h]! += 1;
  }
  return v;
}

const site = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/kube") {
      return new Response(
        `<!doctype html><html><head><title>Kube notes</title></head>
         <body><main><article><h1>Kube notes</h1><p>${kube}</p></article></main></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (pathname === "/bread") return new Response(bread, { headers: { "content-type": "text/plain" } });
    if (pathname === "/v1/embeddings") {
      const body = (await request.json()) as { input: string[] };
      return Response.json({ data: body.input.map((text, index) => ({ index, embedding: vectorOf(text) })) });
    }
    return new Response("?", { status: 400 });
  },
});
const base = `http://127.0.0.1:${site.port}`;

let server: Server;
const dirs: string[] = [];
let runId = "";

const runDir = () => join(server.home, "runs", runId);
const get = (path: string) =>
  fetch(`${server.url}${path}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const hashFile = (path: string): string => sha256Hex(readFileSync(path));

/** The CLI, pointed at this server rather than at whatever the developer's shell has configured. */
const runCli = (args: readonly string[]) => cli(args, { url: server.url });

/** Every file under `dir`, as `relative path -> sha256`, so a tarball can be checked member by member. */
function hashes(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path, name);
      else found[name] = hashFile(path);
    }
  };
  walk(dir, "");
  return found;
}

beforeAll(async () => {
  server = await startServer();

  const started = await cli(
    [
      "runs",
      "start",
      PIPELINE,
      "--input",
      `urls=${base}/kube\n${base}/bread`,
      "--input",
      `endpoint=${base}/v1/embeddings`,
      "--input",
      "model=fake-model",
      "--input",
      "chunk_words=50",
      "--input",
      "overlap=10",
      "--input",
      "batch=4",
      "--input",
      "prefix=",
      "--wait",
      "--json",
    ],
    { cwd: INGEST_DIR, url: server.url },
  );
  if (started.code !== 0) throw new Error(`the ingest run failed: ${started.stderr}`);
  runId = parsed(started).id as string;
}, 180_000);

afterAll(async () => {
  site.stop(true);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  await server.stop();
});

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "bashreactor-round-trip-"));
  dirs.push(dir);
  return dir;
};

describe("an ingest run's files, all the way back out", () => {
  let manifest: Record<string, any>;
  /** Every file the manifest lists, as `path -> the sha256 of the same path on the server's disk`. */
  let onDisk: Record<string, string> = {};

  beforeAll(async () => {
    const response = await get(`/v1/runs/${runId}/files`);
    expect(response.status).toBe(200);
    manifest = (await response.json()) as Record<string, any>;
    expect(manifest.status).toBe("succeeded");

    for (const attempt of Object.values<any>(manifest.steps)) {
      for (const entry of attempt.attempts) {
        for (const file of [...entry.outputs, ...entry.work, ...(entry.log ? [entry.log] : [])]) {
          onDisk[file.path] = hashFile(join(runDir(), file.path));
        }
      }
    }
  });

  test("the run left the files it claims, and they are not empty", () => {
    // The embeddings file is the one a person actually wants out of this pipeline, and the log is the
    // one they want when it goes wrong.
    const paths = Object.keys(onDisk);
    expect(paths.some((p) => p.endsWith("outputs/embeddings"))).toBe(true);
    expect(paths.some((p) => p.endsWith("attempts/1/log"))).toBe(true);
    expect(paths.length).toBeGreaterThan(3);
  });

  test("each file downloaded through the API hashes to the bytes on disk", async () => {
    for (const [path, expected] of Object.entries(onDisk)) {
      const response = await get(`/v1/runs/${runId}/file?path=${encodeURIComponent(path)}`);
      expect(response.status).toBe(200);
      expect(hash(new Uint8Array(await response.arrayBuffer()))).toBe(expected);
    }
  });

  test("each file downloaded with the CLI hashes to the bytes on disk", async () => {
    const dir = temp();
    const downloaded: Record<string, string> = {};
    for (const path of Object.keys(onDisk)) {
      const dest = join(dir, path);
      mkdirSync(dirname(dest), { recursive: true });
      const result = await runCli(["runs", "download", runId, path, "--out", dest, "--json"]);
      expect([path, result.code, result.stderr]).toEqual([path, 0, ""]);
      downloaded[path] = hashFile(dest);
    }

    expect(Object.keys(downloaded).length).toBe(Object.keys(onDisk).length);
    for (const [path, expected] of Object.entries(onDisk)) {
      expect([path, downloaded[path]]).toEqual([path, expected]);
    }
  });

  test("the archive unpacks to the same hashes", async () => {
    const dir = temp();
    const archive = join(dir, "run.tar.gz");
    const result = await runCli(["runs", "archive", runId, "--out", archive, "--json"]);
    expect(result.code).toBe(0);

    const unpacked = join(dir, "unpacked");
    mkdirSync(unpacked, { recursive: true });
    const tar = Bun.spawn(["tar", "-xzf", archive, "-C", unpacked]);
    expect(await tar.exited).toBe(0);

    const members = hashes(unpacked);
    for (const [path, expected] of Object.entries(onDisk)) {
      expect([path, members[path]]).toEqual([path, expected]);
    }
  });

  test("a step's archive holds that step and nothing else", async () => {
    const dir = temp();
    const archive = join(dir, "embed.tar.gz");
    const result = await runCli(["runs", "archive", runId, "--step", "embed", "--out", archive, "--json"]);
    expect(result.code).toBe(0);

    const unpacked = join(dir, "unpacked");
    mkdirSync(unpacked, { recursive: true });
    expect(await Bun.spawn(["tar", "-xzf", archive, "-C", unpacked]).exited).toBe(0);

    // Names are relative to the step, so this unpacks to the step's own tree, and nothing belonging
    // to `fetch` or `chunk` is in it.
    const members = hashes(unpacked);
    expect(Object.keys(members).length).toBeGreaterThan(0);
    expect(members["attempts/1/log"]).toBe(onDisk["steps/embed/attempts/1/log"]);
    expect(Object.keys(members).some((p) => p.startsWith("attempts/") || p.startsWith("work/"))).toBe(true);
    expect(Object.keys(members).some((p) => p.includes("fetch") || p.includes("chunk"))).toBe(false);
  });

  test("the manifest itself comes back, and it is the manifest that was read", async () => {
    const response = await get(`/v1/runs/${runId}/files`);
    const again = new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()));
    expect(JSON.parse(again)).toEqual(manifest);
    writeFileSync(join(temp(), "manifest.json"), again);
  });
});
