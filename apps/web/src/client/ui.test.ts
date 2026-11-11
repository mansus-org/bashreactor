// The components, through the bytes the server serves. The formatters are pure; the rest runs on the
// fake DOM, because what these tests are about is the markup a screen gets and the state it keeps
// while a live table is patched.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { installDom, serveModules, uninstallDom, type FakeElement } from "./client.testkit.ts";

const dom = installDom({ href: "http://x/app/runs" });
const served = serveModules(["ui"]);
const ui = (await import(join(served, "ui.js"))) as typeof import("./ui.ts");

const text = (node: FakeElement): string => node.textContent;
const count = (node: Element, selector: string): number => node.querySelectorAll(selector).length;
const fake = (node: Element): FakeElement => node as unknown as FakeElement;
const fakes = (nodes: NodeListOf<Element>): FakeElement[] => [...nodes].map(fake);

describe("formatters", () => {
  const now = Date.UTC(2026, 10, 5, 21, 12, 58);
  const ago = (seconds: number): string => new Date(now - seconds * 1000).toISOString();

  test("relative time cuts over at 10 seconds, a minute, an hour, a day and 7 days", () => {
    expect(ui.relativeTime(ago(0), now)).toBe("just now");
    expect(ui.relativeTime(ago(9), now)).toBe("just now");
    expect(ui.relativeTime(ago(10), now)).toBe("10 s ago");
    expect(ui.relativeTime(ago(59), now)).toBe("59 s ago");
    expect(ui.relativeTime(ago(60), now)).toBe("1 min ago");
    expect(ui.relativeTime(ago(3599), now)).toBe("59 min ago");
    expect(ui.relativeTime(ago(3600), now)).toBe("1 h ago");
    expect(ui.relativeTime(ago(86_399), now)).toBe("23 h ago");
    expect(ui.relativeTime(ago(86_400), now)).toBe("1 d ago");
    expect(ui.relativeTime(ago(7 * 86_400), now)).toBe("7 d ago");
    const date = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(
      new Date(now - 8 * 86_400 * 1000),
    );
    expect(ui.relativeTime(ago(8 * 86_400), now)).toBe(date);
    expect(ui.relativeTime("not a time", now)).toBe("");
  });

  test("exact time is the reader's clock to the second, and an unreadable time is empty", () => {
    const iso = new Date(now).toISOString();
    expect(ui.exactTime(iso)).toBe(
      new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(now)),
    );
    expect(ui.exactTime("not a time")).toBe("");
  });

  test("duration never says 0 s and pads the smaller unit", () => {
    expect(ui.formatDuration(0)).toBe("<1 s");
    expect(ui.formatDuration(999)).toBe("<1 s");
    expect(ui.formatDuration(1000)).toBe("1 s");
    expect(ui.formatDuration(12_000)).toBe("12 s");
    expect(ui.formatDuration(245_000)).toBe("4 m 05 s");
    expect(ui.formatDuration(3_720_000)).toBe("1 h 02 m");
    expect(ui.formatDuration(183_600_000)).toBe("2 d 03 h");
    expect(ui.formatDuration(Number.NaN)).toBe("");
  });

  test("bytes switch at exactly 1023 and 1024, base 1024", () => {
    expect(ui.formatBytes(834)).toBe("834 B");
    expect(ui.formatBytes(1023)).toBe("1023 B");
    expect(ui.formatBytes(1024)).toBe("1.0 KB");
    expect(ui.formatBytes(1.6 * 1024)).toBe("1.6 KB");
    expect(ui.formatBytes(12 * 1024 * 1024)).toBe("12 MB");
    expect(ui.formatBytes(1.2 * 1024 * 1024 * 1024)).toBe("1.2 GB");
  });

  test("counts use the reader's grouping", () => {
    expect(ui.formatCount(1204)).toBe(new Intl.NumberFormat().format(1204));
  });
});

