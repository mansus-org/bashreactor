// A run's steps over time: one row per step in the order the pipeline declares them, one bar per
// attempt, and the wait before a retry. It is built once and patched in place because it is redrawn
// while the run is live: the step buttons, their focus and the panel's scroll are never thrown away.

import type { Attempt, Run, RunStep } from "./api.js";
import { el, sign } from "./dom.js";
import { state as stateOf } from "./run-shared.js";

/** The round steps the axis may use, in seconds. The first one that keeps the labels readable wins. */
export const AXIS_STEPS = [1, 5, 10, 30, 60, 300, 900, 1800, 3600, 10_800, 21_600, 43_200, 86_400] as const;

export interface TimelineOptions {
  /** What now is on the clock the screen was given, so the live end of the axis moves with it. */
  now: number;
  selected: string;
  onSelect: (stepId: string) => void;
}

export interface Timeline {
  readonly node: HTMLElement;
  update(run: Run, options: TimelineOptions): void;
  select(stepId: string): void;
  focus(stepId: string): void;
  flash(stepIds: string[]): void;
}

interface Row {
  row: HTMLElement;
  button: HTMLButtonElement;
  track: HTMLElement;
}

function instant(iso: string | null): number | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

function startOf(run: Run): number {
  return instant(run.created_at) ?? 0;
}

function endOf(run: Run, now: number, start: number): number {
  const finished = instant(run.finished_at);
  return Math.max(start, finished ?? now);
}

/** The first round step that leaves at most six labels across the run. */
export function axisStep(spanSeconds: number): number {
  const span = Math.max(1, spanSeconds);
  return AXIS_STEPS.find((step) => span / step <= 6) ?? AXIS_STEPS[AXIS_STEPS.length - 1]!;
}

function axisLabel(seconds: number): string {
  if (seconds === 0) return "0 s";
  for (const [size, suffix] of [
    [86_400, "d"],
    [3600, "h"],
    [60, "m"],
    [1, "s"],
  ] as const) {
    if (seconds >= size && seconds % size === 0) return `${seconds / size} ${suffix}`;
  }
  return `${seconds} s`;
}

function lastAttempt(step: RunStep): Attempt | null {
  return step.attempts.length === 0 ? null : step.attempts[step.attempts.length - 1]!;
}

/** Put one bar on the shared scale: a percentage from the run's start, never outside the track. */
function place(element: HTMLElement, from: number, to: number, start: number, span: number): void {
  const left = Math.max(0, Math.min(100, ((from - start) / span) * 100));
  const right = Math.max(left, Math.min(100, ((to - start) / span) * 100));
  element.style.left = `${left}%`;
  element.style.width = `${Math.max(0.4, right - left)}%`;
}

/**
 * Draw one run's timeline. The returned handle updates the same nodes on every poll; it adds and
 * removes a row only when the run's steps themselves change.
 */
