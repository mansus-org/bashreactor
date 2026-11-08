import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Store, defaultStoreDir, openStore } from "../src/index.ts";
import { SCHEMA_VERSION } from "../src/schema.ts";

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bashr-store-"));
  dirs.push(dir);
  return dir;
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** A block whose header names it, so a test can store several without repeating the header shape. */
function script(name: string, body: string): string {
  return `#!/usr/bin/env bash\n# ---\n# name: ${name}\n# ---\n${body}\n`;
}

function writeFixture(store: Store): { runId: string } {
  const block = store.addBlockVersion("generate", "#!/usr/bin/env bash\n# ---\n# name: generate\n# ---\n");
  const pipeline = store.savePipeline({
    name: "word-report",
    yaml: "name: word-report\nsteps:\n  generate:\n    uses: generate@1\n",
    parsed: { name: "word-report" },
  });
  const runId = "20261104T101500Z-3fa9c2d1";
  store.createRun({
    id: runId,
    pipeline: { name: pipeline.name, version: pipeline.version },
    status: "running",
    createdAt: "2026-11-04T10:15:00.000Z",
    inputs: { lines: 200 },
    steps: [
      {
        id: "generate",
        name: "Generate the corpus",
        status: "running",
        block: { uses: "generate@1", name: "generate", version: block.version, sha256: block.sha256 },
        needs: [],
        with: { lines: 200 },
        attemptsUsed: 1,
        attempts: [
          { n: 1, status: "running", pid: 48230, pidStart: 91827466, startedAt: "2026-11-04T10:15:00.100Z" },
        ],
      },
    ],
  });
  return { runId };
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("block library", () => {
  test("versions a block by content and never rewrites history", () => {
    const store = new Store(makeDir());
    const v1 = store.addBlockVersion("fetch", "#!/usr/bin/env bash\n# ---\n# name: fetch\n# ---\necho v1\n");
    const again = store.addBlockVersion("fetch", "#!/usr/bin/env bash\n# ---\n# name: fetch\n# ---\necho v1\n");
    const v2 = store.addBlockVersion("fetch", "#!/usr/bin/env bash\n# ---\n# name: fetch\n# ---\necho v2\n");

    expect(v1.version).toBe(1);
    expect(again.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v1.sha256).not.toBe(v2.sha256);
    expect(text(store.readBlockVersion("fetch", 1))).toContain("echo v1");
    expect(text(store.readBlockVersion("fetch", 2))).toContain("echo v2");
    expect(store.latestBlockVersion("fetch")?.version).toBe(2);
    expect(store.listBlockVersions("fetch").map((b) => b.version)).toEqual([1, 2]);
    store.close();
  });

  test("lists every block by name, with its newest version and how many there are", () => {
    const store = new Store(makeDir());
    expect(store.listBlockNames()).toEqual([]);

    store.addBlockVersion("fetch", script("fetch", "echo v1"));
    store.addBlockVersion("fetch", script("fetch", "echo v2"));
    store.addBlockVersion("accent", script("accent", "echo hi"));

    // One entry per name, names sorted, so a client can fill a list without asking per name.
    expect(store.listBlockNames()).toEqual([
      { name: "accent", latest: 1, versions: 1 },
      { name: "fetch", latest: 2, versions: 2 },
    ]);
    store.close();
  });

  test("rejects a bad name and reports a missing version", () => {
    const store = new Store(makeDir());
    expect(() => store.addBlockVersion("Bad_Name", "x")).toThrow(expect.objectContaining({ code: "invalid_argument" }));
    expect(() => store.getBlockVersion("fetch", 1)).toThrow(expect.objectContaining({ code: "block_not_found" }));
    expect(() => store.readBlockVersion("fetch", 1)).toThrow(expect.objectContaining({ code: "block_not_found" }));
    store.close();
  });
});

describe("pipelines", () => {
  test("keeps the YAML as written plus parsed form and a version history", () => {
    const store = new Store(makeDir());
    const parsed = { name: "hello", steps: [{ id: "greet", uses: "./greet.sh" }] };
    const p1 = store.savePipeline({ name: "hello", yaml: "name: hello\nsteps:\n  greet:\n    uses: ./greet.sh\n", parsed });
    const p1again = store.savePipeline({ name: "hello", yaml: "name: hello\nsteps:\n  greet:\n    uses: ./greet.sh\n", parsed });
    const p2 = store.savePipeline({
      name: "hello",
      yaml: "name: hello\ndescription: more\nsteps:\n  greet:\n    uses: ./greet.sh\n",
      parsed: { name: "hello", description: "more", steps: parsed.steps },
    });

    expect(p1.version).toBe(1);
    expect(p1again.version).toBe(1);
    expect(p2.version).toBe(2);
    expect(p1.yaml).toBe("name: hello\nsteps:\n  greet:\n    uses: ./greet.sh\n");
    expect(p1.parsed).toEqual(parsed);
    expect(store.getPipeline("hello", 1).yaml).toBe(p1.yaml);
    expect(store.listPipelineVersions("hello").map((p) => p.version)).toEqual([1, 2]);
    expect(store.latestPipeline("hello")?.version).toBe(2);
    store.close();
  });

  test("lists every pipeline by name, without carrying the YAML of each", () => {
    const store = new Store(makeDir());
    const save = (name: string, description?: string) =>
      store.savePipeline({
        name,
        yaml: `name: ${name}\n${description === undefined ? "" : `description: ${description}\n`}steps:\n  greet:\n    uses: ./greet.sh\n`,
        parsed: { name, ...(description === undefined ? {} : { description }), steps: [{ id: "greet", uses: "./greet.sh" }] },
      });
    save("word-report");
    save("nightly");
    save("word-report", "second");

    expect(store.listPipelineNames()).toEqual([
      { name: "nightly", latest: 1, versions: 1 },
      { name: "word-report", latest: 2, versions: 2 },
    ]);
    store.close();
  });
});

describe("runs", () => {
  test("round-trips a run with pipeline, block version, step state and attempt", () => {
    const store = new Store(makeDir());
    const { runId } = writeFixture(store);
    const run = store.getRun(runId);
    expect(run.id).toBe(runId);
    expect(run.pipeline).toEqual({ name: "word-report", version: 1 });
    expect(run.status).toBe("running");
    expect(run.inputs).toEqual({ lines: 200 });
    expect(run.steps).toHaveLength(1);
    const step = run.steps[0]!;
    expect(step.id).toBe("generate");
    expect(step.block).toEqual({
      uses: "generate@1",
      name: "generate",
      version: 1,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(step.with).toEqual({ lines: 200 });
    expect(step.attempts).toHaveLength(1);
    expect(step.attempts[0]!.status).toBe("running");
    expect(step.attempts[0]!.pid).toBe(48230);
    expect(store.listRuns()).toEqual([
      expect.objectContaining({ id: runId, pipeline: "word-report", status: "running" }),
    ]);
    store.close();
  });

  test("rejects a duplicate run id", () => {
    const store = new Store(makeDir());
    writeFixture(store);
    const runId = "20261104T101500Z-3fa9c2d1";
    expect(() =>
      store.createRun({
        id: runId,
        pipeline: { name: "word-report", version: 1 },
        status: "running",
        createdAt: "2026-11-04T10:15:00.000Z",
        steps: [
          {
            id: "a",
            name: "a",
            status: "pending",
            block: { uses: "./a.sh", name: "a", version: null, sha256: "a".repeat(64) },
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "already_exists" }));
    store.close();
  });

  test("refuses a run whose pipeline or library block does not exist", () => {
    const store = new Store(makeDir());
    const runId = "20261104T101500Z-3fa9c2d1";
    expect(() =>
      store.createRun({
        id: runId,
        pipeline: { name: "missing", version: 1 },
        status: "running",
        createdAt: "2026-11-04T10:15:00.000Z",
        steps: [
          {
            id: "a",
            name: "a",
            status: "pending",
            block: { uses: "./a.sh", name: "a", version: null, sha256: "a".repeat(64) },
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "pipeline_not_found" }));

    const block = store.addBlockVersion("fetch", "v1");
    store.savePipeline({ name: "p", yaml: "name: p\nsteps:\n  a:\n    uses: ./a.sh\n", parsed: {} });
    expect(() =>
      store.createRun({
        id: "20261104T101500Z-3fa9c2d2",
        pipeline: { name: "p", version: 1 },
        status: "running",
        createdAt: "2026-11-04T10:15:00.000Z",
        steps: [
          {
            id: "a",
            name: "a",
            status: "pending",
            block: { uses: "fetch@1", name: "fetch", version: 1, sha256: block.sha256 },
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      store.createRun({
        id: "20261104T101500Z-3fa9c2d3",
        pipeline: { name: "p", version: 1 },
        status: "running",
        createdAt: "2026-11-04T10:15:00.000Z",
        steps: [
          {
            id: "a",
            name: "a",
            status: "pending",
            block: { uses: "fetch@2", name: "fetch", version: 2, sha256: block.sha256 },
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "block_not_found" }));
    expect(() =>
      store.createRun({
        id: "20261104T101500Z-3fa9c2d4",
        pipeline: { name: "p", version: 1 },
        status: "running",
        createdAt: "2026-11-04T10:15:00.000Z",
        steps: [
          {
            id: "a",
            name: "a",
            status: "pending",
            block: { uses: "fetch@1", name: "fetch", version: 1, sha256: "b".repeat(64) },
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "version_conflict" }));
    store.close();
  });

  test("updates run and step state, and adds attempts", () => {
    const store = new Store(makeDir());
    const { runId } = writeFixture(store);

    store.addAttempt(runId, "generate", { n: 2, status: "running" });
    store.updateRun(runId, {
      steps: { generate: { status: "waiting_retry", nextAttemptAt: "2026-11-04T10:16:00.000Z", attemptsUsed: 2 } },
    });
    let run = store.getRun(runId);
    expect(run.steps[0]!.status).toBe("waiting_retry");
    expect(run.steps[0]!.nextAttemptAt).toBe("2026-11-04T10:16:00.000Z");
    expect(run.steps[0]!.attempts).toHaveLength(2);

    store.updateAttempt(runId, "generate", 2, { status: "succeeded", finishedAt: "2026-11-04T10:16:01.000Z", exitCode: 0 });
    store.updateRun(runId, { status: "succeeded", finishedAt: "2026-11-04T10:16:01.000Z", outputs: { total: 1300 } });
    run = store.getRun(runId);
    expect(run.status).toBe("succeeded");
    expect(run.outputs).toEqual({ total: 1300 });
    expect(run.steps[0]!.attempts[1]!.status).toBe("succeeded");

    expect(() => store.addAttempt(runId, "generate", { n: 2, status: "running" })).toThrow(
      expect.objectContaining({ code: "already_exists" }),
    );
    expect(() => store.updateRun("missing", {})).toThrow(expect.objectContaining({ code: "run_not_found" }));
    store.close();
  });
});

describe("logs", () => {
  test("appends without rewriting and a reader follows by offset", () => {
    const store = new Store(makeDir());
    const block = store.addBlockVersion("b", "#!/usr/bin/env bash\n# ---\n# name: b\n# ---\n");
    store.savePipeline({ name: "p", yaml: "name: p\nsteps:\n  s:\n    uses: ./b.sh\n", parsed: {} });
    const runId = "20261104T101500Z-3fa9c2d1";
    store.createRun({
      id: runId,
      pipeline: { name: "p", version: 1 },
      status: "running",
      createdAt: "2026-11-04T10:15:00.000Z",
      steps: [
        {
          id: "s",
          name: "s",
          status: "running",
          block: { uses: "./b.sh", name: "b", version: null, sha256: block.sha256 },
          attempts: [{ n: 1, status: "running" }],
        },
      ],
    });

    const first = store.appendLog(runId, "s", 1, new TextEncoder().encode("hello "));
    const second = store.appendLog(runId, "s", 1, new TextEncoder().encode("world\n"));
    expect(first).toBe(6);
    expect(second).toBe(12);
    expect(store.logSize(runId, "s", 1)).toBe(12);

    const chunk = store.readLog(runId, "s", 1, 0);
    expect(text(chunk.bytes)).toBe("hello world\n");
    expect(chunk.size).toBe(12);

    const tail = store.readLog(runId, "s", 1, 6);
    expect(text(tail.bytes)).toBe("world\n");
    expect(tail.size).toBe(12);

    // Reading past the end returns nothing, and the cursor stays at the true size.
    const beyond = store.readLog(runId, "s", 1, 12);
    expect(beyond.bytes).toHaveLength(0);
    expect(beyond.size).toBe(12);

    expect(() => store.appendLog(runId, "s", 2, new Uint8Array())).toThrow(
      expect.objectContaining({ code: "attempt_not_found" }),
    );
    store.close();
  });
});

describe("artifacts", () => {
  test("records type, size, location and bytes of a produced file", () => {
    const store = new Store(makeDir());
    const block = store.addBlockVersion("b", "#!/usr/bin/env bash\n# ---\n# name: b\n# ---\n");
    store.savePipeline({ name: "p", yaml: "name: p\nsteps:\n  s:\n    uses: ./b.sh\n", parsed: {} });
    const runId = "20261104T101500Z-3fa9c2d1";
    store.createRun({
      id: runId,
      pipeline: { name: "p", version: 1 },
      status: "succeeded",
      createdAt: "2026-11-04T10:15:00.000Z",
      steps: [
        {
          id: "s",
          name: "s",
          status: "succeeded",
          block: { uses: "./b.sh", name: "b", version: null, sha256: block.sha256 },
          attempts: [{ n: 1, status: "succeeded" }],
        },
      ],
    });

    const artifact = store.saveArtifact(runId, "s", 1, "corpus", "file", "amber birch cedar\n");
    expect(artifact.type).toBe("file");
    expect(artifact.size).toBe(18);
    expect(artifact.published).toBe(true);
    expect(artifact.path).toContain(join("artifacts", runId, "s", "1", "corpus"));
    expect(text(store.readArtifact(runId, "s", 1, "corpus"))).toBe("amber birch cedar\n");
    expect(store.getArtifact(runId, "s", 1, "corpus").sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(store.listArtifacts(runId).map((a) => a.name)).toEqual(["corpus"]);

    expect(() => store.saveArtifact(runId, "s", 1, "corpus", "file", "again")).toThrow(
      expect.objectContaining({ code: "already_exists" }),
    );
    expect(() => store.saveArtifact(runId, "s", 2, "corpus", "file", "x")).toThrow(
      expect.objectContaining({ code: "attempt_not_found" }),
    );
    store.close();
  });
});

describe("restart", () => {
  test("a run written by one Store is fully readable by a new Store on the same directory", () => {
    const dir = makeDir();
    const runId = "20261104T101500Z-3fa9c2d1";

    {
      const store = new Store(dir);
      const block = store.addBlockVersion("count", "#!/usr/bin/env bash\n# ---\n# name: count\n# ---\necho 42\n");
      const pipeline = store.savePipeline({
        name: "word-report",
        yaml: "name: word-report\nsteps:\n  count:\n    uses: count@1\n",
        parsed: { name: "word-report", steps: ["count"] },
      });
      store.createRun({
        id: runId,
        pipeline: { name: pipeline.name, version: pipeline.version },
        status: "running",
        createdAt: "2026-11-04T10:15:00.000Z",
        inputs: { seed: 7 },
        steps: [
          {
            id: "count",
            name: "Count words",
            status: "running",
            block: { uses: "count@1", name: "count", version: block.version, sha256: block.sha256 },
            with: { top: 5 },
            attempts: [{ n: 1, status: "running" }],
          },
        ],
      });
      store.appendLog(runId, "count", 1, new TextEncoder().encode("counting...\n"));
      store.saveArtifact(runId, "count", 1, "total_words", "integer", "42");
      store.close();
    }

    const store = new Store(dir);
    const run = store.getRun(runId);
    expect(run.pipeline).toEqual({ name: "word-report", version: 1 });
    expect(run.steps[0]!.block.version).toBe(1);
    expect(text(store.readBlockVersion("count", 1))).toContain("echo 42");
    expect(text(store.readLog(runId, "count", 1, 0).bytes)).toBe("counting...\n");
    expect(text(store.readArtifact(runId, "count", 1, "total_words"))).toBe("42");
    expect(store.getPipeline("word-report", 1).parsed).toEqual({ name: "word-report", steps: ["count"] });
    store.close();
  });
});

describe("migration and lifecycle", () => {
  test("creates a schema on first open and recognises the version on reopen", () => {
    const dir = makeDir();
    const store = new Store(dir);
    const db = new Database(join(dir, "store.sqlite"));
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    db.close();
    store.close();

    const reopened = new Store(dir);
    expect(reopened.listRuns()).toEqual([]);
    reopened.close();
  });

  test("refuses a store written by a newer version", () => {
    const dir = makeDir();
    const db = new Database(join(dir, "store.sqlite"));
    db.run("PRAGMA user_version = " + String(SCHEMA_VERSION + 1));
    db.close();
    expect(() => new Store(dir)).toThrow(expect.objectContaining({ code: "store_migration_failed" }));
  });

  test("two Store instances share one directory without a singleton", () => {
    const dir = makeDir();
    const a = new Store(dir);
    const b = new Store(dir);
    a.addBlockVersion("x", "one");
    expect(b.latestBlockVersion("x")?.version).toBe(1);
    b.addBlockVersion("x", "two");
    expect(a.listBlockVersions("x").map((v) => v.version)).toEqual([1, 2]);
    a.close();
    b.close();
  });

  test("closing a store makes later calls fail with store_closed", () => {
    const store = new Store(makeDir());
    store.close();
    expect(() => store.listRuns()).toThrow(expect.objectContaining({ code: "store_closed" }));
  });

  test("openStore resolves the default directory and openStore() creates it", () => {
    expect(defaultStoreDir({ BASHREACTOR_HOME: "/tmp/br" })).toBe(join("/tmp/br", "store"));
    expect(defaultStoreDir({})).toContain(".bashreactor");
    const store = openStore(makeDir());
    expect(store).toBeInstanceOf(Store);
    store.close();
  });
});
