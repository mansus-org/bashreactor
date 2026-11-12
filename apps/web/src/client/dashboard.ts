// The dashboard: what is happening, and what needs you. Counts and an activity chart read the runs of
// one window; the two run tables are the urgent end of the same answer, and the disk line says whether
// there is room for any of it. A running run makes the screen read again on the fast clock, because a
// run that finishes while you are looking has to stop being "running now" on its own.

import { api, canWrite } from "./api.js";
import type { DiskSpace, RunSummary } from "./api.js";
import { navigate } from "./app.js";
import type { Route } from "./app.js";
import { el, errorBox, sign } from "./dom.js";
import { errorBody, errorWords, state, wallClock } from "./run-shared.js";
import type { Clock } from "./run-shared.js";
import {
  alarm,
  barChart,
  emptyState,
  formatBytes,
  formatCount,
  linkButton,
  meter,
  pageHeader,
  runsTable,
  segmented,
  statusStamp,
} from "./ui.js";
import type { Bar, BarSegment, RunColumn } from "./ui.js";

/** How often the dashboard looks again while a run is going, and while nothing is. */
export const LIVE_POLL_MS = 5_000;
export const IDLE_POLL_MS = 15_000;

export const WINDOW_IDS = ["24h", "7d", "30d"] as const;
export type DashboardWindow = (typeof WINDOW_IDS)[number];

interface WindowSpec {
  /** The words in the control and in an empty table's sentence. */
  label: string;
  count: number;
  unit: "hour" | "day";
}

const WINDOWS: Record<DashboardWindow, WindowSpec> = {
  "24h": { label: "24 h", count: 24, unit: "hour" },
  "7d": { label: "7 d", count: 7, unit: "day" },
  "30d": { label: "30 d", count: 30, unit: "day" },
};

const WINDOW_OPTIONS = WINDOW_IDS.map((value) => ({ value, label: WINDOWS[value].label }));

const COUNT_STATUSES = ["running", "succeeded", "failed", "cancelled"] as const;
type CountStatus = (typeof COUNT_STATUSES)[number];

/** The order the chart's segments stack in, from the baseline up (docs/design/README.md). */
const STACK = ["failed", "cancelled", "running", "succeeded"] as const;
/** The order the legend and a bar's title name them in; the two are read, not stacked. */
const LEGEND = ["succeeded", "running", "failed", "cancelled"] as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function windowOf(value: string | null): DashboardWindow {
  return WINDOW_IDS.includes(value as DashboardWindow) ? (value as DashboardWindow) : "24h";
}

/**
 * The first moment the dashboard counts: the start of the local hour/day `count` units back. Local,
 * because a bar labelled "5 Nov" has to mean the reader's 5 November; the count includes the current,
 * still-running hour or day, which is the one people look at.
 */
export function windowStart(now: number, window: DashboardWindow): number {
  const start = new Date(now);
  if (WINDOWS[window].unit === "hour") {
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() - (WINDOWS[window].count - 1));
  } else {
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (WINDOWS[window].count - 1));
  }
  return start.getTime();
}

function bucketStarts(start: number, spec: WindowSpec): number[] {
  const cursor = new Date(start);
  const out = [cursor.getTime()];
  for (let index = 1; index < spec.count; index += 1) {
    // Moving through local setters rather than adding a fixed number of milliseconds keeps the bars
    // on local hour and day edges when a daylight-saving change makes a day 23 or 25 hours long.
    if (spec.unit === "hour") cursor.setHours(cursor.getHours() + 1);
    else cursor.setDate(cursor.getDate() + 1);
    out.push(cursor.getTime());
  }
  return out;
}

const pair = (value: number): string => String(value).padStart(2, "0");

function bucketLabel(start: number, unit: WindowSpec["unit"]): string {
  const at = new Date(start);
  const day = `${at.getDate()} ${MONTHS[at.getMonth()]}`;
  return unit === "hour" ? `${day}, ${pair(at.getHours())}:00` : day;
}

function newestFirst(a: RunSummary, b: RunSummary): number {
  return b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);
}

export interface DashboardModel {
  counts: Record<CountStatus, number>;
  bars: Bar[];
  running: RunSummary[];
  failed: RunSummary[];
  /** Whether anything at all is in this window or running now; false is the "No runs yet." screen. */
  hasRuns: boolean;
}

/**
 * Everything the screen says about a set of runs, in one place and with no DOM in it. `now` is the
 * right-hand edge of the window, so a test can put a run at either side of a boundary and see which
 * bar and which count it lands in.
 */