export function drawTimeline(run: Run, options: TimelineOptions): Timeline {
  const node = el("section", { class: "timeline", "aria-label": "Steps over time" });
  const grid = el("div", { class: "timeline__grid" });
  const axis = el("div", { class: "timeline__axis", "aria-hidden": "true" });
  const rows = new Map<string, Row>();
  let order: string[] = [];
  let latest = run;
  let selected = options.selected;
  let stop = options.onSelect;

  grid.append(el("div", { class: "timeline__corner" }, "Step"), axis);
  node.append(grid);

  function move(stepId: string, key: string): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return;
    const at = order.indexOf(stepId);
    if (at === -1) return;
    const next =
      key === "Home"
        ? order[0]
        : key === "End"
          ? order[order.length - 1]
          : key === "ArrowDown"
            ? order[Math.min(order.length - 1, at + 1)]
            : order[Math.max(0, at - 1)];
    if (next === undefined || next === stepId) return;
    stop(next);
    rows.get(next)?.button.focus();
  }

  function makeRow(stepId: string): Row {
    const button = el("button", {
      class: "timeline__step",
      type: "button",
      "data-step": stepId,
      "aria-selected": "false",
      tabindex: "-1",
      onclick: () => stop(stepId),
    });
    button.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return;
      (event as KeyboardEvent).preventDefault();
      move(stepId, key);
    });
    const track = el("div", { class: "timeline__track", "aria-hidden": "true" });
    const row = el("div", { class: "timeline__row", "data-step": stepId }, button, track);
    grid.append(row);
    return { row, button, track };
  }

  function ensureRows(next: Run): void {
    order = Object.keys(next.steps);
    for (const stepId of order) if (!rows.has(stepId)) rows.set(stepId, makeRow(stepId));
    for (const [stepId, row] of rows) {
      if (order.includes(stepId)) continue;
      row.row.remove();
      rows.delete(stepId);
    }
  }

  function paintTrack(step: RunStep, track: HTMLElement, start: number, span: number, now: number): void {
    track.replaceChildren();
    for (const attempt of step.attempts) {
      const began = instant(attempt.started_at);
      if (began === null) continue;
      const ended = instant(attempt.finished_at) ?? now;
      const bar = el("span", {
        class: `timeline__bar timeline__bar--${stateOf(attempt.status)}`,
        "data-attempt": String(attempt.n),
        "data-status": attempt.status,
        "data-from": String((began - start) / 1000),
        "data-to": String((ended - start) / 1000),
        title: `${step.id} attempt ${attempt.n} · ${attempt.status}`,
      });
      place(bar, began, ended, start, span);
      track.append(bar);
    }

    if (step.status === "waiting_retry") {
      const last = lastAttempt(step);
      const from = last === null ? null : (instant(last.finished_at) ?? instant(last.started_at));
      const due = instant(step.next_attempt_at);
      if (from !== null && due !== null && due > from) {
        const wait = el("span", {
          class: "timeline__wait",
          "data-from": String((from - start) / 1000),
          "data-to": String((due - start) / 1000),
          title: `${step.id} retries at ${new Date(due).toISOString()}`,
        });
        place(wait, from, due, start, span);
        track.append(wait);
      }
    }

    if (latest.status === "running") {
      const marker = el("span", {
        class: "timeline__now",
        "data-at": String(((now - start) / span) * 100),
        title: "now",
      });
      marker.style.left = `${Math.max(0, Math.min(100, ((now - start) / span) * 100))}%`;
      track.append(marker);
    }
  }

  function paintAxis(start: number, end: number, span: number): void {
    const seconds = span / 1000;
    const step = axisStep(seconds);
    axis.replaceChildren();
    axis.setAttribute("data-start", latest.created_at);
    axis.setAttribute("data-start-ms", String(start));
    axis.setAttribute("data-end", String(end));
    axis.setAttribute("data-step", String(step));
    for (let at = 0; at <= seconds + 0.001; at += step) {
      // The final label sits at the right edge, so it has to grow leftwards or it is clipped.
      const atEnd = at / seconds >= 0.999;
      const tick = el(
        "span",
        { class: `timeline__tick${atEnd ? " timeline__tick--end" : ""}`, "data-at": String(at) },
        axisLabel(Math.round(at)),
      );
      tick.style.left = `${(at / seconds) * 100}%`;
      axis.append(tick);
    }
  }

  function update(next: Run, nextOptions: TimelineOptions): void {
    latest = next;
    selected = nextOptions.selected;
    stop = nextOptions.onSelect;
    ensureRows(next);
    const start = startOf(next);
    const end = endOf(next, nextOptions.now, start);
    const span = Math.max(1000, end - start);
    paintAxis(start, end, span);

    for (const stepId of order) {
      const row = rows.get(stepId);
      const step = next.steps[stepId];
      if (row === undefined || step === undefined) continue;
      const attempts = step.attempts.length;
      const stamp = stateOf(step.status);
      row.button.replaceChildren(
        sign(stamp),
        el("span", { class: "timeline__id" }, stepId, attempts > 1 ? el("span", { class: "timeline__attempts" }, ` ×${attempts}`) : null),
      );
      row.button.setAttribute("aria-selected", String(stepId === selected));
      row.button.setAttribute("aria-label", `${stepId}, ${stamp}`);
      row.button.tabIndex = stepId === selected ? 0 : -1;
      row.row.setAttribute("aria-current", stepId === selected ? "true" : "false");
      paintTrack(step, row.track, start, span, nextOptions.now);
    }
  }

  update(run, options);

  return {
    node,
    update,
    select(stepId) {
      selected = stepId;
      for (const [id, row] of rows) {
        row.button.setAttribute("aria-selected", String(id === stepId));
        row.button.tabIndex = id === stepId ? 0 : -1;
        row.row.setAttribute("aria-current", id === stepId ? "true" : "false");
      }
    },
    focus(stepId) {
      rows.get(stepId)?.button.focus();
    },
    flash(stepIds) {
      for (const stepId of stepIds) {
        const row = rows.get(stepId)?.row;
        if (row === undefined) continue;
        row.classList.remove("is-new");
        void row.offsetWidth;
        row.classList.add("is-new");
      }
    },
  };
}
