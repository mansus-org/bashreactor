// The timeline, drawn from a run and updated in place. The scale, the bars, the wait before a retry,
// the now line and the keyboard are all read off the nodes it keeps, because those are the things a
// live poll must not rebuild.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Attempt, Run, RunStep } from "./api.ts";
import { FakeElement, installDom, serveModules, uninstallDom } from "./client.testkit.ts";
import type { State as DomState } from "./dom.ts";

const dom = installDom();
const served = serveModules(["timeline"]);
const { drawTimeline, axisStep } = (await import(join(served, "timeline.js"))) as typeof import("./timeline.ts");
const { sign } = (await import(join(served, "dom.js"))) as typeof import("./dom.ts");

const realFocus = FakeElement.prototype.focus;
const focused: FakeElement[] = [];
FakeElement.prototype.focus = function focus(this: FakeElement): void {
  focused.push(this);
};

afterAll(() => {
  FakeElement.prototype.focus = realFocus;
  uninstallDom(dom);
  rmSync(served, { recursive: true, force: true });
});

const T0 = "2026-11-04T10:15:00Z";
const T1 = "2026-11-04T10:15:41Z";
const at = (seconds: number): string => new Date(Date.parse(T0) + seconds * 1000).toISOString();

function attempt(n: number, status: string, from: number, to: number | null): Attempt {
  return {
    n,
    status,
    pid: null,
    pid_start: null,
    started_at: at(from),
    finished_at: to === null ? null : at(to),
    exit_code: null,
    signal: null,
    failure: null,
  };
}

function step(id: string, status: string, attempts: Attempt[], next: string | null = null): RunStep {
  return {
    id,
    name: id,
    status,
    block: { uses: `${id}@1`, name: id, sha256: "0".repeat(64) },
    needs: [],
    with: null,
    outputs: null,
    failure: null,
    attempts_used: attempts.length,
    next_attempt_at: next,
    attempts,
  };
}

function runOf(steps: RunStep[], status: string, finished: string | null): Run {
  return {
    schema: 1,
    id: "20261104T101500Z-3fa9c2d1",
    pipeline: "word-report",
    status,
    created_at: T0,
    finished_at: finished,
    cancel_requested_at: null,
    inputs: {},
    outputs: null,
    claim: null,
    steps: Object.fromEntries(steps.map((entry) => [entry.id, entry])),
  };
}

const nodeOf = (handle: ReturnType<typeof drawTimeline>, stepId: string): FakeElement =>
  handle.node.querySelector(`.timeline__row[data-step="${stepId}"]`) as unknown as FakeElement;
const buttonOf = (handle: ReturnType<typeof drawTimeline>, stepId: string): FakeElement =>
  nodeOf(handle, stepId).querySelector(".timeline__step") as unknown as FakeElement;
const barsOf = (handle: ReturnType<typeof drawTimeline>, stepId: string): FakeElement[] =>
  nodeOf(handle, stepId).querySelectorAll(".timeline__bar");
const shape = (node: FakeElement): string => node.querySelector("svg path")?.getAttribute("d") ?? "";
const signOf = (state: DomState): string => shape(sign(state) as unknown as FakeElement);
const ignore = (): void => {};

describe("the timeline's scale", () => {
  test("runs from the run's created_at to its finished_at, on round labels", () => {
    const run = runOf([step("a", "succeeded", [attempt(1, "succeeded", 0, 41)])], "succeeded", T1);
    const handle = drawTimeline(run, { now: Date.parse(T1), selected: "a", onSelect: ignore });
    const axis = handle.node.querySelector(".timeline__axis") as unknown as FakeElement;

    expect(axis.getAttribute("data-start")).toBe(T0);
    expect(axis.getAttribute("data-end")).toBe(String(Date.parse(T1)));
    expect(axis.getAttribute("data-step")).toBe("10");
    expect(axis.querySelectorAll(".timeline__tick").map((tick) => tick.textContent)).toEqual([
      "0 s",
      "10 s",
      "20 s",
      "30 s",
      "40 s",
    ]);
    expect(axis.querySelectorAll(".timeline__tick").map((tick) => tick.getAttribute("data-at"))).toEqual([
      "0",
      "10",
      "20",
      "30",
      "40",
    ]);
  });

  test("a live run ends at now, and the step chosen is the first one that leaves at most six labels", () => {
    const run = runOf([step("a", "running", [attempt(1, "running", 0, null)])], "running", null);
    const now = Date.parse(T0) + 65_000;
    const handle = drawTimeline(run, { now, selected: "a", onSelect: ignore });
    const axis = handle.node.querySelector(".timeline__axis") as unknown as FakeElement;

    expect(axis.getAttribute("data-end")).toBe(String(now));
    // 65 s would be seven 10 s labels, so the next round step is the one that fits.
    expect(axis.getAttribute("data-step")).toBe("30");
    expect(axisStep(41)).toBe(10);
    expect(axisStep(3600)).toBe(900);
    expect(axisStep(86_400)).toBe(21_600);
    expect(axisStep(86_400 * 6)).toBe(86_400);
  });
});

