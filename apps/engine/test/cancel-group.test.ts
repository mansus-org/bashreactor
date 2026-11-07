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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000, message = "waitFor timed out"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(message);
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
async function waitForBackgroundChild(store: FsRunStore, runId: string, stepId: string): Promise<Process> {
  let found: Process = { pid: 0, pid_start: 0 };
  await waitFor(async () => {
    const log = await store.readFile(runId, `steps/${stepId}/attempts/1/log`);
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
    const child = await waitForBackgroundChild(store, id, "spawn");
    expect(isGone(child)).toBe(false);

    await engine.cancel(id);
    const final = await driving;

    expect(final.status).toBe("cancelled");
    expect(final.cancel_requested_at).not.toBeNull();
    const step = final.steps.spawn!;
    expect(step.status).toBe("cancelled");
    expect(step.attempts).toHaveLength(1);
    expect(step.attempts[0]!.status).toBe("cancelled");
    // The code only: SPEC 5 keeps the message for people and out of tests.
    expect(step.attempts[0]!.failure).toMatchObject({ code: "cancelled" });
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
    const child = await waitForBackgroundChild(store, id, "spawn");

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

  // SPEC 2.9 and 4.6 step 3 cover a cancel as well as a timeout, so the SIGKILL that ends a block
  // which ignores SIGTERM belongs to the cancel's own kill_grace. It used to belong to timeouts only,
  // and this died at the 60s step timeout instead: measured 61.1s, and with the default 24h timeout a
  // cancel would have held its slot for a day.
  test("a block that ignores SIGTERM is killed with its group once the cancel's grace is up", async () => {
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

  test("the cancel's own grace ends a block that ignores SIGTERM, not the step's timeout", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(fixture("ignore-term.yaml"));
    const id = record.id;
    const driving = engine.drive(id);
    const block = await waitForBlockPid(store, id, "stubborn");

    const cancelledAt = Date.now();
    await engine.cancel(id);
    // Wait past where the fix lands but stop short of the 60s timeout, so the assertion below is what
    // fails on a regression rather than a generic wait. ignore-term.yaml is kill_grace 1s, timeout 60s.
    await waitFor(() => Promise.resolve(isGone(block)), 45_000, "the block outlived the cancel's grace");
    expect(Date.now() - cancelledAt).toBeLessThan(15_000);

    const final = await driving;
    const attempt = final.steps.stubborn!.attempts[0]!;
    expect(attempt.status).toBe("cancelled");
    expect(attempt.failure).toMatchObject({ code: "cancelled" });
    // The same span read out of run.json, so the timing is the record's, not the test's own clock.
    expect(Date.parse(attempt.finished_at!) - Date.parse(final.cancel_requested_at!)).toBeLessThan(15_000);
  }, 90_000);

  test("the SIGKILL a cancel escalates to takes the block's children with it", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(fixture("ignore-term-child.yaml"));
    const id = record.id;
    const driving = engine.drive(id);
    const block = await waitForBlockPid(store, id, "stubborn");
    const child = await waitForBackgroundChild(store, id, "stubborn");

    await engine.cancel(id);
    // The child ignores SIGTERM as the block does, so nothing short of the escalated SIGKILL to the
    // group ends it: a fix that only ever signalled the leader would leave this running until the step
    // fires its 60s timeout.
    await waitFor(() => Promise.resolve(isGone(child)), 45_000, "the child outlived the cancel's grace");
    expect(isGone(block)).toBe(true);

    const final = await driving;
    expect(final.status).toBe("cancelled");
    expect(final.steps.stubborn!.attempts[0]!.status).toBe("cancelled");
  }, 90_000);
});
