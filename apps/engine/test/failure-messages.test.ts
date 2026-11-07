// What a failed step says to a person. SPEC 5 splits an error in two: `code` is for machines and
// `message` is for people, so a failure that prints its own code back has no message at all. These
// run each failure kind for real and read what came out, asking for the facts a person would act on
// (the exit code, the output name, the limit hit) rather than one fixed sentence.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BashreactorError } from "@bashreactor/core";
import type { Value } from "@bashreactor/core";
import { Engine } from "../src/engine.ts";
import { FsRunStore } from "../src/run-store.ts";
import type { FailureInfo, StepRecord } from "../src/run.ts";

const fixtures = new URL("./fixtures/", import.meta.url);
const fixture = (name: string) => fileURLToPath(new URL(name, fixtures));

const roots: string[] = [];
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bashreactor-failure-messages-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * One run in one temp home, driven to its end. The starter and the driver are separate engines
 * because two failure kinds are only reachable when the environment changes between `start`, which
 * checks it up front, and the attempt that runs later.
 */
async function runFixture(
  pipeline: string,
  stepId: string,
  options: {
    inputs?: Record<string, Value>;
    startEnv?: Record<string, string | undefined>;
    driveEnv?: Record<string, string | undefined>;
    drivePath?: string;
  } = {},
): Promise<{ store: FsRunStore; runId: string; step: StepRecord }> {
  const store = new FsRunStore(newRoot());
  const starter = new Engine({ store, ...(options.startEnv === undefined ? {} : { env: options.startEnv }) });
  const record = await starter.start(fixture(pipeline), options.inputs ?? {});
  const driver = new Engine({
    store,
    ...(options.driveEnv === undefined ? {} : { env: options.driveEnv }),
    ...(options.drivePath === undefined ? {} : { path: options.drivePath }),
  });
  const final = await driver.drive(record.id);
  return { store, runId: record.id, step: final.steps[stepId]! };
}

/**
 * The failure a person is actually shown. A cancelled or interrupted step carries none of its own by
 * design (SPEC 4.9), so the attempt's is what the surfaces fall back to.
 */
function shown(step: StepRecord): FailureInfo | null {
  return step.failure ?? step.attempts[step.attempts.length - 1]?.failure ?? null;
}

/** The one rule every failure kind obeys: the message says something, and it is not the code again. */
function expectHuman(failure: FailureInfo | null): FailureInfo {
  expect(failure).not.toBeNull();
  const info = failure!;
  expect(info.message.trim()).not.toBe("");
  expect(info.message.toLowerCase()).not.toBe(info.code);
  return info;
}

/** The whole numbers a message quotes, so a test can ask "is this size or duration in here". */
const numbersIn = (message: string) => [...message.matchAll(/\d+/g)].map((match) => Number(match[0]));

async function caught(run: () => Promise<unknown>): Promise<BashreactorError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(BashreactorError);
    return error as BashreactorError;
  }
  throw new Error("expected the run to be refused, and it was not");
}

