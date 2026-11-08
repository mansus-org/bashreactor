// The claim of docs/SPEC.md 4.7: one engine drives a run, and `lock` is how every other engine finds
// that out. run.json on disk is the evidence that a step was started once and not twice.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../src/engine.ts";
import { isLiveClaim, readProcStartTime } from "../src/proc.ts";
import { FsRunStore } from "../src/run-store.ts";
import type { RunRecord } from "../src/run.ts";

const fixtures = new URL("./fixtures/", import.meta.url);
const fixture = (name: string) => fileURLToPath(new URL(name, fixtures));
const helper = fileURLToPath(new URL("./helpers/engine-process.ts", import.meta.url));

const roots: string[] = [];
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bashreactor-claim-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error("waitFor timed out");
}

type Settled = { outcome: "resolved"; record: RunRecord } | { outcome: "rejected"; error: unknown };

/** A drive that cannot throw: two of them racing is the point, and both outcomes are the assertion. */
function settle(drive: Promise<RunRecord>): Promise<Settled> {
  return drive.then(
    (record) => ({ outcome: "resolved", record }) as Settled,
    (error: unknown) => ({ outcome: "rejected", error }) as Settled,
  );
}

/** A pid nothing is running under, which is what an engine that was SIGKILLed leaves behind. */
function deadPid(): number {
  for (let pid = 99_999; pid > 300; pid--) {
    if (readProcStartTime(pid) === null) return pid;
  }
  throw new Error("no dead pid to be found");
}

/** Starts a run and lets a separate engine process drive it, the way a second server would. */
async function driveInAnotherProcess(root: string, pipeline: string) {
  const store = new FsRunStore(root);
  const record = await new Engine({ store }).start(fixture(pipeline));
  const proc = Bun.spawn(["bun", helper, root, record.id], { stdout: "pipe", stderr: "pipe" });
  const stepId = Object.keys(record.steps)[0]!;
  await waitFor(async () => (await store.loadRun(record.id))?.steps[stepId]?.attempts[0]?.pid != null);
  return { store, id: record.id, stepId, proc };
}

