import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../src/engine.ts";
import { FsRunStore } from "../src/run-store.ts";

const fixtures = new URL("./fixtures/", import.meta.url);
const pathOf = (url: URL) => fileURLToPath(url);

const roots: string[] = [];
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bashreactor-pipeline-version-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("a run's pipeline version", () => {
  test("start writes the version it was given into the first run.json", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(pathOf(new URL("ok.yaml", fixtures)), {}, { pipelineVersion: 7 });

    expect(record.pipeline_version).toBe(7);
    const written = JSON.parse(readFileSync(store.layout(record.id).runJson, "utf8")) as Record<string, unknown>;
    expect(written.pipeline_version).toBe(7);
    expect((await store.loadRun(record.id))!.pipeline_version).toBe(7);
  });

  test("a run started without a version, or from inline YAML, records null", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(pathOf(new URL("ok.yaml", fixtures)), {}, { pipelineVersion: null });

    expect(record.pipeline_version).toBeNull();
    expect((await store.loadRun(record.id))!.pipeline_version).toBeNull();

    const absent = await engine.start(pathOf(new URL("ok.yaml", fixtures)));
    expect(absent.pipeline_version).toBeNull();
  });

  test("an old run.json without the field still loads, as null", async () => {
    const root = newRoot();
    const store = new FsRunStore(root);
    const id = "20261111T000000Z-00000000";
    const runDir = join(root, "runs", id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "run.json"),
      JSON.stringify({
        schema: 1,
        id,
        pipeline: "word-report",
        status: "succeeded",
        created_at: "2026-11-11T00:00:00.000Z",
        finished_at: "2026-11-11T00:00:01.000Z",
        cancel_requested_at: null,
        inputs: {},
        outputs: {},
        steps: {},
      }),
    );

    const loaded = await store.loadRun(id);
    expect(loaded).not.toBeNull();
    expect(loaded!.pipeline_version).toBeNull();
  });
});