describe("runsTable", () => {
  const run = (id: string, status: string, extra: Partial<{ failed: number; version: number | null }> = {}) => ({
    id,
    pipeline: "word-report",
    status,
    created_at: new Date(Date.UTC(2026, 10, 5, 20, 0, 0)).toISOString(),
    finished_at: new Date(Date.UTC(2026, 10, 5, 20, 1, 5)).toISOString(),
    cancel_requested_at: null,
    step_counts: {
      total: 4,
      pending: 0,
      running: 0,
      waiting_retry: 0,
      succeeded: 3,
      failed: extra.failed ?? 0,
      skipped: 0,
      cancelled: 0,
    },
    pipeline_version: extra.version === undefined ? 3 : extra.version,
  });

  test("inserts in order, patches in place and flashes only the row that changed", () => {
    const table = ui.runsTable({ columns: ["status", "run", "version", "steps"] });
    table.update([run("b", "succeeded")]);
    const body = fake(table.node.querySelector(".table tbody")!);
    const firstRow = body.children[0]!;
    expect(count(table.node, "tbody tr")).toBe(1);
    expect(firstRow.getAttribute("class")).not.toContain("is-new");

    // The same run again, in the same place: the row is the same node, and nothing flashes.
    table.update([run("b", "succeeded")]);
    expect(body.children[0]).toBe(firstRow);
    expect(firstRow.classList.contains("is-new")).toBe(false);

    // A new run above it and the old one changing status.
    table.update([run("a", "failed", { failed: 1 }), run("b", "running")]);
    expect(count(table.node, "tbody tr")).toBe(2);
    expect(body.children[0]!.textContent).toContain("a");
    expect(body.children[1]).toBe(firstRow);
    expect(firstRow.classList.contains("is-new")).toBe(true);
    expect(body.children[0]!.textContent).toContain("1 failed");
    expect(firstRow.textContent).toContain("3 / 4");
    // The newly inserted row flashes too: a run that just appeared is a change under the reader.
    expect(body.children[0]!.classList.contains("is-new")).toBe(true);
  });

  test("shows an em dash for a field an older server did not send", () => {
    const table = ui.runsTable({ columns: ["version", "steps"] });
    const old = {
      id: "c",
      pipeline: "p",
      status: "succeeded",
      created_at: new Date().toISOString(),
      finished_at: null,
      cancel_requested_at: null,
    };
    table.update([old]);
    const cells = fakes(table.node.querySelectorAll("tbody td"));
    expect(cells.map((cell) => text(cell))).toEqual(["—", "—"]);
  });

  test("an empty table is one sentence", () => {
    const table = ui.runsTable({ empty: "Nothing is running." });
    expect(table.node.querySelector(".table__empty")!.textContent).toContain("Nothing is running.");
  });
});

describe("tabs and segmented controls", () => {
  test("a tablist moves with the arrow keys and swaps its panel", () => {
    const seen: string[] = [];
    const node = ui.tabs(
      [
        { id: "logs", label: "Logs", panel: "the log" },
        { id: "steps", label: "Steps", panel: "the steps" },
      ],
      "logs",
      (id: string) => seen.push(id),
    );
    const tabs = fakes(node.querySelectorAll(".tab"));
    const panels = fakes(node.querySelectorAll(".tabpanel"));
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(panels[1]!.hidden).toBe(true);

    tabs[0]!.fire("keydown", { key: "ArrowRight" });
    expect(seen).toEqual(["steps"]);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(panels[0]!.hidden).toBe(true);
    expect(panels[1]!.hidden).toBe(false);

    tabs[1]!.fire("keydown", { key: "Home" });
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
  });

  test("a segmented control is a radio group that chooses with the arrow keys", () => {
    const seen: string[] = [];
    const node = ui.segmented("Window", ["24h", "7d", "30d"], "24h", (value: string) => seen.push(value));
    const buttons = fakes(node.querySelectorAll(".segmented__btn"));
    expect(node.getAttribute("role")).toBe("radiogroup");
    expect(buttons[0]!.getAttribute("aria-checked")).toBe("true");
    buttons[0]!.fire("keydown", { key: "ArrowRight" });
    expect(seen).toEqual(["7d"]);
    expect(buttons[1]!.getAttribute("aria-checked")).toBe("true");
    buttons[1]!.fire("keydown", { key: "End" });
    expect(seen).toEqual(["7d", "30d"]);
  });
});

