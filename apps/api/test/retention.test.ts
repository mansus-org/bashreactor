// The trim (SPEC 6): `BASHREACTOR_RETENTION` in, old run directories out.
//
// The sweep is the only code in this repo allowed to delete a run nobody asked for, so most of what
// these tests pin down is what it refuses. They drive it against a fake engine that records calls —
// the real deletion is `apps/engine/test/delete-run.test.ts`, and the two meet at
// `apps/api/test/delete-run.test.ts`.

import { describe, expect, test } from "bun:test";
import { BashreactorError } from "@bashreactor/core";
import type { RunRecord } from "@bashreactor/engine";
import { durationText, startRetention, sweepRuns, type RunsThatCanBeDeleted } from "../src/retention.ts";
import { resolveRetentionMs } from "../src/config.ts";

const NOW = new Date("2026-11-06T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * `sweepRuns` reads `id`, `status` and `finished_at` and nothing else, so a test can say the one
 * fact it is about instead of assembling a whole run record.
 */
const run = (id: string, status: string, finished_at: string | null) =>
  ({ id, status, finished_at }) as unknown as RunRecord;

interface FakeEngine extends RunsThatCanBeDeleted {
  calls: string[];
  refused: Map<string, BashreactorError | Error>;
}

function fakeEngine(...records: RunRecord[]): FakeEngine {
  const byId = new Map(records.map((record) => [record.id, record]));
  const refused = new Map<string, BashreactorError | Error>();
  const calls: string[] = [];
  return {
    calls,
    refused,
    async listRuns() {
      return [...byId.keys()];
    },
    async getRun(runId) {
      return byId.get(runId) ?? null;
    },
    async deleteRun(runId) {
      calls.push(runId);
      const error = refused.get(runId);
      if (error !== undefined) throw error;
      byId.delete(runId);
    },
  };
}

describe("BASHREACTOR_RETENTION", () => {
  test("unset, empty, off and none all mean the server never deletes a run", () => {
    for (const raw of [undefined, "", "off", "none", "  off  "]) {
      expect(resolveRetentionMs({ BASHREACTOR_RETENTION: raw })).toBeNull();
    }
  });

  test("a duration is read in the SPEC 1.3 format, whatever case it arrives in", () => {
    expect(resolveRetentionMs({ BASHREACTOR_RETENTION: "7d" })).toBe(7 * DAY);
    expect(resolveRetentionMs({ BASHREACTOR_RETENTION: " 12H " })).toBe(12 * HOUR);
    expect(resolveRetentionMs({ BASHREACTOR_RETENTION: "90m" })).toBe(90 * 60_000);
    expect(resolveRetentionMs({ BASHREACTOR_RETENTION: "45s" })).toBe(45_000);
  });

  test("zero is off, not 'delete everything'", () => {
    expect(resolveRetentionMs({ BASHREACTOR_RETENTION: "0" })).toBeNull();
    expect(resolveRetentionMs({ BASHREACTOR_RETENTION: "0s" })).toBeNull();
  });

  test("a duration that does not parse stops the server rather than guessing", () => {
    for (const raw of ["7", "seven days", "7 days", "d7", "7w"]) {
      expect(() => resolveRetentionMs({ BASHREACTOR_RETENTION: raw })).toThrow(
        expect.objectContaining({ code: "runtime_missing", message: expect.stringContaining("BASHREACTOR_RETENTION") }),
      );
    }
  });
});

describe("durationText", () => {
  test("a duration comes back the way the operator wrote it", () => {
    expect(durationText(7 * DAY)).toBe("7d");
    expect(durationText(12 * HOUR)).toBe("12h");
    expect(durationText(90 * 60_000)).toBe("1h30m");
    expect(durationText(90_000)).toBe("1m30s");
    expect(durationText(0)).toBe("0s");
    expect(durationText(25 * HOUR + 30 * 60_000)).toBe("1d1h30m");
  });
});

describe("sweepRuns", () => {
  test("only a run that finished before the cutoff goes", async () => {
    const engine = fakeEngine(
      run("old", "succeeded", new Date(NOW.getTime() - 8 * DAY).toISOString()),
      run("exactly-the-cutoff", "succeeded", new Date(NOW.getTime() - 7 * DAY).toISOString()),
      run("recent", "succeeded", new Date(NOW.getTime() - 6 * DAY).toISOString()),
      run("failed-long-ago", "failed", new Date(NOW.getTime() - 30 * DAY).toISOString()),
    );

    const report = await sweepRuns(engine, 7 * DAY, { now: NOW });

    expect(report.deleted).toEqual(["old", "exactly-the-cutoff", "failed-long-ago"]);
    expect(engine.calls).toEqual(["old", "exactly-the-cutoff", "failed-long-ago"]);
    expect(report.kept).toBe(1);
    expect(report.problem).toBeNull();
    expect(report.cutoff).toBe(new Date(NOW.getTime() - 7 * DAY).toISOString());
  });

  test("a run that is running, waiting, or has no finished_at is never touched", async () => {
    const ancient = new Date(NOW.getTime() - 400 * DAY).toISOString();
    const engine = fakeEngine(
      run("running", "running", ancient),
      run("waiting", "waiting", ancient),
      run("no-finished-at", "succeeded", null),
      run("garbage-finished-at", "succeeded", "yesterday"),
    );

    const report = await sweepRuns(engine, HOUR, { now: NOW });

    expect(report.deleted).toEqual([]);
    expect(engine.calls).toEqual([]);
    expect(report.kept).toBe(4);
    expect(report.problem).toBeNull();
  });

  test("a run that refuses is kept, and the sweep carries on with the rest", async () => {
    const ancient = new Date(NOW.getTime() - 40 * DAY).toISOString();
    const engine = fakeEngine(
      run("claimed", "succeeded", ancient),
      run("gone", "succeeded", ancient),
      run("also-old", "succeeded", ancient),
    );
    engine.refused.set("claimed", new BashreactorError("run_claimed", "engine 4242 holds this run"));
    engine.refused.set("gone", new BashreactorError("run_not_found", "\"gone\" is not a run id"));

    const report = await sweepRuns(engine, DAY, { now: NOW });

    expect(report.deleted).toEqual(["also-old"]);
    expect(report.kept).toBe(2);
    // Neither refusal is a problem with the sweep: one is a run being written into, the other a run
    // someone else deleted mid-pass. Both are ordinary, and neither belongs in a log line.
    expect(report.problem).toBeNull();
  });

  test("a run that vanished between the listing and the read is not even counted", async () => {
    const engine = fakeEngine(run("here", "succeeded", new Date(NOW.getTime() - 9 * DAY).toISOString()));
    const report = await sweepRuns(engine, DAY, { now: NOW });
    expect(report.deleted).toEqual(["here"]);
    // The same engine, emptied: the listing still names it, the read says nothing.
    const empty = fakeEngine();
    (empty as any).listRuns = async () => ["vanished"];
    const second = await sweepRuns(empty, DAY, { now: NOW });
    expect(second).toEqual({ cutoff: report.cutoff, deleted: [], kept: 0, problem: null });
  });

  test("an error that is not a refusal is kept as one problem, and the pass still finishes", async () => {
    const ancient = new Date(NOW.getTime() - 40 * DAY).toISOString();
    const engine = fakeEngine(
      run("first", "succeeded", ancient),
      run("second", "succeeded", ancient),
      run("third", "succeeded", ancient),
    );
    engine.refused.set("second", new Error("EIO: i/o error, unlink"));

    const report = await sweepRuns(engine, DAY, { now: NOW });

    expect(report.deleted).toEqual(["first", "third"]);
    expect(report.kept).toBe(1);
    expect(report.problem).toBe("EIO: i/o error, unlink");
  });

  test("an engine that cannot even list the runs passes the error up", async () => {
    const engine = fakeEngine();
    (engine as any).listRuns = async () => {
      throw new Error("EACCES: permission denied");
    };
    await expect(sweepRuns(engine, DAY, { now: NOW })).rejects.toThrow("EACCES");
  });
});

describe("startRetention", () => {
  test("retention off means no sweep, ever", async () => {
    let sweeps = 0;
    const stop = startRetention(fakeEngine(), null, {
      intervalMs: 5,
      sweep: async () => {
        sweeps += 1;
        return { cutoff: "", deleted: [], kept: 0, problem: null };
      },
    });
    await Bun.sleep(30);
    stop();
    expect(sweeps).toBe(0);
  });

  test("it sweeps once at once, then on the interval, until it is stopped", async () => {
    let sweeps = 0;
    const stop = startRetention(fakeEngine(), DAY, {
      intervalMs: 10,
      sweep: async () => {
        sweeps += 1;
        return { cutoff: "", deleted: [], kept: 0, problem: null };
      },
    });
    expect(sweeps).toBe(1);
    for (let i = 0; i < 200; i += 1) {
      if (sweeps >= 3) break;
      await Bun.sleep(10);
    }
    expect(sweeps).toBeGreaterThanOrEqual(3);
    stop();
    const after = sweeps;
    await Bun.sleep(50);
    expect(sweeps).toBe(after);
  });

  test("a pass that removed something says so, in the units the operator set", async () => {
    const lines: string[] = [];
    const engine = fakeEngine(run("old", "succeeded", new Date(Date.now() - 40 * DAY).toISOString()));
    const stop = startRetention(engine, 7 * DAY, { intervalMs: 60_000, log: (line) => lines.push(line) });
    await Bun.sleep(20);
    stop();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("removed 1 run(s)");
    expect(lines[0]).toContain("7d ago");
    expect(lines[0]).toContain("kept 0");
  });

  test("a pass that found nothing to do says nothing", async () => {
    const lines: string[] = [];
    const engine = fakeEngine(run("recent", "succeeded", new Date().toISOString()));
    const stop = startRetention(engine, 7 * DAY, { intervalMs: 60_000, log: (line) => lines.push(line) });
    await Bun.sleep(20);
    stop();
    expect(lines).toEqual([]);
  });

  test("a sweep that cannot run is a log line, not an exception in the timer", async () => {
    const lines: string[] = [];
    const engine = fakeEngine();
    (engine as any).listRuns = async () => {
      throw new Error("EACCES: permission denied");
    };
    const stop = startRetention(engine, DAY, { intervalMs: 60_000, log: (line) => lines.push(line) });
    await Bun.sleep(20);
    stop();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("retention sweep failed");
    expect(lines[0]).toContain("EACCES");
  });

  test("a problem inside a pass is logged once, with the runs it also removed", async () => {
    const lines: string[] = [];
    const ancient = new Date(Date.now() - 40 * DAY).toISOString();
    const engine = fakeEngine(run("gone", "succeeded", ancient), run("broken", "succeeded", ancient));
    engine.refused.set("broken", new Error("EIO: i/o error, unlink"));
    const stop = startRetention(engine, DAY, { intervalMs: 60_000, log: (line) => lines.push(line) });
    await Bun.sleep(20);
    stop();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("removed 1 run(s)");
    expect(lines[0]).toContain("EIO");
  });
});
