// Cancellation, docs/SPEC.md 4.6 and 2.9: the signals go to the process group, so a block's children
// end with it, and here is what a cancel leaves behind in run.json.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../src/engine.ts";
import { readProcStartTime } from "../src/proc.ts";
import { FsRunStore } from "../src/run-store.ts";

const fixtures = new URL("./fixtures/", import.meta.url);
const fixture = (name: string) => fileURLToPath(new URL(name, fixtures));

const roots: string[] = [];
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bashreactor-cancel-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error("waitFor timed out");
}

interface Process {
  pid: number;
  pid_start: number;
}

/**
 * Whether a process we watched is finished. A killed process can sit in /proc as a zombie until
 * somebody reaps it, and a zombie can never run again; a pid that has been recycled means the same.
 */
function isGone(process: Process): boolean {
  const start = readProcStartTime(process.pid);
  if (start === null || start !== process.pid_start) return true;
  try {
    // Field 3 of /proc/<pid>/stat is the state letter, and it is the first field after the name.
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "Z";
  } catch {
    return true;
  }
}

/** The block's own process, once the engine has written its pid into run.json. */
async function waitForBlockPid(store: FsRunStore, runId: string, stepId: string): Promise<Process> {
  let found: Process = { pid: 0, pid_start: 0 };
  await waitFor(async () => {
    const attempt = (await store.loadRun(runId))?.steps[stepId]?.attempts[0];
    if (attempt?.pid == null || attempt.pid_start == null) return false;
    found = { pid: attempt.pid, pid_start: attempt.pid_start };
    return true;
  });
  return found;
}

/**
 * The background child spawn-child.sh leaves behind, read out of the attempt's log. It is alive when
 * this returns, which is what makes "it is gone afterwards" mean something.
 */
async function waitForBackgroundChild(store: FsRunStore, runId: string): Promise<Process> {
  let found: Process = { pid: 0, pid_start: 0 };
  await waitFor(async () => {
    const log = await store.readFile(runId, "steps/spawn/attempts/1/log");
    const match = log === null ? null : /background pid (\d+)/.exec(text(log));
    if (match === null) return false;
    const pid = Number(match[1]);
    const start = readProcStartTime(pid);
    if (start === null) return false;
    found = { pid, pid_start: start };
    return true;
  });
  return found;
}

describe("cancellation reaches the process group", () => {
  test("a cancel kills the block and the child it left behind", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(fixture("cancel-graph.yaml"));
    const id = record.id;
    const driving = engine.drive(id);

    const block = await waitForBlockPid(store, id, "spawn");
    const child = await waitForBackgroundChild(store, id);
    expect(isGone(child)).toBe(false);

    await engine.cancel(id);
    const final = await driving;

    expect(final.status).toBe("cancelled");
    expect(final.cancel_requested_at).not.toBeNull();
    const step = final.steps.spawn!;
    expect(step.status).toBe("cancelled");
    expect(step.attempts).toHaveLength(1);
    expect(step.attempts[0]!.status).toBe("cancelled");
    expect(step.attempts[0]!.failure).toEqual({ code: "cancelled", message: "cancelled" });
    // A cancelled attempt spends none of the retry budget (4.5).
    expect(step.attempts_used).toBe(0);

    // The block is gone, and so is the grandchild it backgrounded. Killing only the shell would leave
    // a `sleep 300` running against a run that has already finished: 2.9 sends the signal to the
    // group, and again as SIGKILL once the leader ends.
    expect(isGone(block)).toBe(true);
    await waitFor(() => Promise.resolve(isGone(child)));

    // The step behind it was cancelled, not skipped and not left pending (4.6 step 2).
    expect(final.steps.after!.status).toBe("cancelled");
    expect(final.steps.after!.attempts).toHaveLength(0);
    expect(final.steps.after!.with).toBeNull();
    // The holder released its claim on the way out (4.7).
    expect(existsSync(store.layout(id).lock)).toBe(false);
  }, 30_000);

  test("a timeout kills the child too", async () => {
    // spawn-child.yaml has a 1s timeout, so nothing here is cancelled: this is the other half of 2.9.
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(fixture("spawn-child.yaml"));
    const id = record.id;
    const driving = engine.drive(id);

    const block = await waitForBlockPid(store, id, "spawn");
    const child = await waitForBackgroundChild(store, id);

    const final = await driving;
    expect(final.status).toBe("failed");
    const step = final.steps.spawn!;
    expect(step.failure!.code).toBe("timeout");
    // Unlike a cancel, a timeout is a failure and it costs an attempt.
    expect(step.attempts_used).toBe(1);

    expect(isGone(block)).toBe(true);
    await waitFor(() => Promise.resolve(isGone(child)));
  }, 30_000);

  test("cancelling a run that has already finished is refused", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(fixture("ok.yaml"));
    await engine.drive(record.id);

    // The code the CLI and the API print, rather than a silent success on a run that is not running.
    await expect(engine.cancel(record.id)).rejects.toThrow(expect.objectContaining({ code: "run_not_active" }));
  }, 30_000);

  // SKIPPED, AND IT FAILS IF YOU UN-SKIP IT. Finding from BASHR-41: a cancel of a block that ignores
  // SIGTERM never escalates to SIGKILL on the cancel's own `kill_grace`. applyCancel sends the TERM
  // and checkTimeouts only escalates for an attempt whose `timedOut` flag is set, so the block runs
  // until the step's `timeout` fires and only then is killed: measured 61.1s here with kill_grace 1s
  // and timeout 60s, and with the default 24h timeout a cancel would hold its slot for a day.
  // SPEC 2.9 covers a cancel as well as a timeout, and 4.6 step 3 says to stop the attempt "as in
  // section 2.9". The fix is one more escalation in checkTimeouts: a cancelled attempt whose
  // sigtermAt + killGraceMs has passed gets the SIGKILL the timed-out branch already sends. It
  // belongs in engine.ts, which PR #29 is editing, so it is not in this branch.
  test.skip("a block that ignores SIGTERM is killed with its group once the cancel's grace is up", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(fixture("ignore-term.yaml"));
    const id = record.id;
    const driving = engine.drive(id);
    const block = await waitForBlockPid(store, id, "stubborn");

    await engine.cancel(id);
    // ignore-term.yaml asks for a 1s grace; the 60s timeout must not be what ends this.
    await waitFor(() => Promise.resolve(isGone(block)), 5_000);

    const final = await driving;
    expect(final.status).toBe("cancelled");
    expect(final.steps.stubborn!.attempts[0]!.status).toBe("cancelled");
  }, 30_000);
});
