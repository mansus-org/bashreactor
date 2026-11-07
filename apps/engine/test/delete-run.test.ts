// Taking a run away (SPEC 4.2, and the gap SPEC 6 left open). The engine owns `runs/<id>/` — the
// record, every block's log, every file a block made — so it is the only thing allowed to delete
// one, and the only thing that can tell whether a process is still writing into it.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../src/engine.ts";
import { FsRunStore } from "../src/run-store.ts";
import { readProcStartTime } from "../src/proc.ts";

const fixtures = new URL("./fixtures/", import.meta.url);
const fixture = (name: string) => fileURLToPath(new URL(name, fixtures));

const roots: string[] = [];
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bashreactor-delete-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A pid nothing is running under, which is what an engine that was SIGKILLed leaves behind. */
function deadPid(): number {
  for (let pid = 99_999; pid > 300; pid--) {
    if (readProcStartTime(pid) === null) return pid;
  }
  throw new Error("no dead pid to be found");
}

/** One finished run, with its log and outputs on disk — the thing a retention sweep is after. */
async function finishedRun(root: string) {
  const store = new FsRunStore(root);
  const engine = new Engine({ store });
  const record = await engine.start(fixture("ok.yaml"));
  const final = await engine.drive(record.id);
  return { store, engine, id: record.id, final };
}

describe("deleteRun", () => {
  test("a finished run's whole directory goes, logs and outputs with it", async () => {
    const root = newRoot();
    const { store, engine, id, final } = await finishedRun(root);
    expect(final.status).toBe("succeeded");

    const runDir = join(root, "runs", id);
    const log = join(runDir, "steps", "ok", "attempts", "1", "log");
    expect(existsSync(runDir)).toBe(true);
    expect(existsSync(log)).toBe(true);

    await engine.deleteRun(id);

    expect(existsSync(runDir)).toBe(false);
    expect(await store.loadRun(id)).toBeNull();
    expect(await engine.getRun(id)).toBeNull();
    expect(await engine.listRuns()).toEqual([]);
    // Only that run went: the store's own scaffolding is still there.
    expect(readdirSync(join(root, "runs"))).toEqual([]);
    expect(existsSync(join(root, "home"))).toBe(true);
  });

  test("a run with a live claim is refused, and nothing about it changes", async () => {
    const root = newRoot();
    const { store, engine, id } = await finishedRun(root);
    expect(await store.tryClaim(id, { pid: process.pid, pid_start: readProcStartTime(process.pid)! })).toBe("claimed");

    // The message has to say what to do instead, because the caller cannot see the claim.
    await expect(engine.deleteRun(id)).rejects.toThrow(
      expect.objectContaining({ code: "run_claimed", message: expect.stringContaining(String(process.pid)) }),
    );

    expect(existsSync(join(root, "runs", id))).toBe(true);
    expect((await store.loadRun(id))!.status).toBe("succeeded");
  });

  test("a claim left by an engine that died does not hold the directory", async () => {
    const root = newRoot();
    const { store, engine, id } = await finishedRun(root);
    expect(await store.tryClaim(id, { pid: deadPid(), pid_start: 4_242 })).toBe("claimed");

    await engine.deleteRun(id);

    expect(existsSync(join(root, "runs", id))).toBe(false);
  });

  test("the claim is the evidence, not the status: an unclaimed `running` run goes", async () => {
    const root = newRoot();
    const store = new FsRunStore(root);
    const engine = new Engine({ store });
    const record = await engine.start(fixture("ok.yaml"));
    // Started and never driven: `running` on paper, with no process and no claim behind it. A pod
    // that was killed mid-start leaves exactly this, and a sweep must be able to clear it.
    expect((await store.loadRun(record.id))!.status).toBe("running");
    expect(await store.loadClaim(record.id)).toBeNull();

    await engine.deleteRun(record.id);

    expect(existsSync(join(root, "runs", record.id))).toBe(false);
  });

  test("an id that was never a run answers run_not_found", async () => {
    const { engine } = await finishedRun(newRoot());
    await expect(engine.deleteRun("0123456789abcdef0123456789abcdef")).rejects.toThrow(
      expect.objectContaining({ code: "run_not_found" }),
    );
  });

  test("deleting twice is a 404 the second time, not a silent success", async () => {
    const root = newRoot();
    const { engine, id } = await finishedRun(root);
    await engine.deleteRun(id);
    await expect(engine.deleteRun(id)).rejects.toThrow(expect.objectContaining({ code: "run_not_found" }));
  });

  test("a name that is not a run id cannot point outside runs/", async () => {
    const root = newRoot();
    const { engine } = await finishedRun(root);
    const outside = join(root, "keepme");
    writeFileSync(outside, "not a run");

    for (const name of ["../../keepme", "..", ".", "not-a-run", ".tmp-half-written"]) {
      await expect(engine.deleteRun(name)).rejects.toThrow(expect.objectContaining({ code: "run_not_found" }));
    }
    expect(existsSync(outside)).toBe(true);
    expect(readdirSync(join(root, "runs"))).toHaveLength(1);
  });
});

describe("FsRunStore.removeRun", () => {
  test("refuses a name that is not a run id before it builds a path from it", async () => {
    const root = newRoot();
    const store = new FsRunStore(root);
    // The engine checks first, so this is the second door: a caller that reaches for the store
    // directly gets the same refusal.
    await expect(store.removeRun("../../home")).rejects.toThrow(expect.objectContaining({ code: "run_not_found" }));
    await expect(store.removeRun("")).rejects.toThrow(expect.objectContaining({ code: "run_not_found" }));
    expect(existsSync(join(root, "home"))).toBe(true);
  });
});
