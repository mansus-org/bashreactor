// The Runs list: the URL filters, the shared runs table, the cursor, and the clock that keeps it
// current. The stand-in DOM and the fake clock are in runs.testkit.ts, which both run screens share;
// this file holds the one screen's describes and its own server, because the list now asks for a
// filtered page and reads a cursor off the header.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { serveModules } from "./client.testkit.ts";
import {
  FakeElement,
  FakeClock,
  IDLE_POLL_MS,
  POLL_MS,
  T0,
  controllers,
  fakeDocument,
  one,
  reply,
  showTab,
  styled,
  summary,
  waitFor,
  word,
} from "./runs.testkit.ts";
import type { RunSummary } from "./api.ts";

const served = serveModules(["runs-list", "ui"]);
const { renderRunsList } = (await import(join(served, "runs-list.js"))) as typeof import("./runs-list.ts");

afterAll(() => rmSync(served, { recursive: true, force: true }));

// ---------- the address, which the screen rewrites in place ----------

let previous: AbortController | null = null;
const written: string[] = [];
const fakeHistory = {
  pushState(): void {},
  replaceState(_data: unknown, _title: string, href: string): void {
    written.push(href);
    const url = new URL(href, "http://runs.test");
    (location as unknown as { href: string }).href = url.href;
  },
};
(globalThis as unknown as { history: typeof fakeHistory }).history = fakeHistory;

function where(): string {
  return written.at(-1) ?? "";
}

function parameters(href: string): URLSearchParams {
  return new URL(href, "http://runs.test").searchParams;
}

// ---------- a server that answers a first page and cursors ----------

interface Answer {
  runs: RunSummary[];
  next?: string | null;
}

type Reply = Answer | { error: { code: string; message: string }; status: number };

function pageReply(runs: RunSummary[], next: string | null): unknown {
  const response = {
    ok: true,
    status: 200,
    json: async () => runs,
    blob: async () => new Blob([JSON.stringify(runs)]),
    headers: { get: (name: string) => (name.toLowerCase() === "x-next-cursor" ? next : null) },
    clone(): unknown {
      return response;
    },
  };
  return response;
}

class ListServer {
  calls: string[] = [];
  first: Reply = { runs: [] };
  pages = new Map<string, Reply>();
  pipelines: string[] = [];
  pipelineFailure: unknown = null;
  /** A read held open, so a test can look at the tab while one is in the air. */
  gate: Promise<void> | null = null;
  active = 0;
  peak = 0;

  constructor() {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://runs.test");
      return this.answer(url);
    }) as typeof fetch;
  }

  get reads(): number {
    return this.queries().length;
  }

  queries(): URLSearchParams[] {
    return this.calls
      .filter((entry) => new URL(entry, "http://runs.test").pathname === "/v1/runs")
      .map((entry) => new URL(entry, "http://runs.test").searchParams);
  }

  private async answer(url: URL): Promise<unknown> {
    // The fake clock and the tab are global to the test process, so another live screen can fetch
    // its own run through this same `fetch`. Only the list's own reads are what these tests count.
    const isList = url.pathname === "/v1/runs";
    this.calls.push(`${url.pathname}${url.search}`);
    if (isList) {
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
    }
    try {
      if (url.pathname === "/v1/pipelines") {
        if (this.pipelineFailure !== null) throw this.pipelineFailure;
        return reply({ pipelines: this.pipelines.map((name) => ({ name, latest: 1, versions: 1 })) });
      }
      if (!isList) return reply({ code: "not_found", message: `nothing answers ${url.pathname}` }, 404);
      if (this.gate !== null) await this.gate;
      const cursor = url.searchParams.get("cursor");
      const answer =
        cursor === null ? this.first : (this.pages.get(cursor) ?? { error: { code: "not_found", message: `no cursor ${cursor}` }, status: 404 });
      if ("error" in answer) return reply(answer.error, answer.status);
      return pageReply(answer.runs, answer.next ?? null);
    } finally {
      if (isList) this.active -= 1;
    }
  }
}