describe("claiming", () => {
  test("two engines over one run directory: one drives, the other is refused", async () => {
    const root = newRoot();
    const store = new FsRunStore(root);
    const record = await new Engine({ store }).start(fixture("slow.yaml"));
    const id = record.id;

    // Two engines, two stores, one directory. Whichever loses says so at once; the winner keeps
    // driving until the run is cancelled below.
    const first = settle(new Engine({ store: new FsRunStore(root) }).drive(id));
    const second = settle(new Engine({ store: new FsRunStore(root) }).drive(id));

    const loser = await Promise.race([first, second]);
    if (loser.outcome !== "rejected") {
      throw new Error(`the engine that lost the claim should be refused, not ${loser.outcome}`);
    }
    expect(loser.error).toEqual(expect.objectContaining({ code: "run_claimed" }));

    // The winner gets the step running and the loser never got a turn at it, so the run directory
    // holds one attempt and a claim that is live, not two of either.
    await waitFor(async () => ((await store.loadRun(id))?.steps.slow?.attempts.length ?? 0) > 0);
    const claim = await store.loadClaim(id);
    expect(claim).not.toBeNull();
    expect(isLiveClaim(claim!)).toBe(true);
    const held = (await store.loadRun(id))!;
    expect(held.steps.slow!.status).toBe("running");
    expect(held.steps.slow!.attempts).toHaveLength(1);
    expect(held.steps.slow!.attempts[0]!.pid).not.toBeNull();

    // A cancel from anybody reaches the holder, so both drives can end.
    await new Engine({ store: new FsRunStore(root) }).cancel(id);
    const both = await Promise.all([first, second]);
    const driven = both.flatMap((result) => (result.outcome === "resolved" ? [result.record] : []));
    expect(driven).toHaveLength(1);
    expect(driven[0]!.status).toBe("cancelled");
    expect(driven[0]!.steps.slow!.attempts).toHaveLength(1);
  }, 60_000);

  test("an engine in another process holds the claim, and this one runs nothing behind its back", async () => {
    const root = newRoot();
    const { store, id, proc } = await driveInAnotherProcess(root, "slow.yaml");

    const claim = (await store.loadClaim(id))!;
    expect(claim.pid).toBe(proc.pid);
    expect(isLiveClaim(claim)).toBe(true);

    const other = new Engine({ store: new FsRunStore(root) });
    await expect(other.drive(id)).rejects.toThrow(expect.objectContaining({ code: "run_claimed" }));
    await expect(new Engine({ store: new FsRunStore(root) }).resume(id)).rejects.toThrow(
      expect.objectContaining({ code: "run_claimed" }),
    );

    // Refused engines do not touch the state: still one attempt, still the other engine's process.
    const held = (await store.loadRun(id))!;
    expect(held.steps.slow!.attempts).toHaveLength(1);
    expect(readProcStartTime(held.steps.slow!.attempts[0]!.pid!)).not.toBeNull();

    // Let the holder finish its run instead of killing it mid-step.
    await new Engine({ store: new FsRunStore(root) }).cancel(id);
    expect(await proc.exited).toBe(1); // the helper exits 0 only on a run that succeeded
    expect((await store.loadRun(id))!.status).toBe("cancelled");
  }, 60_000);

  test("a claim left by an engine that died is taken over, and the run is driven once", async () => {
    const store = new FsRunStore(newRoot());
    const record = await new Engine({ store }).start(fixture("ok.yaml"));
    const id = record.id;

    // The lock an engine that was SIGKILLed leaves: a pid that no longer exists.
    expect(await store.tryClaim(id, { pid: deadPid(), pid_start: 4_242 })).toBe("claimed");
    expect(isLiveClaim((await store.loadClaim(id))!)).toBe(false);

    const final = await new Engine({ store }).drive(id);
    expect(final.status).toBe("succeeded");
    expect(final.steps.ok!.attempts).toHaveLength(1);
    // The new engine wrote over the stale claim and released it when the run ended.
    expect(existsSync(store.layout(id).lock)).toBe(false);
  }, 30_000);

  test("a live claim is never taken over, and nothing runs behind it", async () => {
    const store = new FsRunStore(newRoot());
    const record = await new Engine({ store }).start(fixture("ok.yaml"));
    const id = record.id;

    // A claim whose pid and start time both match: somebody is driving this run.
    expect(await store.tryClaim(id, { pid: process.pid, pid_start: readProcStartTime(process.pid)! })).toBe("claimed");

    await expect(new Engine({ store }).drive(id)).rejects.toThrow(expect.objectContaining({ code: "run_claimed" }));
    const untouched = (await store.loadRun(id))!;
    expect(untouched.steps.ok!.status).toBe("pending");
    expect(untouched.steps.ok!.attempts).toHaveLength(0);
  }, 30_000);

  test("what a reader learns of the claim is who holds it and whether they stayed", async () => {
    // A client decides whether resuming can work from this and nothing else (SPEC 4.7), so the engine
    // that owns `lock` makes the judgement rather than every reader guessing at a pid it cannot read.
    const store = new FsRunStore(newRoot());
    const record = await new Engine({ store }).start(fixture("ok.yaml"));
    const id = record.id;

    // Nothing has claimed it, which is not the same as a stale claim: there is no lock to read at all.
    expect(await new Engine({ store }).readClaim(id)).toBeNull();

    // The lock an engine that was SIGKILLed leaves behind, which is the one case a resume is for.
    expect(await store.tryClaim(id, { pid: deadPid(), pid_start: 4_242 })).toBe("claimed");
    expect(await new Engine({ store }).readClaim(id)).toEqual({ pid: expect.any(Number), live: false });

    // A stale lock may be deleted and claimed again (SPEC 4.7), and now somebody is really here.
    await store.releaseClaim(id);
    expect(await store.tryClaim(id, { pid: process.pid, pid_start: readProcStartTime(process.pid)! })).toBe(
      "claimed",
    );
    expect(await new Engine({ store }).readClaim(id)).toEqual({ pid: process.pid, live: true });
  }, 30_000);

  test("a cancel from a process that does not hold the claim reaches the holder", async () => {
    const root = newRoot();
    const { store, id, proc } = await driveInAnotherProcess(root, "slow.yaml");

    // This engine has no claim, so all it may do is leave the file (4.6).
    await new Engine({ store: new FsRunStore(root) }).cancel(id);

    expect(await proc.exited).toBe(1);
    const final = (await store.loadRun(id))!;
    expect(final.status).toBe("cancelled");
    expect(final.cancel_requested_at).not.toBeNull();
    expect(final.steps.slow!.status).toBe("cancelled");
    expect(final.steps.slow!.attempts_used).toBe(0);
    // The holder acts on the file and then deletes it, and releases its claim with the run final.
    expect(existsSync(store.layout(id).cancelRequest)).toBe(false);
    expect(existsSync(store.layout(id).lock)).toBe(false);
  }, 60_000);
});
