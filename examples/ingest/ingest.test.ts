// The ingestion pipeline, run through the real engine against a fake local site and a fake
// embeddings route: no network, no key, no cost. The real route is exercised by hand (README).
// uv needs a Python it can run, as for every uv block; the blocks use the standard library only.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../apps/engine/src/engine.ts";
import { FsRunStore } from "../../apps/engine/src/run-store.ts";

const here = import.meta.dir;
const pipeline = join(here, "ingest-urls.yaml");
const dim = 16;

const kube = Array.from({ length: 240 }, (_, i) => `kubernetes pod scheduler node${i % 7}`).join(" ");
const bread = Array.from({ length: 180 }, (_, i) => `sourdough starter flour loaf${i % 5}`).join(" ");

// The same bag-of-words vector for a chunk and for a query, so nearness means shared words.
function vectorOf(text: string): number[] {
  const v: number[] = Array.from({ length: dim }, () => 0);
  for (const word of text.toLowerCase().split(/\s+/)) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) % dim;
    v[h]! += 1;
  }
  return v;
}

const cosine = (a: number[], b: number[]) => {
  const dot = a.reduce((s, x, i) => s + x * b[i]!, 0);
  return dot / (Math.hypot(...a) * Math.hypot(...b));
};

let failEmbedCall = 0; // fail this embeddings request (1-based) once, then answer normally
let embedCalls = 0;
let embeddedTexts: string[] = [];
let authHeaders: (string | null)[] = [];