describe("barChart", () => {
  test("one group with a title per bar, stacked from the baseline, with a hidden table", () => {
    const chart = ui.barChart({
      bars: [
        {
          key: "a",
          label: "5 Nov, 20:00",
          title: "5 Nov, 20:00 · 1 failed, 2 succeeded",
          segments: [
            { status: "failed", value: 1 },
            { status: "succeeded", value: 2 },
          ],
        },
        { key: "b", label: "5 Nov, 21:00", title: "5 Nov, 21:00 · nothing", segments: [] },
      ],
      height: 160,
      yLabel: "Runs",
    });
    const groups = chart.querySelectorAll("g.chart__bar");
    expect(groups.length).toBe(2);
    expect(groups[0]!.querySelector("title")!.textContent).toBe("5 Nov, 20:00 · 1 failed, 2 succeeded");

    const rects = groups[0]!.querySelectorAll("rect");
    expect(rects.length).toBe(2);
    expect(Number(rects[0]!.getAttribute("y"))).toBeGreaterThan(Number(rects[1]!.getAttribute("y")));
    expect(rects[0]!.getAttribute("fill")).toBe("url(#tone-crosshatch)");
    expect(rects[1]!.getAttribute("fill")).toBe("currentColor");

    const hidden = chart.querySelector("table.chart__data")!;
    expect(hidden.classList.contains("sr")).toBe(true);
    expect(hidden.textContent).toContain("5 Nov, 20:00");
    expect(hidden.textContent).toContain("1");
    expect(hidden.textContent).toContain("2");
    expect(chart.querySelectorAll(".chart__legend-entry").length).toBe(2);
  });
});

describe("table", () => {
  test("an empty table is a sentence and one action", () => {
    const node = ui.table([{ header: "Name", cell: (row: string) => row }], [], {
      empty: "No blocks in the library yet.",
      emptyAction: ui.linkButton("New block", "/app/blocks-new"),
    });
    expect(node.querySelector(".table__empty")!.textContent).toContain("No blocks in the library yet.");
    expect(node.querySelector(".table__empty a")!.getAttribute("href")).toBe("/app/blocks-new");
  });

  test("rows carry data-label for the stacked layout, and a stretched link where the row opens", () => {
    const node = ui.table(
      [
        { header: "Name", cell: (row: string) => row },
        { header: "Size", cell: () => "12", align: "right" as const },
      ],
      ["count-words"],
      { rowHref: (row: string) => `/app/blocks/${row}` },
    );
    const cells = node.querySelectorAll("tbody td");
    expect(cells[0]!.getAttribute("data-label")).toBe("Name");
    expect(cells[1]!.getAttribute("data-label")).toBe("Size");
    expect(cells[1]!.classList.contains("num")).toBe(true);
    const link = cells[0]!.querySelector("a.table__link")!;
    expect(link.getAttribute("href")).toBe("/app/blocks/count-words");
  });
});

describe("codeView", () => {
  test("numbers every line in a gutter, and can leave the gutter off", () => {
    const numbered = ui.codeView("first\nsecond\n", { lineNumbers: true });
    expect(numbered.querySelector(".codeview__gutter")!.textContent).toBe("1\n2");
    expect(numbered.querySelector(".codeview__code")!.textContent).toBe("first\nsecond\n");
    const plain = ui.codeView("only", { lineNumbers: false });
    expect(plain.querySelector(".codeview__gutter")).toBeNull();
  });
});

afterAll(() => {
  uninstallDom(dom);
  rmSync(served, { recursive: true, force: true });
});