describe("what a failure says", () => {
  test("a non-zero exit names the step and the code it left with", async () => {
    const { step } = await runFixture("msg-exit.yaml", "boom");
    expect(step.failure!.code).toBe("exit_nonzero");
    const message = expectHuman(step.failure).message;
    expect(message).toContain("boom");
    expect(numbersIn(message)).toContain(3);
    // The attempt and the step are the same failure; neither prints the code back.
    expect(step.attempts[0]!.failure).toEqual(step.failure);
  });

  test("exit 75 says a retry was asked for, and with which code", async () => {
    const { step } = await runFixture("msg-ask-retry.yaml", "ask");
    expect(step.failure!.code).toBe("retry_requested");
    const message = expectHuman(step.failure).message;
    expect(message).toContain("ask");
    expect(numbersIn(message)).toContain(75);
  });

  test("exit 78 says the block itself ruled out another attempt", async () => {
    const { step } = await runFixture("msg-fatal.yaml", "gate");
    expect(step.failure!.code).toBe("block_fatal");
    const message = expectHuman(step.failure).message;
    expect(message).toContain("gate");
    expect(numbersIn(message)).toContain(78);
    expect(message.toLowerCase()).toMatch(/retr/);
  });

  test("a missing output names the one that is missing and the directory it was looked for in", async () => {
    const { store, runId, step } = await runFixture("msg-half-written.yaml", "partial");
    expect(step.failure!.code).toBe("output_missing");
    const message = expectHuman(step.failure).message;
    // The block wrote `report` and forgot `count`: only the one that is missing gets named.
    expect(message).toContain("count");
    expect(message).not.toContain("report");
    expect(message).toContain(store.layout(runId).attemptOutputsDir("partial", 1));
  });

  test("an output that is not a file says what is in its place", async () => {
    const { step } = await runFixture("msg-dir-output.yaml", "notfile");
    expect(step.failure!.code).toBe("output_invalid");
    const message = expectHuman(step.failure).message;
    expect(message).toContain("count");
    expect(message.toLowerCase()).toMatch(/director/);
  });

  test("an output that is not the type it declared says which type it failed", async () => {
    const { step } = await runFixture("msg-bad-integer.yaml", "badint");
    expect(step.failure!.code).toBe("output_invalid");
    const message = expectHuman(step.failure).message;
    expect(message).toContain("count");
    expect(message.toLowerCase()).toMatch(/integer/);
  });

  test("an output that is not text at all says so", async () => {
    const { step } = await runFixture("msg-bad-utf8.yaml", "garbled");
    expect(step.failure!.code).toBe("output_invalid");
    const message = expectHuman(step.failure).message;
    expect(message).toContain("label");
    expect(message.toUpperCase()).toContain("UTF-8");
  });

  test("an output over the size limit says the limit", async () => {
    const { step } = await runFixture("msg-huge-string.yaml", "huge");
    expect(step.failure!.code).toBe("output_too_large");
    const message = expectHuman(step.failure).message;
    expect(message).toContain("blob");
    expect(numbersIn(message).some((n) => n >= 65536)).toBe(true);
  });

  test("a timeout names the step, the limit it hit and how long it ran", async () => {
    const { step } = await runFixture("msg-sleep.yaml", "sleeper");
    expect(step.failure!.code).toBe("timeout");
    const message = expectHuman(step.failure).message;
    expect(message).toContain("sleeper");
    // The pipeline set `timeout: 3s`, and the attempt cannot have ended before that limit was past.
    expect(message).toContain("3s");
    const seconds = [...message.matchAll(/(\d+)s/g)].map((match) => Number(match[1]));
    expect(seconds.some((s) => s >= 3)).toBe(true);
  });

  test("a step that died from a signal names the signal", async () => {
    const { step } = await runFixture("msg-kill.yaml", "selfkill");
    expect(step.failure!.code).toBe("killed_by_signal");
    const message = expectHuman(step.failure).message;
    expect(message).toContain("selfkill");
    expect(message.toUpperCase()).toContain("SIGKILL");
  });

  test("a cancelled step says it was cancelled, and which one it was", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(fixture("slow.yaml"));
    const driving = engine.drive(record.id);
    await Bun.sleep(600);
    await engine.cancel(record.id);
    const final = await driving;

    const step = final.steps.slow!;
    expect(step.status).toBe("cancelled");
    const failure = expectHuman(shown(step));
    expect(failure.code).toBe("cancelled");
    expect(failure.message).toContain("slow");
    expect(failure.message.toLowerCase()).toMatch(/cancel/);
  }, 30_000);

  test("an attempt an engine lost to shutdown says so, and names its step", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const record = await engine.start(fixture("slow.yaml"));
    const driving = engine.drive(record.id);
    const deadline = Date.now() + 10_000;
    while ((await store.loadRun(record.id))?.steps.slow?.attempts[0]?.pid == null && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    await engine.shutdown();
    await driving;

    const stored = (await store.loadRun(record.id))!;
    const failure = expectHuman(shown(stored.steps.slow!));
    expect(failure.code).toBe("interrupted");
    expect(failure.message).toContain("slow");
    expect(failure.message.toLowerCase()).toMatch(/interrupt/);
    expect(failure.message.toLowerCase()).toMatch(/shutdown/);
  }, 30_000);

  test("a step that never started says which one could not be started", async () => {
    const { step } = await runFixture("msg-echo.yaml", "say", { drivePath: "/does/not/exist" });
    expect(step.failure!.code).toBe("spawn_failed");
    const message = expectHuman(step.failure).message;
    expect(message).toContain("say");
    expect(message.toLowerCase()).toMatch(/start|found/);
  });

  test("a missing pass_env names the variable and the step that asked for it", async () => {
    const { step } = await runFixture("msg-pass-env.yaml", "needsenv", {
      startEnv: { MSG_ABSENT_VARIABLE: "set at the start, gone by the attempt" },
      driveEnv: {},
    });
    expect(step.failure!.code).toBe("env_missing");
    const message = expectHuman(step.failure).message;
    expect(message).toContain("needsenv");
    expect(message).toContain("MSG_ABSENT_VARIABLE");
  });

  test("inputs too big for a step name the step and the input", async () => {
    const { step } = await runFixture("msg-big-input.yaml", "swallow", { inputs: { big: "x".repeat(70_000) } });
    expect(step.failure!.code).toBe("input_too_large");
    const message = expectHuman(step.failure).message;
    expect(message).toContain("swallow");
    expect(message).toContain("text");
  });

  test("a missing runtime names the binaries that are missing", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store, path: "/does/not/exist" });
    const error = await caught(() => engine.start(fixture("msg-echo.yaml")));
    expect(error.code).toBe("runtime_missing");
    expectHuman({ code: error.code, message: error.message });
    expect(error.message).toContain("bash");
    expect(error.message).toMatch(/PATH/);
  });

  test("a `uses:` that resolves nowhere names the reference that failed", async () => {
    const store = new FsRunStore(newRoot());
    const engine = new Engine({ store });
    const error = await caught(() => engine.start(fixture("msg-missing-block.yaml")));
    expect(error.code).toBe("block_not_found");
    expectHuman({ code: error.code, message: error.message });
    expect(error.message).toContain("./msg-no-such-block.sh");
    expect(error.path).toBe("steps.gone.uses");
  });
});