export function dashboardModel(
  runs: RunSummary[],
  running: RunSummary[],
  window: DashboardWindow,
  now: number,
): DashboardModel {
  const spec = WINDOWS[window];
  const start = windowStart(now, window);
  const starts = bucketStarts(start, spec);
  const inWindow = runs.filter((run) => {
    const at = Date.parse(run.created_at);
    return !Number.isNaN(at) && at >= start && at <= now;
  });
  const live = running.filter((run) => run.status === "running").toSorted(newestFirst);
  const counts: Record<CountStatus, number> = {
    running: live.length,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };
  const stacked = starts.map(() => ({ failed: 0, cancelled: 0, running: 0, succeeded: 0 }));

  for (const run of inWindow) {
    if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
      counts[run.status] += 1;
    }
    if (!STACK.includes(run.status as (typeof STACK)[number])) continue;
    const at = Date.parse(run.created_at);
    let index = starts.length - 1;
    while (index > 0 && starts[index]! > at) index -= 1;
    const bucket = stacked[index]!;
    bucket[run.status as keyof typeof bucket] += 1;
  }

  const bars = starts.map((bucketStart, index) => {
    const countsForBucket = stacked[index]!;
    const segments: BarSegment[] = STACK.map((status) => ({ status, value: countsForBucket[status] }));
    const label = bucketLabel(bucketStart, spec.unit);
    const named = LEGEND.map((status) => `${formatCount(countsForBucket[status])} ${status}`).filter(
      (_entry, at) => countsForBucket[LEGEND[at]!] > 0,
    );
    return {
      key: String(bucketStart),
      label,
      title: named.length === 0 ? `${label} · no runs` : `${label} · ${named.join(", ")}`,
      segments,
    };
  });

  return {
    counts,
    bars,
    running: live,
    failed: inWindow.filter((run) => run.status === "failed").toSorted(newestFirst),
    hasRuns: inWindow.length > 0 || live.length > 0,
  };
}

function countHref(status: CountStatus, window: DashboardWindow): string {
  return status === "running"
    ? "/app/runs?status=running"
    : `/app/runs?status=${status}&window=${window}`;
}

function failedHref(window: DashboardWindow): string {
  return `/app/runs?status=failed&window=${window}`;
}

/** The one legend the bar chart cannot draw when a status has no runs in the window. */
// BASHR-62: candidate for ui.ts — barChart's legend lists only the tones present in its bars.
function allStatusesLegend(): HTMLElement {
  return el(
    "div",
    { class: "chart__legend", "aria-label": "Statuses" },
    ...LEGEND.map((status) =>
      el(
        "span",
        { class: `chart__legend-entry chart__legend-entry--${status}` },
        el("span", { class: `swatch swatch--${status}`, "aria-hidden": "true" }),
        sign(state(status)),
        status,
      ),
    ),
  );
}

/** The chart's title is also its hidden table's row label, so it names the hour or the day. */
function chartFor(model: DashboardModel, window: DashboardWindow): HTMLElement {
  return barChart({
    bars: model.bars,
    height: 160,
    yLabel: WINDOWS[window].unit === "hour" ? "Runs per hour" : "Runs per day",
    yFormat: (value) => formatCount(value),
    legend: false,
  });
}

const TABLE_COLUMNS: RunColumn[] = ["run", "pipeline", "started", "duration", "steps"];
const FAILED_COLUMNS: RunColumn[] = ["run", "pipeline", "started", "steps"];

interface Tile {
  node: HTMLAnchorElement;
  number: HTMLElement;
}

function tile(status: CountStatus, window: DashboardWindow): Tile {
  const number = el("span", { class: "figure" });
  const node = el(
    "a",
    { class: "dash-count", href: countHref(status, window), "data-link": "" },
    statusStamp(status),
    number,
  );
  return { node, number };
}

/**
 * Read every page of the window's runs. The API pages by cursor, so stopping after the first page
 * would draw a 24-hour chart whose oldest half is simply missing.
 */
async function readWindowRuns(since: string): Promise<RunSummary[]> {
  const all: RunSummary[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await api.listRuns({ since, limit: 500, cursor });
    all.push(...page.runs);
    const next = page.next;
    if (next === null || next === "") break;
    if (seen.has(next)) throw new Error(`The API repeated the cursor ${next}.`);
    seen.add(next);
    cursor = next;
  }
  return all;
}