function run(id: string, status: string, extra: Partial<RunSummary> = {}): RunSummary {
  return {
    ...summary(id, status),
    pipeline_version: 3,
    step_counts: {
      total: 4,
      pending: 0,
      running: status === "running" ? 1 : 0,
      waiting_retry: 0,
      succeeded: status === "succeeded" ? 4 : 3,
      failed: status === "failed" ? 1 : 0,
      skipped: 0,
      cancelled: 0,
    },
    ...extra,
  };
}

async function openList(options: {
  query?: string;
  first?: Reply;
  pages?: Record<string, Reply>;
  pipelines?: string[];
  pipelineFailure?: unknown;
  clock?: FakeClock;
} = {}): Promise<{ view: FakeElement; clock: FakeClock; server: ListServer }> {
  previous?.abort();
  const controller = new AbortController();
  controllers.push(controller);
  previous = controller;
  const view = new FakeElement("div");
  const clock = options.clock ?? new FakeClock();
  clock.set(T0);
  const server = new ListServer();
  server.first = options.first ?? { runs: [] };
  for (const [cursor, answer] of Object.entries(options.pages ?? {})) server.pages.set(cursor, answer);
  server.pipelines = options.pipelines ?? [];
  server.pipelineFailure = options.pipelineFailure ?? null;
  written.length = 0;
  const query = new URLSearchParams(options.query ?? "");
  (location as unknown as { href: string }).href = `http://runs.test/app/runs${options.query === undefined ? "" : `?${options.query}`}`;
  renderRunsList(
    view as unknown as HTMLElement,
    { path: "/runs", parts: ["runs"], query },
    controller.signal,
    clock,
  );
  await waitFor("the first list read", () => {
    const loading = view.querySelector(".runs-list__status");
    const landed = loading === null || loading.hidden;
    return (
      landed &&
      (view.querySelectorAll(".runstable tbody tr").length > 0 ||
        view.querySelector(".table__empty") !== null ||
        view.querySelector("[role=alert]") !== null)
    );
  });
  return { view, clock, server };
}

function rows(view: FakeElement): FakeElement[] {
  return view.querySelectorAll(".runs-list__body tbody tr").filter((row) => !row.classList.contains("table__empty"));
}

const buttonNamed = (view: FakeElement, label: string): FakeElement =>
  one(
    view.querySelectorAll("button").find((node) => node.textContent.trim() === label) ?? null,
    `the ${label} button`,
  );

function chip(view: FakeElement, status: string): FakeElement {
  return one(view.querySelector(`[data-status="${status}"]`), `the ${status} chip`);
}

function windowButton(view: FakeElement, value: string): FakeElement {
  return one(view.querySelector(`[data-value="${value}"]`), `the ${value} window button`);
}

const count = (view: FakeElement): FakeElement => one(view.querySelector(".runs-list__count"), "the count");

// ---------- the table ----------

