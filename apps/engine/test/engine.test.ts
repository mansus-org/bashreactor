import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../src/engine.ts";
import { FsRunStore } from "../src/run-store.ts";

const examples = new URL("../../../docs/examples/", import.meta.url);
const fixtures = new URL("./fixtures/", import.meta.url);
const pathOf = (url: URL | string) => (typeof url === "string" ? url : fileURLToPath(url));

const roots: string[] = [];
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bashreactor-engine-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("Engine", () => {
  test("runs the worked example end to end with bash, uv and bun blocks", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(pathOf(new URL("word-report.yaml", examples)));
    const final = await engine.drive(record.id);

    expect(final.status).toBe("succeeded");
    expect(final.outputs).toEqual({
      report: "steps/report/attempts/1/outputs/report",
      total_words: 1300,
    });

    const generate = final.steps.generate!;
    expect(generate.status).toBe("succeeded");
    expect(generate.attempts_used).toBe(2);
    expect(generate.outputs).toEqual({
      corpus: "steps/generate/attempts/2/outputs/corpus",
      line_count: 200,
    });

    const count = final.steps.count!;
    expect(count.outputs!.total_words).toBe(1300);
    expect(count.outputs!.top_words).toEqual([
      { word: "amber", count: 114 },
      { word: "larch", count: 114 },
      { word: "fjord", count: 113 },
      { word: "delta", count: 110 },
      { word: "cedar", count: 109 },
    ]);

    const corpus = (await store.readFile(record.id, "steps/generate/attempts/2/outputs/corpus"))!;
    expect(corpus.length).toBe(8230);
    expect(sha256(corpus)).toBe("645ce2d768db71791d28a66e9e5b0f29e8c8799365cbf3f4da0580fa7c041393");

    const counts = (await store.readFile(record.id, "steps/count/attempts/1/outputs/counts"))!;
    expect(counts.length).toBe(135);
    expect(sha256(counts)).toBe("970c6e40e987cbce61f63b5397349f7892a1a29af5fcc12d60d13834f26a6b7b");

    const report = (await store.readFile(record.id, "steps/report/attempts/1/outputs/report"))!;
    expect(report.length).toBe(163);
    expect(sha256(report)).toBe("f64f7bba5dd7e3982fd38008b6cab150f2e438e753f1eca60607be7fa1125075");
    expect(text(report)).toBe(
      [
        "# Word report: 200 lines",
        "",
        "1300 words, 12 distinct.",
        "",
        "| Word | Count |",
        "| --- | --- |",
        "| amber | 114 |",
        "| larch | 114 |",
        "| fjord | 113 |",
        "| delta | 110 |",
        "| cedar | 109 |",
        "",
      ].join("\n"),
    );
    const reportStat = statSync(join(store.layout(record.id).runDir, "steps/report/attempts/1/outputs/report"));
    expect(reportStat.mode & 0o777).toBe(0o444);

    const generateAttempt1 = text((await store.readFile(record.id, "steps/generate/attempts/1/log"))!);
    expect(generateAttempt1).toContain("attempt 1: stopping after 120 lines, asking for a retry");
    const generateAttempt2 = text((await store.readFile(record.id, "steps/generate/attempts/2/log"))!);
    expect(generateAttempt2).toContain("attempt 2: corpus finished");
  }, 120_000);

  test("runs the worked example with lines=50 and fails the gate", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(pathOf(new URL("word-report.yaml", examples)), { lines: 50 });
    const final = await engine.drive(record.id);

    expect(final.status).toBe("failed");
    expect(final.outputs).toBeNull();
    expect(final.steps.generate!.status).toBe("succeeded");
    expect(final.steps.check!.status).toBe("failed");
    expect(final.steps.check!.failure!.code).toBe("block_fatal");
    expect(final.steps.check!.attempts_used).toBe(1);
    expect(final.steps.count!.status).toBe("succeeded");
    expect(final.steps.report!.status).toBe("skipped");
    expect(final.steps.report!.with).toBeNull();
    expect(final.steps.report!.attempts).toEqual([]);
  }, 120_000);

  test("cancels a running run and its attempt", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(pathOf(new URL("slow.yaml", fixtures)));
    const drive = engine.drive(record.id);
    await Bun.sleep(700);
    await engine.cancel(record.id);
    const final = await drive;

    expect(final.status).toBe("cancelled");
    expect(final.cancel_requested_at).not.toBeNull();
    const step = final.steps.slow!;
    expect(step.status).toBe("cancelled");
    expect(step.attempts[0]!.status).toBe("cancelled");
    expect(step.attempts[0]!.failure!.code).toBe("cancelled");
  }, 30_000);

  test("a timeout kills the whole process group", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(pathOf(new URL("spawn-child.yaml", fixtures)));
    const started = Date.now();
    const final = await engine.drive(record.id);
    const elapsed = Date.now() - started;

    expect(final.status).toBe("failed");
    const step = final.steps.spawn!;
    expect(step.status).toBe("failed");
    expect(step.failure!.code).toBe("timeout");
    expect(step.attempts[0]!.status).toBe("failed");
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);

  test("manual retry re-runs a failed step and keeps its work directory", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(pathOf(new URL("flaky.yaml", fixtures)));
    const first = await engine.drive(record.id);

    expect(first.status).toBe("failed");
    expect(first.steps.run!.failure!.code).toBe("retry_requested");
    expect(first.steps.run!.attempts).toHaveLength(1);

    const final = await engine.retry(record.id);
    expect(final.status).toBe("succeeded");
    expect(final.steps.run!.attempts).toHaveLength(2);
    expect(final.steps.run!.status).toBe("succeeded");
    const secondLog = text((await store.readFile(record.id, "steps/run/attempts/2/log"))!);
    expect(secondLog).toContain("second attempt: finished");
  }, 30_000);

  test("streams a step's log by offset", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(pathOf(new URL("flaky.yaml", fixtures)));
    await engine.drive(record.id);

    const first = await engine.readLog(record.id, "run", 1, 0, 1 << 20);
    expect(text(first.data)).toContain("first attempt: asking for a retry");
    expect(first.nextOffset).toBeGreaterThan(0);
    expect(first.nextOffset).toBe(first.data.length);
    expect(first.more).toBe(false);
    const tail = await engine.readLog(record.id, "run", 1, first.nextOffset, 1 << 20);
    expect(tail.data.length).toBe(0);
    expect(tail.more).toBe(false);

    // A small limit pages through the same bytes; the cursor is what was returned, not the file's end.
    const pieces: Uint8Array[] = [];
    let at = 0;
    for (;;) {
      const piece = await engine.readLog(record.id, "run", 1, at, 7);
      expect(piece.nextOffset).toBe(at + piece.data.length);
      pieces.push(piece.data);
      at = piece.nextOffset;
      if (!piece.more) break;
    }
    expect(Buffer.concat(pieces).equals(Buffer.from(first.data))).toBe(true);

    const past = await engine.readLog(record.id, "run", 1, first.nextOffset + 50, 7);
    expect(past).toEqual({ data: new Uint8Array(), nextOffset: first.nextOffset + 50, more: false });
    expect((await engine.readLog(record.id, "run", 9, 0, 7)).data.length).toBe(0);
  }, 30_000);

  test("refuses to start when a required binary is missing", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store, path: "/does/not/exist" });
    await expect(engine.start(pathOf(new URL("flaky.yaml", fixtures)))).rejects.toThrow(
      expect.objectContaining({ code: "runtime_missing" }),
    );
  });
});
