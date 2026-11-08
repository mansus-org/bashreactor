// Taking a run away (SPEC 4.2, and the gap SPEC 6 left open). The engine owns `runs/<id>/` — the
// record, every block's log, every file a block made — so it is the only thing allowed to delete
// one, and the only thing that can tell whether a process is still writing into it.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, chmodSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BashreactorError } from "@bashreactor/core";
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

/** One finished run, with its log and outputs on disk — the thing a retention sweep is after. */async function finishedRun(root: string) {
  const store = new FsRunStore(root);
  const engine = new Engine({ store });
  const record = await engine.start(fixture("ok.yaml"));
  const final = await engine.drive(record.id);
  return { store, engine, id: record.id, final };
}

/** A store that will not let a run go, which is what a full or failing volume does to a delete. */
class RefusingStore extends FsRunStore {
  override async removeRun(): Promise<void> {
    throw new BashreactorError("run_delete_failed", "EIO: i/o error, unlink");
  }
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

  test("a run whose record will not parse is still deletable", async () => {
    const root = newRoot();
    const { engine, id } = await finishedRun(root);
    // The case that makes the trim necessary: a record truncated by a pod killed mid-write, or left
    // by a version that has since changed. Nothing can read it, so nothing can list it, and the only
    // thing that will ever take the space back is a delete that does not ask the record first.
    writeFileSync(join(root, "runs", id, "run.json"), "{ \"id\": ");

    await engine.deleteRun(id);

    expect(existsSync(join(root, "runs", id))).toBe(false);
  });

  test("a directory on disk that no record was ever written for is deletable", async () => {    const root = newRoot();
    const { engine } = await finishedRun(root);
    // A `createRun` interrupted before `run.json` landed: the directory is real, it is in no listing,
    // and it is invisible to every other code path in the engine.
    const orphan = "20261106T120000Z-ffffffff";
    mkdirSync(join(root, "runs", orphan, "blocks"), { recursive: true });
    writeFileSync(join(root, "runs", orphan, "blocks", "0.log"), "x");

    await engine.deleteRun(orphan);

    expect(existsSync(join(root, "runs", orphan))).toBe(false);
  });

  test("a delete the filesystem refuses does not leave the run claimed", async () => {
    const root = newRoot();
    const { store, engine, id } = await finishedRun(root);
    // Deleting takes the claim so nothing starts a step in the directory being removed. If the removal
    // then fails, that claim has to come back: it was written by this process, this process is alive,
    // and so a claim left behind would answer `run_claimed` to every later attempt forever.
    const refusing = new Engine({ store: new RefusingStore(root) });

    await expect(refusing.deleteRun(id)).rejects.toThrow(expect.objectContaining({ code: "run_delete_failed" }));

    expect(await store.loadClaim(id)).toBeNull();
    await engine.deleteRun(id);
    expect(existsSync(join(root, "runs", id))).toBe(false);
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

  test("a directory a block made read-only is removed, not left half gone", async () => {
    const root = newRoot();
    const { store, id } = await finishedRun(root);
    // A block that wrote its own tree and took the write bit away. Removing a file needs write
    // permission on the directory holding it, so `rmSync` fails here — and a partial removal is the
    // worst outcome of all, because the run stops being listed while the space stays spent.
    const out = join(root, "runs", id, "out");
    mkdirSync(out);
    writeFileSync(join(out, "thing"), "x");
    chmodSync(out, 0o500);

    await store.removeRun(id);

    expect(existsSync(join(root, "runs", id))).toBe(false);
  });
});