describe("the runs table", () => {
  test("shows the design's columns and a row's own run, pipeline, version and steps", async () => {
    const failed = run("20261104T101500Z-3fa9c2d1", "failed");
    const { view } = await openList({ first: { runs: [failed] }, pipelines: ["word-report"] });

    const headers = view.querySelectorAll(".runs-list__body thead th").map((node) => node.textContent.trim());
    expect(headers).toEqual(["Status", "Run", "Pipeline", "Version", "Started", "Duration", "Steps"]);

    const row = one(rows(view)[0] ?? null, "the run's row");
    expect(row.textContent).toContain(failed.id);
    expect(word(one(row.querySelector(".stamp"), "the status stamp"))).toBe("failed");
    expect(row.textContent).toContain("word-report");
    expect(row.textContent).toContain("v3");
    expect(row.textContent).toContain("3 / 4 · 1 failed");
    expect(one(row.querySelector("a.table__link"), "the run link").getAttribute("href")).toBe(
      `/app/runs/${failed.id}`,
    );
    expect(count(view).textContent).toBe("1 run");
  });

  test("a poll patches rows in place, so the row under the reader stays the row it was", async () => {
    const first = run("20261104T101500Z-3fa9c2d1", "running");
    const older = run("20261104T091500Z-4b5c6d7e", "running");
    const { view, clock, server } = await openList({ first: { runs: [first, older] } });
    const kept = one(rows(view)[0] ?? null, "the first row");
    const link = one(kept.querySelector("a.table__link"), "the first row's link");
    link.focus();

    // The newer run has finished, the older one is gone, and a new run has arrived above them.
    server.first = {
      runs: [run("20261104T111500Z-1a2b3c4d", "running"), run("20261104T101500Z-3fa9c2d1", "succeeded")],
    };
    await clock.advance(POLL_MS);

    expect(rows(view).length).toBe(2);
    expect(rows(view)[1]).toBe(kept);
    expect(fakeDocument.activeElement).toBe(link);
    expect(word(one(kept.querySelector(".stamp"), "the kept row's stamp"))).toBe("succeeded");
  });

  test("a stored time that cannot be read keeps its row and drops the time", async () => {
    const bad = run("two", "failed", { created_at: "not a time at all" });
    const { view } = await openList({ first: { runs: [run("one", "succeeded"), bad] } });

    expect(view.textContent).not.toContain("not a time at all");
    const row = one(
      rows(view).find((node) => node.textContent.includes("two")) ?? null,
      "the row with the unreadable time",
    );
    expect(row.textContent).not.toContain("started");
  });
});

// ---------- the filters, and the URL they live in ----------