const site = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/kube") {
      return new Response(
        `<!doctype html><html><head><title>Kube notes</title><style>.x{}</style><script>var secret="SCRIPTTEXT"</script></head>
         <body><nav>NAVTEXT home about</nav><main><article><h1>Kube notes</h1><p>${kube}</p></article></main><footer>FOOTERTEXT</footer></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (pathname === "/bread") {
      return new Response(bread, { headers: { "content-type": "text/plain" } });
    }
    if (pathname === "/gone") return new Response("no", { status: 404 });
    if (pathname === "/v1/embeddings") {
      embedCalls += 1;
      authHeaders.push(request.headers.get("authorization"));
      // What a CDN in front of a real gateway does to a bare urllib.
      if (request.headers.get("user-agent")?.startsWith("Python-urllib")) return new Response("blocked", { status: 403 });
      if (embedCalls === failEmbedCall) return new Response("boom", { status: 500 });
      const body = (await request.json()) as { model: string; input: string[] };
      embeddedTexts.push(...body.input);
      return Response.json({ data: body.input.map((text, index) => ({ index, embedding: vectorOf(text) })) });
    }
    return new Response("?", { status: 400 });
  },
});
const base = `http://127.0.0.1:${site.port}`;

const roots: string[] = [];
afterAll(() => {
  site.stop(true);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function newEngine(key: string | undefined) {
  const root = mkdtempSync(join(tmpdir(), "bashreactor-ingest-"));
  roots.push(root);
  const env = key === undefined ? {} : { EMBEDDINGS_API_KEY: key };
  return { root, store: new FsRunStore(root), engine: new Engine({ store: new FsRunStore(root), env }) };
}

function reset(failOn = 0) {
  failEmbedCall = failOn;
  embedCalls = 0;
  embeddedTexts = [];
  authHeaders = [];
}

const inputs = (urls: string[], extra: Record<string, string | number> = {}) => ({
  urls: urls.join("\n"),
  endpoint: `${base}/v1/embeddings`,
  model: "fake-model",
  chunk_words: 50,
  overlap: 10,
  batch: 4,
  ...extra,
});

function jsonl(path: string): any[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("two good URLs and a 404: the good ones are embedded, the 404 is reported", async () => {
  reset();
  const { root, engine } = newEngine("sk-test-secret-123");
  const record = await engine.start(pipeline, inputs([`${base}/kube`, `${base}/gone`, `${base}/bread`]));
  const final = await engine.drive(record.id);
  expect(final.status).toBe("succeeded");
  const outputs = final.outputs!;

  const run = join(root, "runs", record.id);
  const out = (name: string) => join(run, String(outputs[name]));
  const rows = jsonl(out("embeddings"));
  const manifest = JSON.parse(readFileSync(out("manifest"), "utf8"));

  expect(outputs.urls_ok).toBe(2);
  expect(outputs.urls_failed).toBe(1);
  expect(outputs.dim).toBe(dim);
  expect(rows.length).toBe(outputs.chunks as number);
  expect(manifest.urls.map((u: any) => [u.url.replace(base, ""), u.status, u.http, u.chunks > 0])).toEqual([
    ["/kube", "ok", 200, true],
    ["/gone", "failed", 404, false],
    ["/bread", "ok", 200, true],
  ]);
  expect(manifest.model).toBe("fake-model");
  expect(manifest.dim).toBe(dim);

  // One line per chunk, with a stable id made of the url and the index.
  expect(rows.map((r) => r.id)).toEqual(rows.map((r) => `${r.url}#${r.index}`));
  expect(new Set(rows.map((r) => r.url))).toEqual(new Set([`${base}/kube`, `${base}/bread`]));
  expect(rows.every((r) => r.model === "fake-model" && r.dim === dim && r.embedding.length === dim)).toBe(true);
  expect(rows[0].index).toBe(0);

  // Page furniture is gone, plain text passed through.
  const all = rows.map((r) => r.text).join(" ");
  for (const noise of ["SCRIPTTEXT", "NAVTEXT", "FOOTERTEXT"]) expect(all).not.toContain(noise);
  expect(all).toContain("sourdough starter");

  // The 404 was asked for once: a permanent failure does not spend the retry budget.
  expect(final.steps.fetch!.attempts_used).toBe(1);

  // The key reached the route and nothing on disk.
  expect(authHeaders.every((h) => h === "Bearer sk-test-secret-123")).toBe(true);
  const files = readdirSync(run, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
  for (const file of files) {
    expect(readFileSync(join(file.parentPath, file.name)).includes("sk-test-secret-123")).toBe(false);
  }

  // A small retrieval check: the nearest chunk to a question is from the page about it.
  const query = vectorOf("how long should a sourdough starter rest");
  const best = rows.reduce((a, b) => (cosine(query, a.embedding) >= cosine(query, b.embedding) ? a : b));
  expect(best.url).toBe(`${base}/bread`);
}, 120_000);

test("a failing embeddings request is retried and only the missing chunks are paid for", async () => {
  reset(2); // request 1 embeds 4 chunks, request 2 answers 500
  const { engine } = newEngine("k");
  const record = await engine.start(pipeline, inputs([`${base}/kube`, `${base}/bread`]));
  const final = await engine.drive(record.id);
  expect(final.status).toBe("succeeded");
  expect(final.steps.embed!.attempts_used).toBe(2);

  const outputs = final.outputs!;
  const chunks = outputs.chunks as number;
  expect(chunks).toBeGreaterThan(4);
  // Every chunk reached the model exactly once across both attempts.
  expect(embeddedTexts.length).toBe(chunks);
  
}, 120_000);

test("a missing key stops the run before it starts, naming the variable", async () => {
  reset();
  const { engine } = newEngine(undefined);
  const started = engine.start(pipeline, inputs([`${base}/bread`]));
  await expect(started).rejects.toMatchObject({ code: "env_missing" });
  await expect(started).rejects.toThrow("EMBEDDINGS_API_KEY");
  expect(embedCalls).toBe(0);
});

test("the block itself refuses with exit 78 when the key is unset", async () => {
  const proc = Bun.spawn(["bash", "-euo", "pipefail", join(here, "embed-chunks.sh")], {
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(78);
  expect(output).toContain("EMBEDDINGS_API_KEY is not set");
});

test("an empty key works for an endpoint that needs none, and sends no Authorization header", async () => {
  reset();
  const { engine } = newEngine("");
  const record = await engine.start(pipeline, inputs([`${base}/bread`]));
  const final = await engine.drive(record.id);
  expect(final.status).toBe("succeeded");
  expect(authHeaders.length).toBeGreaterThan(0);
  expect(authHeaders.every((h) => h === null)).toBe(true);
}, 120_000);

test("when every URL fails the run fails with the reason in the log", async () => {
  reset();
  const { root, engine } = newEngine("k");
  const record = await engine.start(pipeline, inputs([`${base}/gone`]));
  const final = await engine.drive(record.id);
  expect(final.status).toBe("failed");
  expect(final.steps.fetch!.failure?.code).toBe("block_fatal");
  const log = readFileSync(join(root, "runs", record.id, "steps", "fetch", "attempts", "1", "log"), "utf8");
  expect(log).toContain("/gone: failed http 404");
}, 60_000);

