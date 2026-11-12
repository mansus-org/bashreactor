// The dashboard's behaviours: the pure window arithmetic, the counts and bars it draws from it, the
// two run tables, and the clock it reads on. The DOM and the fake server are the run screens' test
// kit; the module itself comes from the bytes the server serves, as every client test does.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveModules } from "./client.testkit.ts";
import {
  FakeClock,
  FakeElement,
  buildAssets,
  controllers,
  fakeDocument,
  installRunsGlobals,
  one,
  reply,
  restoreRunsGlobals,
  showTab,
  waitFor,
} from "./runs.testkit.ts";
import type { DiskSpace, RunSummary } from "./api.ts";

// The testkit put the stand-in browser up when the first file imported it; a file that ran since may
// have taken it down, and the modules below read `localStorage` the moment they are imported.
installRunsGlobals();
const served = serveModules(["dashboard"]);
writeFileSync(join(served, "app.js"), "export function navigate(path) { globalThis.bashrNavigated = path; }\n");
const { renderDashboard, dashboardModel, windowStart, LIVE_POLL_MS, IDLE_POLL_MS } = (await import(
  join(served, "dashboard.js")
)) as typeof import("./dashboard.ts");
const dashboardApi = (await import(join(served, "api.js"))) as typeof import("./api.ts");

const NOW = "2026-11-05T14:37:00Z";
const now = Date.parse(NOW);

const navigated = (): string | undefined => (globalThis as unknown as Record<string, string | undefined>).bashrNavigated;

function summary(id: string, status: string, created_at: string): RunSummary {
  return { id, pipeline: "word-report", status, created_at, finished_at: null, cancel_requested_at: null };
}

function ago(ms: number, status: string, id = `run-${status}-${ms}`): RunSummary {
  return summary(id, status, new Date(now - ms).toISOString());
}

function disk(low = false): DiskSpace {
  const total = 40 * 1024 ** 3;
  const free = 3.1 * 1024 ** 3;
  return { path: "/data", total_bytes: total, used_bytes: total - free, free_bytes: free, low, runs_bytes: 1.2 * 1024 ** 3 };
}

function page(runs: RunSummary[], next: string | null): ReturnType<typeof reply> {
  const answer = reply(runs);
  if (next === null) return answer;
  return {
    ...answer,
    headers: { get: (name: string) => (name.toLowerCase() === "x-next-cursor" ? next : null) },
  };
}

/**
 * The three routes the dashboard reads, and the retry it may post. A dead server throws the way a
 * refused socket does, which is the `api_unreachable` the page has to survive without losing its runs.
 */
class DashboardServer {
  runs: RunSummary[] = [];
  running: RunSummary[] = [];
  diskSpace: DiskSpace = disk(false);
  paged: { first: RunSummary[]; second: RunSummary[] } | null = null;
  dead = false;
  retryFails = false;
  diskReads = 0;
  requests: URL[] = [];
  retried: string[] = [];

  install(): void {
    globalThis.fetch = (async (input: string | URL | Request, init?: { method?: string }) =>
      this.answer(new URL(String(input), "http://runs.test"), init?.method ?? "GET")) as unknown as typeof fetch;
  }

  private async answer(url: URL, method: string): Promise<ReturnType<typeof reply>> {
    this.requests.push(url);
    if (this.dead) throw new TypeError("connection refused");
    if (method === "POST") {
      const retry = /^\/v1\/runs\/([^/]+)\/retry$/.exec(url.pathname);
      if (retry !== null) {
        this.retried.push(decodeURIComponent(retry[1]!));
        return this.retryFails
          ? reply({ code: "run_not_active", message: "the run is no longer active" }, 409)
          : reply({});
      }
    }
    if (url.pathname === "/v1/disk") {
      this.diskReads += 1;
      return reply(this.diskSpace);
    }
    if (url.pathname === "/v1/runs") {
      if (url.searchParams.get("status") === "running") return reply(this.running);
      if (this.paged !== null) {
        const cursor = url.searchParams.get("cursor");
        if (cursor === null) return page(this.paged.first, "c1");
        if (cursor === "c1") return page(this.paged.second, null);
        return page([], null);
      }
      return reply(this.runs);
    }
    return reply({ code: "not_found", message: `nothing answers ${method} ${url.pathname}` }, 404);
  }
}