describe("the filters", () => {
  test("an address with filters sends them to the API and shows them in the controls", async () => {
    const { view, server } = await openList({
      query: "status=failed,cancelled&pipeline=word-report&window=7d",
      first: { runs: [] },
      pipelines: ["word-report"],
    });

    const asked = server.queries()[0]!;
    expect(asked.get("limit")).toBe("50");
    expect(asked.get("status")).toBe("failed,cancelled");
    expect(asked.get("pipeline")).toBe("word-report");
    expect(asked.get("since")).toBe(new Date(Date.parse(T0) - 7 * 24 * 60 * 60 * 1000).toISOString());

    expect(chip(view, "failed").getAttribute("aria-pressed")).toBe("true");
    expect(chip(view, "cancelled").getAttribute("aria-pressed")).toBe("true");
    expect(chip(view, "running").getAttribute("aria-pressed")).toBe("false");
    expect(windowButton(view, "7d").getAttribute("aria-checked")).toBe("true");
    await waitFor("the pipeline options", () => view.querySelectorAll("select option").length > 1);
    expect(one(view.querySelector("select"), "the pipeline select").value).toBe("word-report");
  });

  test("an unknown status or window is no filter at all, and never an error", async () => {
    const { view, server } = await openList({
      query: "status=weird&window=forever",
      first: { runs: [run("20261104T101500Z-3fa9c2d1", "succeeded")] },
    });

    const asked = server.queries()[0]!;
    expect(asked.get("status")).toBeNull();
    expect(asked.get("since")).toBeNull();
    expect(view.querySelector("[role=alert]")).toBeNull();
    expect(chip(view, "running").getAttribute("aria-pressed")).toBe("false");
    expect(windowButton(view, "all").getAttribute("aria-checked")).toBe("true");
    // The address is not rewritten behind the reader's back until they change something.
    expect(written).toEqual([]);
  });

  test("each change rewrites the URL and reads the list again", async () => {
    const { view, server, clock } = await openList({
      first: { runs: [run("20261104T101500Z-3fa9c2d1", "succeeded")] },
      pipelines: ["word-report", "nightly-sync"],
    });

    chip(view, "failed").click();
    await waitFor("the status read", () => server.reads === 2);
    expect(parameters(where()).get("status")).toBe("failed");
    expect(parameters(where()).get("window")).toBe("all");
    expect(chip(view, "failed").getAttribute("aria-pressed")).toBe("true");
    expect(buttonNamed(view, "Clear filters").hidden).toBe(false);
    expect(server.queries()[1]!.get("status")).toBe("failed");

    windowButton(view, "24h").click();
    await waitFor("the window read", () => server.reads === 3);
    expect(parameters(where()).get("status")).toBe("failed");
    expect(parameters(where()).get("window")).toBe("24h");
    expect(server.queries()[2]!.get("since")).toBe(
      new Date(clock.now() - 24 * 60 * 60 * 1000).toISOString(),
    );

    await waitFor("the pipeline options", () => view.querySelectorAll("select option").length > 2);
    const select = one(view.querySelector("select"), "the pipeline select");
    select.value = "word-report";
    select.dispatchEvent("change");
    await waitFor("the pipeline read", () => server.reads === 4);
    expect(parameters(where()).get("pipeline")).toBe("word-report");
    expect(server.queries()[3]!.get("pipeline")).toBe("word-report");
  });

  test("Clear filters puts every control back and reads the unfiltered list", async () => {
    const { view, server } = await openList({
      query: "status=failed&pipeline=word-report&window=7d",
      first: { runs: [run("20261104T101500Z-3fa9c2d1", "failed")] },
      pipelines: ["word-report"],
    });
    const clear = buttonNamed(view, "Clear filters");

    clear.click();
    await waitFor("the unfiltered read", () => server.reads === 2);

    expect(parameters(where()).get("status")).toBeNull();
    expect(parameters(where()).get("pipeline")).toBeNull();
    expect(parameters(where()).get("window")).toBe("all");
    expect(chip(view, "failed").getAttribute("aria-pressed")).toBe("false");
    expect(windowButton(view, "all").getAttribute("aria-checked")).toBe("true");
    expect(one(view.querySelector("select"), "the pipeline select").value).toBe("all");
    expect(buttonNamed(view, "Clear filters").hidden).toBe(true);
    const asked = server.queries()[1]!;
    expect(asked.get("status")).toBeNull();
    expect(asked.get("pipeline")).toBeNull();
    expect(asked.get("since")).toBeNull();
  });

  test("a pipeline named in the address but not in the list still has an option of its own", async () => {
    const { view } = await openList({
      query: "pipeline=ghost",
      first: { runs: [] },
      pipelines: ["word-report"],
    });
    await waitFor("the pipeline options", () => view.querySelectorAll("select option").length > 2);
    const select = one(view.querySelector("select"), "the pipeline select");
    expect(select.value).toBe("ghost");
    expect(view.querySelectorAll("select option").map((option) => option.textContent.trim())).toEqual([
      "All pipelines",
      "word-report",
      "ghost",
    ]);
  });
});

// ---------- empty states ----------

describe("an empty list", () => {
  test("with no filters, says no runs yet and points at Pipelines", async () => {
    const { view } = await openList({ first: { runs: [] } });
    const empty = one(view.querySelector(".table__empty"), "the empty row");
    expect(empty.textContent).toContain("No runs yet.");
    const link = one(empty.querySelector("a"), "the Pipelines link");
    expect(link.textContent).toBe("Pipelines");
    expect(link.getAttribute("href")).toBe("/app/pipelines");
    expect(count(view).textContent).toBe("0 runs");
  });

  test("with filters, says nothing matches and offers Clear filters", async () => {
    const { view, server } = await openList({
      query: "status=failed",
      first: { runs: [] },
    });
    const empty = one(view.querySelector(".table__empty"), "the empty row");
    expect(empty.textContent).toContain("No runs match these filters.");
    const clear = one(empty.querySelector("button"), "the empty state's Clear filters");
    expect(clear.textContent).toBe("Clear filters");

    clear.click();
    await waitFor("the unfiltered read", () => server.reads === 2);
    expect(server.queries()[1]!.get("status")).toBeNull();
  });
});