describe("the bars on the timeline", () => {
  test("one per attempt, filled by that attempt's status, from its start to its end", () => {
    const retried = step("build", "running", [attempt(1, "failed", 0, 10), attempt(2, "running", 20, null)]);
    const run = runOf([retried], "running", null);
    const handle = drawTimeline(run, { now: Date.parse(T0) + 30_000, selected: "build", onSelect: ignore });
    const bars = barsOf(handle, "build");

    expect(bars.length).toBe(2);
    expect(bars.map((bar) => bar.getAttribute("data-attempt"))).toEqual(["1", "2"]);
    expect(bars.map((bar) => bar.getAttribute("data-status"))).toEqual(["failed", "running"]);
    expect(bars.map((bar) => bar.getAttribute("data-from"))).toEqual(["0", "20"]);
    expect(bars.map((bar) => bar.getAttribute("data-to"))).toEqual(["10", "30"]);
    expect(bars[0]!.classList.contains("timeline__bar--failed")).toBe(true);
    expect(bars[1]!.classList.contains("timeline__bar--running")).toBe(true);
    expect(buttonOf(handle, "build").textContent).toContain("×2");
  });

  test("a step waiting to retry has a dashed outline from the last attempt to the due time", () => {
    const waiting = step("probe", "waiting_retry", [attempt(1, "failed", 0, 10)], at(30));
    const run = runOf([waiting], "running", null);
    const handle = drawTimeline(run, { now: Date.parse(T0) + 20_000, selected: "probe", onSelect: ignore });
    const wait = nodeOf(handle, "probe").querySelector(".timeline__wait") as unknown as FakeElement;

    expect(wait.getAttribute("data-from")).toBe("10");
    expect(wait.getAttribute("data-to")).toBe("30");
    expect(wait.getAttribute("title")).toContain("retries");
  });

  test("a live run has a now line, and a finished one does not", () => {
    const live = runOf([step("build", "running", [attempt(1, "running", 0, null)])], "running", null);
    const liveHandle = drawTimeline(live, { now: Date.parse(T0) + 20_000, selected: "build", onSelect: ignore });
    const now = nodeOf(liveHandle, "build").querySelector(".timeline__now") as unknown as FakeElement;
    expect(now).not.toBe(null);
    expect(Number(now.getAttribute("data-at"))).toBe(100);

    const done = runOf([step("build", "succeeded", [attempt(1, "succeeded", 0, 41)])], "succeeded", T1);
    const doneHandle = drawTimeline(done, { now: Date.parse(T1), selected: "build", onSelect: ignore });
    expect(nodeOf(doneHandle, "build").querySelector(".timeline__now")).toBe(null);
  });
});

describe("a timeline you can walk", () => {
  test("the selected row is the only tab stop, and the arrow keys move the selection", () => {
    const run = runOf(
      [step("a", "succeeded", [attempt(1, "succeeded", 0, 1)]), step("b", "running", [attempt(1, "running", 1, null)]), step("c", "pending", [])],
      "running",
      null,
    );
    const picked: string[] = [];
    const handle = drawTimeline(run, { now: Date.parse(T0) + 10_000, selected: "b", onSelect: (id) => picked.push(id) });

    expect(buttonOf(handle, "a").tabIndex).toBe(-1);
    expect(buttonOf(handle, "b").tabIndex).toBe(0);
    expect(buttonOf(handle, "c").tabIndex).toBe(-1);

    focused.length = 0;
    buttonOf(handle, "b").fire("keydown", { key: "ArrowDown" });
    expect(picked).toEqual(["c"]);
    expect(focused.at(-1)).toBe(buttonOf(handle, "c"));

    buttonOf(handle, "c").fire("keydown", { key: "Home" });
    expect(picked).toEqual(["c", "a"]);
    buttonOf(handle, "a").fire("keydown", { key: "End" });
    expect(picked).toEqual(["c", "a", "c"]);

    handle.update(run, { now: Date.parse(T0) + 10_000, selected: "a", onSelect: (id) => picked.push(id) });
    expect(buttonOf(handle, "a").tabIndex).toBe(0);
    expect(buttonOf(handle, "b").tabIndex).toBe(-1);
  });

  test("a poll patches the rows it already drew and leaves the panel's scroll alone", () => {
    const first = runOf([step("build", "running", [attempt(1, "running", 0, null)])], "running", null);
    const handle = drawTimeline(first, { now: Date.parse(T0) + 10_000, selected: "build", onSelect: ignore });
    const button = buttonOf(handle, "build");
    handle.node.scrollTop = 37;

    const second = runOf([step("build", "succeeded", [attempt(1, "succeeded", 0, 20)])], "running", null);
    handle.update(second, { now: Date.parse(T0) + 20_000, selected: "build", onSelect: ignore });

    expect(buttonOf(handle, "build")).toBe(button);
    expect(handle.node.scrollTop).toBe(37);
    expect(button.getAttribute("aria-selected")).toBe("true");
  });

  test("every status has its own sign and says its word", () => {
    const statuses = ["pending", "running", "waiting_retry", "succeeded", "failed", "skipped", "cancelled", "interrupted"];
    const run = runOf(
      statuses.map((status) => step(status, status, status === "pending" || status === "skipped" ? [] : [attempt(1, status, 0, null)])),
      "running",
      null,
    );
    const handle = drawTimeline(run, { now: Date.parse(T0) + 10_000, selected: "running", onSelect: ignore });
    const shapes = new Map<string, string>();
    for (const status of statuses) {
      const button = buttonOf(handle, status);
      expect(button.getAttribute("aria-label")).toBe(`${status}, ${status}`);
      const drawn = shape(button);
      expect(drawn).not.toBe("");
      shapes.set(status, drawn);
    }
    expect(new Set(shapes.values()).size).toBe(statuses.length);
    expect(shapes.get("failed")).toBe(signOf("failed"));
  });
});