/**
 * Start `again` whenever the tab is shown, the way run-shared's whenShown does. The removal is
 * guarded because the client stand-in DOM used by the sign-in tests has no removeEventListener, and
 * a dashboard reached from that test must still abort cleanly; a browser always has the method.
 */
function whenShownAgain(signal: AbortSignal, again: () => void): void {
  const onVisibility = (): void => {
    if (!document.hidden && !signal.aborted) again();
  };
  document.addEventListener("visibilitychange", onVisibility);
  signal.addEventListener("abort", () => {
    if (typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
  });
}

interface DashboardData {
  runs: RunSummary[];
  running: RunSummary[];
  disk: DiskSpace;
}

function writeWindow(window: DashboardWindow): void {
  const url = new URL(location.href);
  url.searchParams.set("window", window);
  history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

export function renderDashboard(view: HTMLElement, route: Route, signal: AbortSignal, clock: Clock = wallClock): void {
  let currentWindow = windowOf(route.query.get("window"));

  const control = segmented("Window", WINDOW_OPTIONS, currentWindow, (value) => {
    currentWindow = windowOf(value);
    writeWindow(currentWindow);
    void tick();
  });
  const header = pageHeader({ title: "Dashboard", actions: [control] });
  const alarmSlot = el("div", { class: "dash-alarm" });
  const note = el("p", { class: "dash-note", role: "status", hidden: true });
  const failureSlot = el("div", { class: "dash-failure" });
  const actionSlot = el("div", { class: "dash-failure" });
  const bodySlot = el("div", { class: "dash-body" });
  const diskNode = el("section", { class: "dash-disk", "aria-label": "Disk" });
  const content = el("div", { class: "dash" }, bodySlot, diskNode);
  view.replaceChildren(header, alarmSlot, note, failureSlot, actionSlot, content);

  let tiles: Map<CountStatus, Tile> | null = null;
  let activitySlot: HTMLElement | null = null;
  let runningTable: ReturnType<typeof runsTable> | null = null;
  let failedTable: ReturnType<typeof runsTable> | null = null;
  let failedAll: HTMLAnchorElement | null = null;
  let fullBuilt = false;
  let emptyShown = false;
  let seen = false;
  let lastBusy = false;
  let alarmKey = "";
  let reading = false;
  let again = false;
  let unmake: (() => void) | null = null;

  function paintAlarm(disk: DiskSpace): void {
    const key = disk.low ? `low:${disk.free_bytes}:${disk.total_bytes}` : "";
    if (key === alarmKey) return;
    alarmKey = key;
    if (!disk.low) {
      alarmSlot.replaceChildren();
      return;
    }
    alarmSlot.replaceChildren(
      alarm({
        status: "failed",
        lead: "Disk almost full",
        text: `· ${formatBytes(disk.free_bytes)} free of ${formatBytes(disk.total_bytes)}.`,
        actions: [linkButton("Settings", "/app/settings")],
      }),
    );
  }

  function paintDisk(disk: DiskSpace): void {
    const total = Math.max(0, disk.total_bytes);
    const used = Math.max(0, disk.used_bytes);
    const percent = total > 0 ? Math.round((used / total) * 100) : 0;
    const fraction = total > 0 ? used / total : 0;
    const label = `Disk ${percent}% used · ${formatBytes(disk.free_bytes)} free of ${formatBytes(total)} · runs ${formatBytes(disk.runs_bytes)}`;
    diskNode.replaceChildren(meter(fraction, label));
  }

  function failedEmpty(): string {
    return `No failed runs in the last ${WINDOWS[currentWindow].label}.`;
  }

  async function retry(run: RunSummary): Promise<void> {
    actionSlot.replaceChildren();
    try {
      await api.retryRun(run.id);
      navigate(`/runs/${run.id}`);
    } catch (caught) {
      actionSlot.replaceChildren(errorBox(errorBody(caught)));
    }
  }

  function buildFull(): void {
    const built = new Map<CountStatus, Tile>();
    const counts = el(
      "div",
      { class: "dash-counts" },
      ...COUNT_STATUSES.map((status) => {
        const entry = tile(status, currentWindow);
        built.set(status, entry);
        return entry.node;
      }),
    );
    tiles = built;

    activitySlot = el("div", { class: "dash-activity__chart" });
    const activity = el(
      "section",
      { class: "dash-activity", "aria-labelledby": "dash-activity-title" },
      el("h2", { class: "h2", id: "dash-activity-title" }, "Activity"),
      activitySlot,
      allStatusesLegend(),
    );

    runningTable = runsTable({ columns: TABLE_COLUMNS, empty: "Nothing is running." });
    failedTable = runsTable({
      columns: FAILED_COLUMNS,
      empty: failedEmpty(),
      retry: canWrite(),
      onRetry: (run) => void retry(run),
    });
    failedAll = el("a", { href: failedHref(currentWindow), "data-link": "" }, "View all");
    const runningAll = el("a", { href: "/app/runs?status=running", "data-link": "" }, "View all");
    const tables = el(
      "div",
      { class: "dash-pair" },
      el(
        "section",
        { class: "dash-panel", "aria-label": "Running now" },
        el("div", { class: "dash-panel__head" }, el("h2", { class: "h2" }, "Running now"), runningAll),
        runningTable.node,
      ),
      el(
        "section",
        { class: "dash-panel", "aria-label": "Failed" },
        el("div", { class: "dash-panel__head" }, el("h2", { class: "h2" }, "Failed"), failedAll),
        failedTable.node,
      ),
    );
    bodySlot.replaceChildren(counts, activity, tables);
    fullBuilt = true;
  }

  function paintFull(model: DashboardModel): void {
    if (!fullBuilt) buildFull();
    for (const status of COUNT_STATUSES) {
      const entry = tiles?.get(status);
      if (entry === undefined) continue;
      entry.number.textContent = formatCount(model.counts[status]);
      entry.node.setAttribute("href", countHref(status, currentWindow));
    }
    if (activitySlot !== null) activitySlot.replaceChildren(chartFor(model, currentWindow));
    runningTable?.update(model.running.slice(0, 10));
    const failed = model.failed.slice(0, 10);
    failedTable?.update(failed);
    if (failed.length === 0) {
      const empty = failedTable?.node.querySelector(".table__empty-text");
      if (empty !== null && empty !== undefined) empty.textContent = failedEmpty();
    }
    failedAll?.setAttribute("href", failedHref(currentWindow));
  }

  function paint(data: DashboardData): void {
    const model = dashboardModel(data.runs, data.running, currentWindow, clock.now());
    seen = true;
    lastBusy = model.running.length > 0;
    note.hidden = true;
    failureSlot.replaceChildren();
    paintAlarm(data.disk);
    paintDisk(data.disk);
    if (!model.hasRuns) {
      if (!emptyShown) {
        bodySlot.replaceChildren(
          emptyState("No runs yet.", linkButton("Pipelines", "/app/pipelines", { primary: true })),
        );
        fullBuilt = false;
        emptyShown = true;
      }
      return;
    }
    emptyShown = false;
    paintFull(model);
  }

  function tell(error: unknown): void {
    if (seen) {
      // Rows already on the page stay, under the line that says the reading may be out of date: a
      // server that cannot be reached is not a dashboard with nothing on it.
      note.textContent = `Lost the server, still trying. ${errorWords(error)}`;
      note.hidden = false;
      return;
    }
    note.hidden = true;
    failureSlot.replaceChildren(
      errorBox(errorBody(error), linkButton("Pipelines", "/app/pipelines")),
    );
  }

  async function tick(): Promise<void> {
    unmake?.();
    unmake = null;
    if (signal.aborted || document.hidden) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    const wanted = currentWindow;
    const since = new Date(windowStart(clock.now(), wanted)).toISOString();
    let data: DashboardData | null = null;
    let error: unknown = null;
    try {
      const [runs, running, disk] = await Promise.all([
        readWindowRuns(since),
        api.listRuns({ status: ["running"], limit: 50 }),
        api.disk(),
      ]);
      data = { runs, running: running.runs, disk };
    } catch (caught) {
      error = caught;
    }
    reading = false;
    if (signal.aborted) return;
    if (wanted !== currentWindow) {
      // The window changed while the read was in the air. Putting this answer on screen would label
      // a 7-day read as 24 hours, so it is dropped and the new window is read now.
      void tick();
      return;
    }
    if (data !== null) paint(data);
    else tell(error);
    if (again) {
      again = false;
      void tick();
      return;
    }
    if (document.hidden) return;
    // A lost read says nothing about what was running, so the last known pace is kept: the run this
    // page saw going may still be going, and a server that is down is not a reason to slow down.
    const busy = data === null ? lastBusy : data.running.some((run) => run.status === "running");
    unmake = clock.after(busy ? LIVE_POLL_MS : IDLE_POLL_MS, () => void tick());
  }

  whenShownAgain(signal, () => void tick());
  signal.addEventListener("abort", () => unmake?.());
  void tick();
}