// ---------- Load more ----------

describe("Load more", () => {
  test("appends the next page, keeps its rows through a first-page poll and keeps the focus", async () => {
    const first = run("20261104T101500Z-3fa9c2d1", "succeeded");
    const second = run("20261104T091500Z-4b5c6d7e", "failed");
    const { view, clock, server } = await openList({
      first: { runs: [first], next: "cursor-1" },
      pages: { "cursor-1": { runs: [second], next: null } },
    });
    const more = buttonNamed(view, "Load more");
    expect(more.hidden).toBe(false);
    more.focus();
    more.click();

    await waitFor("the second page", () => rows(view).length === 2);
    expect(fakeDocument.activeElement).toBe(more);
    expect(server.queries().at(-1)!.get("cursor")).toBe("cursor-1");
    expect(rows(view)[1]!.textContent).toContain(second.id);
    expect(count(view).textContent).toBe("2 runs");
    expect(more.hidden).toBe(true);

    const kept = rows(view)[1]!;
    server.first = { runs: [run("20261104T111500Z-1a2b3c4d", "succeeded"), first], next: "cursor-1" };
    await clock.advance(IDLE_POLL_MS);

    expect(rows(view).map((row) => row.textContent)).toEqual([
      expect.stringContaining("20261104T111500Z-1a2b3c4d"),
      expect.stringContaining(first.id),
      expect.stringContaining(second.id),
    ]);
    expect(rows(view)[2]).toBe(kept);
    expect(fakeDocument.activeElement).toBe(more);
    // The last page said there was no cursor after it, so the first page's stale cursor does not
    // bring the "+" back: everything that exists has been loaded.
    expect(count(view).textContent).toBe("3 runs");
  });

  test("a running run on a later page keeps the fast poll going", async () => {
    const { view, clock, server } = await openList({
      first: { runs: [run("20261104T101500Z-3fa9c2d1", "succeeded")], next: "cursor-1" },
      pages: { "cursor-1": { runs: [run("20261104T091500Z-4b5c6d7e", "running")], next: null } },
    });
    buttonNamed(view, "Load more").click();
    await waitFor("the running run", () => rows(view).length === 2);

    const reads = server.reads;
    await clock.advance(POLL_MS);
    expect(server.reads).toBe(reads + 1);
  });
});

// ---------- the clock ----------

describe("a list that keeps up", () => {
  test("reads again while a run on it is going, then drops to the slow watch", async () => {
    const id = "20261104T101500Z-3fa9c2d1";
    const { view, clock, server } = await openList({ first: { runs: [run(id, "running")] } });
    expect(clock.waking).toBe(1);

    server.first = { runs: [run(id, "succeeded")] };
    await clock.advance(POLL_MS);
    expect(server.reads).toBe(2);
    expect(word(one(view.querySelector(".stamp"), "the row's stamp"))).toBe("succeeded");

    const reads = server.reads;
    await clock.advance(POLL_MS * 10);
    expect(server.reads).toBe(reads);
    await clock.advance(IDLE_POLL_MS);
    expect(server.reads).toBe(reads + 1);
  });

  test("a run started somewhere else turns up while the list is quiet", async () => {
    const { view, clock, server } = await openList({
      first: { runs: [run("20261104T101500Z-3fa9c2d1", "succeeded")] },
    });
    expect(server.reads).toBe(1);

    server.first = {
      runs: [run("20261104T111500Z-1a2b3c4d", "running"), run("20261104T101500Z-3fa9c2d1", "succeeded")],
    };
    await clock.advance(IDLE_POLL_MS);

    expect(server.reads).toBe(2);
    expect(rows(view).length).toBe(2);
    expect(word(one(view.querySelector(".stamp"), "the newest row's stamp"))).toBe("running");
    await clock.advance(POLL_MS);
    expect(server.reads).toBe(3);
  });

  test("a hidden tab reads nothing, and reads the moment it is shown again", async () => {
    showTab(false);
    const id = "20261104T101500Z-3fa9c2d1";
    const { view, clock, server } = await openList({ first: { runs: [run(id, "running")] } });
    try {
      showTab(true);
      await clock.advance(POLL_MS * 5);
      expect(server.reads).toBe(1);
      expect(clock.waking).toBe(0);

      server.first = { runs: [run(id, "succeeded")] };
      showTab(false);
      await waitFor("the row to say the run is over", () =>
        one(view.querySelector(".stamp"), "the row's stamp").textContent.includes("succeeded"),
      );
      expect(server.reads).toBe(2);
    } finally {
      showTab(false);
    }
  });

  test("a tab looked at again while a read is on its way does not start a second one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { clock, server } = await openList({ first: { runs: [run("20261104T101500Z-3fa9c2d1", "running")] } });
    server.gate = gate;
    server.first = { runs: [run("20261104T101500Z-3fa9c2d1", "running")] };

    await clock.advance(POLL_MS);
    showTab(true);
    showTab(false);
    release();
    await waitFor("the read to land", () => server.active === 0);

    expect(server.peak).toBe(1);
    expect(server.reads).toBe(2);
    expect(clock.waking).toBe(1);
  });
});

