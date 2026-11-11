// The Pipelines list, through the stand-in browser: every row's cells arrive from their own read, a
// read that fails says so in its own cell, and no row opens more than its share of the four reads.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  FakeServer,
  closeAll,
  installPipelinesGlobals,
  openPipelines,
  pipelineFixture,
  restorePipelinesGlobals,
  summary,
  version,
  type FakeElement,
} from "./pipelines.testkit.ts";

// The testkit put the stand-in browser up when the first file imported it; a file that ran since may
// have taken it down, so every file that uses the kit puts it back at its own top level.
installPipelinesGlobals();

const text = (node: FakeElement | null): string => node?.textContent ?? "";
const rowsOf = (view: FakeElement): FakeElement[] => view.querySelectorAll("tbody tr");
const rowNamed = (view: FakeElement, name: string): FakeElement => {
  const row = rowsOf(view).find((entry) => entry.textContent.includes(name));
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
};
const linkNamed = (view: FakeElement, name: string): FakeElement | null =>
  view.querySelectorAll("a").find((entry) => entry.textContent.trim() === name) ?? null;

const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

function wordReport(): ReturnType<typeof pipelineFixture> {
  return pipelineFixture("word-report", [
    version("word-report", 1, { description: "The first report.", created: ago(120) }),
    version("word-report", 2, { description: "Turn a corpus into a report.", created: ago(60) }),
  ]);
}

afterEach(() => {
  closeAll();
});

afterAll(() => {
  restorePipelinesGlobals();
});

describe("the pipelines list", () => {
  test("draws a row from the names and fills each cell from its own read", async () => {
    const server = new FakeServer();
    server.pipelines = [
      wordReport(),
      pipelineFixture("nightly-sync", [version("nightly-sync", 1, { description: "Copy the night's files.", created: ago(30) })]),
    ];
    server.runs = [
      summary("20261105T201258Z-f1549287", "succeeded", { pipeline: "word-report", created_at: ago(3), finished_at: ago(2) }),
      summary("20261105T191258Z-a1549287", "failed", { pipeline: "word-report", created_at: ago(70), finished_at: ago(69) }),
      summary("20261105T181258Z-b1549287", "succeeded", { pipeline: "nightly-sync", created_at: ago(20), finished_at: ago(19) }),
    ];

    const view = await openPipelines(server);

    expect(text(view.querySelector("h1"))).toBe("Pipelines");
    expect(rowsOf(view).length).toBe(2);
    expect(text(rowNamed(view, "word-report"))).toContain("v2");
    expect(text(rowNamed(view, "word-report"))).toContain("Turn a corpus into a report.");
    expect(rowNamed(view, "word-report").querySelector(".pipelines-description")).not.toBeNull();
    expect(text(rowNamed(view, "word-report"))).toContain("3 min ago");
    expect(rowNamed(view, "word-report").querySelectorAll(".history-strip__link").length).toBe(2);
    expect(text(rowNamed(view, "nightly-sync"))).toContain("Copy the night's files.");
    expect(text(rowNamed(view, "nightly-sync"))).toContain("succeeded");

    expect(server.calls).toContain("GET /v1/pipelines/word-report/2");
    expect(server.calls).toContain("GET /v1/runs?limit=10&pipeline=word-report");
    expect(linkNamed(view, "New pipeline")?.getAttribute("href")).toBe("/app/pipelines-new");
    expect(linkNamed(view, "word-report")?.getAttribute("href")).toBe("/app/pipelines/word-report");
  });

  test("a read that fails says so in its own cell and leaves the other rows alone", async () => {
    const server = new FakeServer();
    server.pipelines = [
      wordReport(),
      pipelineFixture("nightly-sync", [version("nightly-sync", 1, { description: "Copy the night's files.", created: ago(30) })]),
    ];
    server.runs = [
      summary("20261105T181258Z-b1549287", "succeeded", { pipeline: "nightly-sync", created_at: ago(20), finished_at: ago(19) }),
    ];
    server.failures.set("GET /v1/pipelines/nightly-sync/1", "the pipeline file is gone");

    const view = await openPipelines(server);
    const broken = rowNamed(view, "nightly-sync");
    const healthy = rowNamed(view, "word-report");

    expect(text(broken.children[1]!)).toContain("internal_error: the pipeline file is gone");
    expect(text(broken.children[3]!)).toContain("succeeded");
    expect(text(healthy.children[1]!)).toContain("Turn a corpus into a report.");
    expect(text(healthy.children[1]!)).not.toContain("internal_error");
  });

  test("the per-row reads run four at a time, however many pipelines there are", async () => {
    const server = new FakeServer();
    server.delayMs = 1;
    server.pipelines = Array.from({ length: 10 }, (_, index) =>
      pipelineFixture(`pipeline-${index}`, [version(`pipeline-${index}`, 1, { description: `Pipeline ${index}.` })]),
    );

    await openPipelines(server);

    // Two reads per row, twenty in all, and never more than four on the wire together.
    expect(server.calls.length).toBe(21);
    expect(server.mostActive).toBe(4);
  });

  test("an empty library says so, and only a write token is offered the way to fill it", async () => {
    const server = new FakeServer();
    const writable = await openPipelines(server, "write");
    expect(text(writable.querySelector(".table__empty"))).toContain("No pipelines stored yet.");
    expect(text(writable)).toContain("New pipeline");

    const readOnly = await openPipelines(server, "read");
    expect(text(readOnly)).toContain("No pipelines stored yet.");
    expect(text(readOnly)).not.toContain("New pipeline");
  });

  test("a list that will not load is an error box, not an empty library", async () => {
    const server = new FakeServer();
    server.failures.set("GET /v1/pipelines", "the database is locked");

    const view = await openPipelines(server);

    expect(text(view.querySelector(".state--error code"))).toBe("internal_error");
    expect(text(view.querySelector(".state--error"))).toContain("the database is locked");
    expect(text(view.querySelector(".table__empty"))).toBe("");
  });
});