async function open(options: { window?: string; clock?: FakeClock; server?: DashboardServer } = {}): Promise<{
  view: FakeElement;
  clock: FakeClock;
  server: DashboardServer;
}> {
  delete (globalThis as unknown as Record<string, unknown>).bashrNavigated;
  const server = options.server ?? new DashboardServer();
  const clock = options.clock ?? new FakeClock();
  clock.set(NOW);
  server.install();
  const view = new FakeElement("div");
  const controller = new AbortController();
  controllers.push(controller);
  const query = new URLSearchParams(options.window === undefined ? "" : `window=${options.window}`);
  renderDashboard(
    view as unknown as HTMLElement,
    { path: "/", parts: [], query },
    controller.signal,
    clock,
  );
  await waitFor("the dashboard's first read", () => {
    return (
      view.querySelector(".dash-counts") !== null ||
      view.querySelector(".empty-state") !== null ||
      view.querySelector(".state--error") !== null
    );
  });
  return { view, clock, server };
}

const count = (view: FakeElement, status: string): FakeElement =>
  one(
    view.querySelectorAll(".dash-count").find((node) => node.getAttribute("href")?.includes(`status=${status}`) === true) ?? null,
    `the ${status} count tile`,
  );

const figure = (view: FakeElement, status: string): string => one(count(view, status).querySelector(".figure"), `the ${status} number`).textContent;

const panel = (view: FakeElement, label: string): FakeElement =>
  one(view.querySelectorAll(".dash-panel").find((node) => node.getAttribute("aria-label") === label) ?? null, `the ${label} panel`);

const rows = (view: FakeElement, label: string): FakeElement[] => panel(view, label).querySelectorAll("tbody tr");

const buttonNamed = (view: FakeElement, label: string): FakeElement =>
  one(view.querySelectorAll("button").find((node) => node.textContent.trim() === label) ?? null, `the ${label} button`);

afterAll(() => {
  for (const controller of controllers) controller.abort();
  // The fake API went onto the global `fetch`, and the files after this one in the same process
  // include the browser tests, which need the real one.
  restoreRunsGlobals();
  delete (globalThis as unknown as Record<string, unknown>).history;
  rmSync(served, { recursive: true, force: true });
});