// ---------- errors ----------

describe("when the reading fails", () => {
  test("a first read that fails is an error box with the code, not an empty list", async () => {
    const { view, clock, server } = await openList({
      first: { error: { code: "internal_error", message: "the api is down" }, status: 500 },
    });
    const box = one(view.querySelector("[role=alert]"), "the error box");
    expect(box.textContent).toContain("internal_error");
    expect(one(view.querySelector(".runs-list__body"), "the list").hidden).toBe(true);
    expect(count(view).hidden).toBe(true);
    expect(one(view.querySelector(".runs-list__status"), "the loading line").hidden).toBe(true);

    server.first = { runs: [run("20261104T101500Z-3fa9c2d1", "running")] };
    await clock.advance(POLL_MS);
    expect(view.querySelector("[role=alert]")).toBeNull();
    expect(rows(view).length).toBe(1);
  });

  test("a poll that fails while rows are up says so rather than showing stale rows as current", async () => {
    const { view, clock, server } = await openList({
      first: { runs: [run("20261104T101500Z-3fa9c2d1", "running")] },
    });
    server.first = { error: { code: "api_unreachable", message: "the api is down" }, status: 500 };
    await clock.advance(POLL_MS);

    const box = one(view.querySelector("[role=alert]"), "the error box");
    expect(box.textContent).toContain("api_unreachable");
    expect(one(view.querySelector(".runs-list__body"), "the list").hidden).toBe(true);
    expect(count(view).hidden).toBe(true);

    server.first = { runs: [run("20261104T101500Z-3fa9c2d1", "succeeded")] };
    await clock.advance(POLL_MS);
    expect(view.querySelector("[role=alert]")).toBeNull();
    expect(one(view.querySelector(".runs-list__body"), "the list").hidden).toBe(false);
    expect(word(one(view.querySelector(".stamp"), "the row's stamp"))).toBe("succeeded");
  });
});

// ---------- the look ----------

describe("the screen's own style", () => {
  test("holds only layout, and takes every size, gap and colour from the tokens", () => {
    const css = readFileSync(join(import.meta.dir, "styles/runs-list.css"), "utf8");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toContain("font-family");
    expect(css).not.toContain("font-size");
    expect(css).not.toContain("url(");
    expect(css).toContain("var(--s");
  });

  test("nothing the screen draws carries an inline style", async () => {
    const { view } = await openList({
      query: "status=failed",
      first: { runs: [run("20261104T101500Z-3fa9c2d1", "failed")] },
    });
    expect(styled(view)).toEqual([]);
  });
});