describe("the window's arithmetic", () => {
  test("24 h is the current local hour and the 23 before it", () => {
    const at = new Date(2026, 10, 5, 14, 37).getTime();
    const start = new Date(windowStart(at, "24h"));
    expect([start.getDate(), start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([4, 15, 0, 0]);

    const model = dashboardModel([], [], "24h", at);
    expect(model.bars.length).toBe(24);
    expect(model.bars[0]!.label).toBe("4 Nov, 15:00");
    expect(model.bars[23]!.label).toBe("5 Nov, 14:00");
  });

  test("7 d and 30 d are local days, the current one included", () => {
    const at = new Date(2026, 10, 5, 14, 37).getTime();
    const week = dashboardModel([], [], "7d", at);
    expect(week.bars.length).toBe(7);
    expect(week.bars[0]!.label).toBe("30 Oct");
    expect(week.bars[6]!.label).toBe("5 Nov");

    const month = dashboardModel([], [], "30d", at);
    expect(month.bars.length).toBe(30);
    expect(month.bars[0]!.label).toBe("7 Oct");
    expect(month.bars[29]!.label).toBe("5 Nov");
  });

  test("a run on either side of the edge is in or out, and lands in its own local bucket", () => {
    const at = new Date(2026, 10, 5, 14, 37).getTime();
    const start = windowStart(at, "24h");
    const runs = [
      summary("before", "failed", new Date(start - 1).toISOString()),
      summary("first", "failed", new Date(start).toISOString()),
      summary("last", "succeeded", new Date(at).toISOString()),
      summary("future", "failed", new Date(at + 1).toISOString()),
    ];
    const model = dashboardModel(runs, [], "24h", at);

    expect(model.counts.failed).toBe(1);
    expect(model.counts.succeeded).toBe(1);
    expect(model.bars[0]!.title).toBe("4 Nov, 15:00 · 1 failed");
    expect(model.bars[23]!.title).toBe("5 Nov, 14:00 · 1 succeeded");
    expect(model.bars.flatMap((bar) => bar.segments).reduce((sum, segment) => sum + segment.value, 0)).toBe(2);
  });

  test("runs outside the window are not in a bar, and a running run counts whatever its age", () => {
    const at = new Date(2026, 10, 5, 14, 37).getTime();
    const old = summary("old-running", "running", new Date(at - 90 * 86_400_000).toISOString());
    const model = dashboardModel([], [old], "7d", at);

    expect(model.counts.running).toBe(1);
    expect(model.running.map((run) => run.id)).toEqual(["old-running"]);
    expect(model.bars.every((bar) => bar.segments.every((segment) => segment.value === 0))).toBe(true);
    // Something is on the screen even though nothing was created in this window.
    expect(model.hasRuns).toBe(true);
  });
});

describe("the counts and the chart", () => {
  test("four tiles count the window, or every live run for running, and link to the filtered list", async () => {
    const server = new DashboardServer();
    const start = windowStart(now, "24h");
    server.runs = [
      summary("ok", "succeeded", new Date(start + 60_000).toISOString()),
      summary("bad", "failed", new Date(start + 120_000).toISOString()),
      summary("stopped", "cancelled", new Date(start + 180_000).toISOString()),
      summary("outside", "failed", new Date(start - 1).toISOString()),
    ];
    server.running = [summary("live", "running", new Date(now - 80 * 86_400_000).toISOString())];
    const { view } = await open({ server });

    expect(figure(view, "running")).toBe("1");
    expect(figure(view, "succeeded")).toBe("1");
    expect(figure(view, "failed")).toBe("1");
    expect(figure(view, "cancelled")).toBe("1");
    expect(count(view, "running").getAttribute("href")).toBe("/app/runs?status=running");
    expect(count(view, "failed").getAttribute("href")).toBe("/app/runs?status=failed&window=24h");
    expect(count(view, "succeeded").getAttribute("href")).toBe("/app/runs?status=succeeded&window=24h");
    expect(count(view, "cancelled").getAttribute("href")).toBe("/app/runs?status=cancelled&window=24h");
  });

  test("a bar names its bucket and the statuses in it, and the legend names all four", async () => {
    const server = new DashboardServer();
    const start = windowStart(now, "24h");
    server.runs = [
      summary("ok", "succeeded", new Date(start + 60_000).toISOString()),
      summary("bad", "failed", new Date(start + 60_000).toISOString()),
    ];
    const { view } = await open({ server });

    const bars = view.querySelectorAll(".chart__bar");
    expect(bars.length).toBe(24);
    const named = bars.find((bar) => bar.textContent.includes("1 succeeded"))!;
    expect(named.textContent).toBe("4 Nov, 15:00 · 1 succeeded, 1 failed");
    const wholeBar = view.querySelectorAll(".chart__bar").find((bar) => bar.querySelectorAll("rect").length === 2);
    expect(wholeBar).not.toBeUndefined();
    expect(view.querySelectorAll(".chart__legend-entry").length).toBe(4);
    expect(view.querySelectorAll(".chart__legend-entry")[0]!.textContent).toContain("succeeded");
  });

  test("an empty bucket draws no bar and says so in its title", async () => {
    const server = new DashboardServer();
    server.runs = [ago(60_000, "succeeded")];
    const { view } = await open({ server });

    const empty = view.querySelectorAll(".chart__bar").find((bar) => bar.textContent.endsWith("· no runs"));
    expect(empty).not.toBeUndefined();
    expect(empty!.querySelectorAll("rect").length).toBe(0);
  });
});

describe("the two run tables", () => {
  test("Running now has no Status column, because every row in it is running", async () => {
    const server = new DashboardServer();
    server.running = [summary("live", "running", new Date(now - 60_000).toISOString())];
    const { view } = await open({ server });
    const headers = panel(view, "Running now")
      .querySelectorAll("thead th")
      .map((node) => node.textContent.trim());
    expect(headers).toEqual(["Run", "Pipeline", "Started", "Duration", "Steps"]);
    expect(panel(view, "Running now").querySelector(".table__link--id")!.textContent).toBe("live");
  });

  test("show ten rows each and link to the filtered list", async () => {
    const server = new DashboardServer();
    server.runs = Array.from({ length: 12 }, (_entry, index) => ago(60_000 + index, "failed", `f-${index}`));
    server.running = Array.from({ length: 12 }, (_entry, index) => summary(`r-${index}`, "running", new Date(now - index).toISOString()));
    const { view } = await open({ server });

    expect(rows(view, "Running now").length).toBe(10);
    expect(rows(view, "Failed").length).toBe(10);
    const links = view.querySelectorAll("a").filter((node) => node.textContent === "View all");
    expect(links.map((node) => node.getAttribute("href"))).toEqual([
      "/app/runs?status=running",
      "/app/runs?status=failed&window=24h",
    ]);
  });

  test("a write token gets Retry, which posts and then opens the run", async () => {
    dashboardApi.session.identity = { name: "tester", scope: "write", admin: false };
    const server = new DashboardServer();
    const failed = ago(60_000, "failed", "the-failed-run");
    server.runs = [failed];
    const { view } = await open({ server });

    buttonNamed(view, "Retry").dispatchEvent("click");
    await waitFor("the retry to be posted", () => server.retried.length === 1);
    await waitFor("the retry to open the run", () => navigated() === `/runs/${failed.id}`);
    expect(server.retried).toEqual([failed.id]);
    expect(navigated()).toBe(`/runs/${failed.id}`);
  });

  test("a refused retry says why on the dashboard instead of pretending it worked", async () => {
    dashboardApi.session.identity = { name: "tester", scope: "write", admin: false };
    const server = new DashboardServer();
    server.runs = [ago(60_000, "failed", "the-failed-run")];
    server.retryFails = true;
    const { view } = await open({ server });

    buttonNamed(view, "Retry").dispatchEvent("click");
    await waitFor("the refusal to be shown", () => view.querySelector(".dash-failure .state--error") !== null);
    expect(view.querySelector(".dash-failure .state--error")!.textContent).toContain("run_not_active");
    expect(navigated()).toBeUndefined();
  });

  test("a read-only token is offered no Retry button", async () => {
    dashboardApi.session.identity = { name: "reader", scope: "read", admin: false };
    const server = new DashboardServer();
    server.runs = [ago(60_000, "failed", "the-failed-run")];
    const { view } = await open({ server });

    expect(view.querySelectorAll("button").filter((node) => node.textContent === "Retry")).toEqual([]);
  });

  test("the empty tables say what they mean, and the failed one names its window", async () => {
    const server = new DashboardServer();
    server.runs = [ago(60_000, "succeeded")];
    const { view } = await open({ server, window: "7d" });

    expect(panel(view, "Running now").textContent).toContain("Nothing is running.");
    expect(panel(view, "Failed").textContent).toContain("No failed runs in the last 7 d.");
  });
});

describe("the window control and the disk", () => {
  test("choosing 7 d writes the address and counts a run three days old", async () => {
    const writes: string[] = [];
    (globalThis as unknown as Record<string, unknown>).history = {
      replaceState(_state: unknown, _title: string, url?: string) {
        if (typeof url === "string") writes.push(url);
      },
    };
    const server = new DashboardServer();
    server.runs = [ago(3 * 86_400_000, "succeeded")];
    const { view } = await open({ server });

    expect(view.querySelector(".empty-state")!.textContent).toContain("No runs yet.");
    view.querySelectorAll(".segmented__btn").find((node) => node.textContent === "7 d")!.dispatchEvent("click");
    await waitFor("the 7 d counts", () => view.querySelector(".dash-counts") !== null);

    expect(figure(view, "succeeded")).toBe("1");
    expect(writes.some((href) => href.includes("window=7d"))).toBe(true);
    expect(panel(view, "Failed").textContent).toContain("No failed runs in the last 7 d.");
  });

  test("the disk alarm appears only when the API says low, and links to Settings", async () => {
    const quiet = new DashboardServer();
    quiet.runs = [ago(60_000, "succeeded")];
    const first = await open({ server: quiet });
    expect(first.view.querySelector(".alarm")).toBeNull();

    const low = new DashboardServer();
    low.runs = [ago(60_000, "succeeded")];
    low.diskSpace = disk(true);
    const second = await open({ server: low });
    const alarm = one(second.view.querySelector(".alarm"), "the disk alarm");
    expect(alarm.textContent).toContain("Disk almost full");
    expect(alarm.textContent).toContain("3.1 GB free of 40 GB.");
    expect(alarm.querySelector("a")!.getAttribute("href")).toBe("/app/settings");
    expect(second.view.querySelector(".dash-disk .meter")).not.toBeNull();
    expect(second.view.querySelector(".dash-disk")!.textContent).toContain("Disk 92% used");
    expect(second.view.querySelector(".dash-disk")!.textContent).toContain("runs 1.2 GB");
  });

  test("no runs at all is one sentence and the way to start one", async () => {
    const server = new DashboardServer();
    const { view } = await open({ server });

    const empty = one(view.querySelector(".empty-state"), "the no-runs state");
    expect(empty.textContent).toContain("No runs yet.");
    expect(empty.querySelector("a")!.getAttribute("href")).toBe("/app/pipelines");
  });
});

describe("the reading", () => {
  test("follows every page the API names", async () => {
    const server = new DashboardServer();
    server.paged = {
      first: [ago(60_000, "succeeded", "first-page")],
      second: [ago(120_000, "succeeded", "second-page")],
    };
    const { view } = await open({ server });

    expect(figure(view, "succeeded")).toBe("2");
    expect(server.requests.some((url) => url.searchParams.get("cursor") === "c1")).toBe(true);
  });

  test("reads every 5 s while a run is going and every 15 s when none is", async () => {
    const server = new DashboardServer();
    server.running = [summary("live", "running", new Date(now - 60_000).toISOString())];
    const { clock } = await open({ server });
    expect(server.diskReads).toBe(1);

    await clock.advance(LIVE_POLL_MS - 1);
    expect(server.diskReads).toBe(1);
    await clock.advance(1);
    expect(server.diskReads).toBe(2);

    server.running = [];
    await clock.advance(LIVE_POLL_MS);
    expect(server.diskReads).toBe(3);
    await clock.advance(LIVE_POLL_MS);
    expect(server.diskReads).toBe(3);
    await clock.advance(IDLE_POLL_MS);
    expect(server.diskReads).toBe(4);
  });

  test("a hidden tab reads nothing and reads again the moment it is shown", async () => {
    const server = new DashboardServer();
    server.runs = [ago(60_000, "succeeded")];
    const { view } = await open({ server });
    expect(server.diskReads).toBe(1);

    showTab(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const before = server.diskReads;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(server.diskReads).toBe(before);
    } finally {
      showTab(false);
    }
    await waitFor("the read after the tab comes back", () => server.diskReads > 1);
    expect(view.querySelector(".dash-counts")).not.toBeNull();
  });

  test("a refresh patches the tables and keeps focus where it was", async () => {
    dashboardApi.session.identity = { name: "tester", scope: "write", admin: false };
    const server = new DashboardServer();
    server.runs = [ago(60_000, "failed", "the-failed-run")];
    const { view, clock } = await open({ server });
    const retry = buttonNamed(view, "Retry");
    retry.focus();

    await clock.advance(IDLE_POLL_MS);
    expect(fakeDocument.activeElement).toBe(retry);
    expect(buttonNamed(view, "Retry")).toBe(retry);
    expect(figure(view, "failed")).toBe("1");
  });

  test("a lost read keeps the rows and says they may be out of date, then clears", async () => {
    const server = new DashboardServer();
    server.runs = [ago(60_000, "succeeded")];
    const { view, clock } = await open({ server });

    server.dead = true;
    await clock.advance(IDLE_POLL_MS);
    const note = one(view.querySelector(".dash-note"), "the stale line");
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain("Lost the server");
    expect(figure(view, "succeeded")).toBe("1");
    expect(view.querySelector(".dash-failure .state--error")).toBeNull();

    server.dead = false;
    await clock.advance(IDLE_POLL_MS);
    expect(note.hidden).toBe(true);
  });

  test("a first read that fails is an honest error, not an empty dashboard", async () => {
    const server = new DashboardServer();
    server.dead = true;
    const { view, clock } = await open({ server });

    expect(view.querySelector(".empty-state")).toBeNull();
    const box = one(view.querySelector(".state--error"), "the error box");
    expect(box.textContent).toContain("api_unreachable");

    server.dead = false;
    server.runs = [ago(60_000, "succeeded")];
    await clock.advance(IDLE_POLL_MS);
    expect(view.querySelector(".state--error")).toBeNull();
    expect(figure(view, "succeeded")).toBe("1");
  });
});

// The stylesheet is part of the served bytes, so the layout rules the browser will apply are read
// from there rather than from a second copy here.
const sheet = new TextDecoder().decode(buildAssets().files.get("assets/style.css")!.data);
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(sheet);
  if (found === null) throw new Error(`style.css has no rule whose selector is exactly ${selector}`);
  return found[1]!;
}

describe("the dashboard's layout", () => {
  test("the paired tables only sit side by side where both fit whole", () => {
    expect(sheet).toContain("@media (min-width: 1700px)");
    expect(sheet).toContain(".dash-pair { grid-template-columns: repeat(2, minmax(0, 1fr)); }");
    expect(ruleBody(".dash-pair")).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(sheet).toContain(".runstable time, .runstable .num { white-space: nowrap; }");
  });

  test("the counts are four across, and two by two below 640 px", () => {
    expect(ruleBody(".dash-counts")).toContain("repeat(4, minmax(0, 1fr))");
    expect(sheet).toContain("@media (max-width: 640px)");
  });
});
