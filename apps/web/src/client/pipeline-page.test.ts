// One pipeline, through the stand-in browser: its header, its four tabs, the runs that read on their
// own clock, and the Start dialog built from the version's own contract.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { PipelineVersion, Run } from "./api.ts";
import {
  FakeClock,
  FakeServer,
  appStub,
  closeAll,
  installPipelinesGlobals,
  openPipeline,
  pipelineFixture,
  restorePipelinesGlobals,
  runFixture,
  setHidden,
  settle,
  summary,
  ui,
  version,
  waitFor,
  type FakeElement,
} from "./pipelines.testkit.ts";

// The testkit put the stand-in browser up when the first file imported it; a file that ran since may
// have taken it down, so every file that uses the kit puts it back at its own top level.
installPipelinesGlobals();

const T0 = "2026-11-05T20:12:58Z";

const WORD_YAML = `name: word-report
description: Turn a corpus into a report.
max_parallel: 2
inputs:
  lines:
    type: integer
    description: How many lines.
    default: 100
  title:
    type: string
    description: The report title.
steps:
  generate:
    uses: generate-corpus@1
    with:
      lines: \${{ inputs.lines }}
  render:
    uses: render-report@1
    needs: [generate]
    with:
      corpus: \${{ steps.generate.outputs.corpus }}
outputs:
  report:
    value: \${{ steps.render.outputs.report }}
`;

const GENERATE = `#!/usr/bin/env bash
# ---
# name: generate-corpus
# description: Build the corpus.
# inputs:
#   lines:
#     type: integer
#     description: How many lines.
# outputs:
#   corpus:
#     type: file
#     description: The corpus.
# ---
echo generated
`;

const RENDER = `#!/usr/bin/env bash
# ---
# name: render-report
# description: Render the report.
# inputs:
#   corpus:
#     type: file
#     description: The corpus.
# outputs:
#   report:
#     type: file
#     description: The report.
# ---
echo rendered
`;

function wordReport(): ReturnType<typeof pipelineFixture> {
  return pipelineFixture("word-report", [
    version("word-report", 1, { description: "The first report.", created: "2026-11-01T10:00:00Z" }),
    version("word-report", 2, { description: "The second report.", created: "2026-11-03T10:00:00Z" }),
    version("word-report", 3, {
      description: "Turn a corpus into a report.",
      created: T0,
      yaml: WORD_YAML,
      inputs: [
        { name: "lines", type: "integer", description: "How many lines.", default: 100 },
        { name: "title", type: "string", description: "The report title." },
        { name: "source", type: "file", description: "Where the corpus starts." },
      ],
      outputs: [{ name: "report", step: "render", output: "report" }],
    }),
  ]);
}

function withBlocks(server: FakeServer): FakeServer {
  server.pipelines = [wordReport()];
  server.blocks.set("generate-corpus@1", GENERATE);
  server.blocks.set("render-report@1", RENDER);
  return server;
}

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `20261105T2012${String(index).padStart(2, "0")}Z-aaaaaaaa`);
}

function manyRuns(count: number): ReturnType<typeof summary>[] {
  return ids(count).map((id) => summary(id, "succeeded", { pipeline: "word-report", created_at: T0, finished_at: "2026-11-05T20:13:00Z" }));
}

function runLasting(id: string, ms: number): ReturnType<typeof summary> {
  return summary(id, "succeeded", {
    pipeline: "word-report",
    created_at: T0,
    finished_at: new Date(Date.parse(T0) + ms).toISOString(),
  });
}

const text = (node: FakeElement | null | undefined): string => node?.textContent ?? "";
const rowsOf = (view: FakeElement, selector = "tbody tr"): FakeElement[] => view.querySelectorAll(selector);
const runRows = (view: FakeElement): FakeElement[] => rowsOf(view, ".runstable tbody tr").filter((row) => !row.classList.contains("table__empty"));
const buttonNamed = (view: FakeElement, label: string): FakeElement | null =>
  view.querySelectorAll("button").find((entry) => entry.textContent.trim() === label) ?? null;
const linkNamed = (view: FakeElement, label: string): FakeElement | null =>
  view.querySelectorAll("a").find((entry) => entry.textContent.trim() === label) ?? null;

afterEach(() => {
  closeAll();
  setHidden(false);
  appStub.navigations.length = 0;
});

afterAll(() => {
  restorePipelinesGlobals();
});

describe("the pipeline header", () => {
  test("shows the breadcrumb, description, version, stored time and the first twelve characters of the hash", async () => {
    const server = withBlocks(new FakeServer());
    const clock = new FakeClock();
    clock.set(T0);
    const { view, controller } = await openPipeline(server, "word-report", "", { clock });
    await waitFor("the runs table", () => view.querySelector(".runstable") !== null);

    expect(text(view.querySelector("h1"))).toBe("word-report");
    expect(text(view.querySelector(".crumbs"))).toContain("Pipelines");
    expect(text(view.querySelector(".crumbs"))).toContain("word-report");
    expect(text(view.querySelector(".pipeline-lead"))).toBe("Turn a corpus into a report.");
    expect(text(view.querySelector(".meta-line"))).toContain("v3 of 3");
    expect(text(view.querySelector(".meta-line"))).toContain("0123456789ab");
    expect(text(view.querySelector(".meta-line"))).not.toContain("0123456789abc");

    const select = view.querySelector('[id="pipeline-version"]')!;
    expect(select.children.map((option) => option.textContent)).toEqual(["v3 (latest)", "v2", "v1"]);
    expect(select.children[0]!.getAttribute("selected")).not.toBeNull();
    controller.abort();
  });

  test("the version picker puts the chosen version and the open tab in the address", async () => {
    const server = withBlocks(new FakeServer());
    const { view, controller } = await openPipeline(server, "word-report");

    const select = view.querySelector('[id="pipeline-version"]')!;
    select.value = "2";
    select.fire("change");

    expect(appStub.navigations.at(-1)).toEqual({
      path: "/pipelines/word-report?version=2&tab=runs",
      options: { replace: true },
    });
    controller.abort();
  });

  test("opening an older version reads that version and says so", async () => {
    const server = withBlocks(new FakeServer());
    const { view, controller } = await openPipeline(server, "word-report", "version=2");

    expect(server.calls).toContain("GET /v1/pipelines/word-report/2");
    expect(text(view.querySelector(".meta-line"))).toContain("v2 of 3");
    expect(text(view.querySelector(".pipeline-lead"))).toBe("The second report.");
    expect(view.querySelector('[id="pipeline-version"]')!.children[1]!.getAttribute("selected")).not.toBeNull();
    controller.abort();
  });

  test("a read token is not offered Run or Edit", async () => {
    const server = withBlocks(new FakeServer());
    const { view, controller } = await openPipeline(server, "word-report", "", { scope: "read" });

    expect(view.querySelector('[id="pipeline-version"]')).not.toBeNull();
    expect(buttonNamed(view, "Run")).toBeNull();
    expect(linkNamed(view, "Edit")).toBeNull();
    controller.abort();
  });

  test("a pipeline that does not exist says pipeline_not_found and links back to Pipelines", async () => {
    const server = new FakeServer();
    const { view } = await openPipeline(server, "missing");

    expect(text(view.querySelector(".state--error code"))).toBe("pipeline_not_found");
    expect(linkNamed(view, "All pipelines")?.getAttribute("href")).toBe("/app/pipelines");
  });
});

describe("the runs tab", () => {
  test("charts the last thirty runs with the newest on the right, and pages the table", async () => {
    const server = withBlocks(new FakeServer());
    server.runs = manyRuns(55);
    const clock = new FakeClock();
    clock.set(T0);
    const { view, controller } = await openPipeline(server, "word-report", "", { clock });
    await waitFor("the first page of runs", () => runRows(view).length === 50);

    const bars = view.querySelectorAll(".chart__bar");
    expect(bars.length).toBe(30);
    expect(bars[0]!.getAttribute("data-key")).toBe(ids(55)[25]!);
    expect(bars[bars.length - 1]!.getAttribute("data-key")).toBe(ids(55)[54]!);
    expect(bars[bars.length - 1]!.getAttribute("data-href")).toBe(`/app/runs/${ids(55)[54]!}`);

    const more = buttonNamed(view, "Load more");
    const moreBox = view.querySelector(".pipeline-more")!;
    expect(more).not.toBeNull();
    expect(moreBox.hidden).toBe(false);
    more!.fire("click");
    await waitFor("the second page of runs", () => runRows(view).length === 55);
    expect(moreBox.hidden).toBe(true);
    controller.abort();
  });

  test("reads again after a second while a run is going, and after fifteen when none is", async () => {
    const server = withBlocks(new FakeServer());
    const id = "20261105T201258Z-f1549287";
    server.runs = [summary(id, "running", { pipeline: "word-report", created_at: T0 })];
    const clock = new FakeClock();
    clock.set(T0);
    const { view, controller } = await openPipeline(server, "word-report", "", { clock });
    await waitFor("the running run", () => runRows(view).length === 1);
    expect(server.count("GET /v1/runs")).toBe(1);

    await clock.advance(1_000);
    expect(server.count("GET /v1/runs")).toBe(2);

    server.runs = [summary(id, "succeeded", { pipeline: "word-report", created_at: T0, finished_at: "2026-11-05T20:13:00Z" })];
    await clock.advance(1_000);
    expect(server.count("GET /v1/runs")).toBe(3);
    expect(text(view.querySelector(".runstable tbody tr"))).toContain("succeeded");

    await clock.advance(1_000);
    expect(server.count("GET /v1/runs")).toBe(3);
    await clock.advance(15_000);
    expect(server.count("GET /v1/runs")).toBe(4);
    controller.abort();
  });

  test("reads nothing while the tab is hidden, and reads at once when it comes back", async () => {
    const server = withBlocks(new FakeServer());
    server.runs = [summary("20261105T201258Z-f1549287", "running", { pipeline: "word-report", created_at: T0 })];
    const clock = new FakeClock();
    clock.set(T0);
    const { view, controller } = await openPipeline(server, "word-report", "", { clock });
    await waitFor("the running run", () => runRows(view).length === 1);
    expect(server.count("GET /v1/runs")).toBe(1);

    setHidden(true);
    await clock.advance(5_000);
    expect(server.count("GET /v1/runs")).toBe(1);

    setHidden(false);
    await waitFor("a read when the tab comes back", () => server.count("GET /v1/runs") >= 2);
    controller.abort();
  });

  test("a poll patches the row and keeps the focus on the run link", async () => {
    const server = withBlocks(new FakeServer());
    const id = "20261105T201258Z-f1549287";
    server.runs = [summary(id, "running", { pipeline: "word-report", created_at: T0 })];
    const clock = new FakeClock();
    clock.set(T0);
    const { view, controller } = await openPipeline(server, "word-report", "", { clock });
    await waitFor("the running run", () => runRows(view).length === 1);

    const link = view.querySelector(".runstable tbody .table__link")!;
    link.focus();
    server.runs = [summary(id, "succeeded", { pipeline: "word-report", created_at: T0, finished_at: "2026-11-05T20:13:00Z" })];
    await clock.advance(1_000);

    expect((globalThis as unknown as { document: { activeElement: FakeElement } }).document.activeElement).toBe(link);
    expect(text(view.querySelector(".runstable tbody tr"))).toContain("succeeded");
    controller.abort();
  });

  test("a lost read is named over the rows it already has, and cleared when one lands again", async () => {
    const server = withBlocks(new FakeServer());
    server.runs = [summary("20261105T201258Z-f1549287", "running", { pipeline: "word-report", created_at: T0 })];
    const clock = new FakeClock();
    clock.set(T0);
    const { view, controller } = await openPipeline(server, "word-report", "", { clock });
    await waitFor("the running run", () => runRows(view).length === 1);

    server.failures.set("GET /v1/runs", "the api is down");
    await clock.advance(1_000);
    const note = view.querySelector(".runlist__note")!;
    expect(note.hidden).toBe(false);
    expect(text(note)).toContain("Lost the server, still trying. internal_error: the api is down");
    expect(runRows(view).length).toBe(1);

    server.failures.delete("GET /v1/runs");
    await clock.advance(1_000);
    expect(note.hidden).toBe(true);
    controller.abort();
  });
});

describe("the duration chart's ticks", () => {
  test("a sub-second range has fractions, with zero at the baseline", async () => {
    const server = withBlocks(new FakeServer());
    server.runs = [runLasting("20261105T201258Z-f1549287", 500)];
    const clock = new FakeClock();
    clock.set(T0);
    const { view, controller } = await openPipeline(server, "word-report", "", { clock });
    await waitFor("the three ticks", () => view.querySelectorAll(".chart__axis text").length === 3);

    expect(view.querySelectorAll(".chart__axis text").map((node) => text(node))).toEqual(["0", "0.25 s", "0.5 s"]);
    controller.abort();
  });

  test("a range of minutes keeps whole units and drops the empty seconds", async () => {
    const server = withBlocks(new FakeServer());
    server.runs = [runLasting("20261105T201258Z-f1549287", 300_000)];
    const clock = new FakeClock();
    clock.set(T0);
    const { view, controller } = await openPipeline(server, "word-report", "", { clock });
    await waitFor("the three ticks", () => view.querySelectorAll(".chart__axis text").length === 3);

    expect(view.querySelectorAll(".chart__axis text").map((node) => text(node))).toEqual(["0", "2 m 30 s", "5 m"]);
    controller.abort();
  });
});

describe("the definition tab", () => {
  test("paints the YAML with line numbers and draws the graph from the library's blocks", async () => {
    const server = withBlocks(new FakeServer());
    const { view, controller } = await openPipeline(server, "word-report", "tab=definition");
    await waitFor("the two graph nodes", () => view.querySelectorAll(".node").length === 2);

    expect(text(view.querySelector(".codeview__gutter"))).toStartWith("1");
    expect(text(view.querySelector(".codeview__code"))).toContain("name: word-report");
    expect(text(view.querySelector(".pipeline-definition__graph"))).toContain("generate");
    expect(server.calls).toContain("GET /v1/blocks/generate-corpus/1/content");
    expect(server.calls).toContain("GET /v1/blocks/render-report/1/content");

    const before = appStub.navigations.length;
    view.querySelector(".node")!.fire("click");
    expect(appStub.navigations.length).toBe(before);
    controller.abort();
  });
});

describe("the versions tab", () => {
  test("lists every version newest first, with its stored time, short hash and edit link", async () => {
    const server = withBlocks(new FakeServer());
    const { view, controller } = await openPipeline(server, "word-report", "tab=versions");

    const rows = rowsOf(view, ".pipeline-versions tbody tr");
    expect(rows.length).toBe(3);
    expect(text(rows[0])).toContain("v3");
    expect(text(rows[0])).toContain("0123456789ab");
    expect(rows[0]!.querySelector("time")!.getAttribute("title")).toBe(ui.exactTime(T0));
    expect(rows[0]!.querySelector("a")!.getAttribute("href")).toBe("/app/pipelines/word-report?tab=definition&version=3");
    expect(rows[0]!.querySelector("a")!.getAttribute("aria-current")).toBe("true");
    expect(linkNamed(view, "Edit from this version")?.getAttribute("href")).toBe("/app/pipelines/word-report/edit?version=3");
    controller.abort();
  });

  test("a read token sees the versions and no edit action", async () => {
    const server = withBlocks(new FakeServer());
    const { view, controller } = await openPipeline(server, "word-report", "tab=versions", { scope: "read" });

    expect(rowsOf(view, ".pipeline-versions tbody tr").length).toBe(3);
    expect(linkNamed(view, "Edit from this version")).toBeNull();
    expect(text(view.querySelector(".pipeline-versions thead"))).not.toContain("Actions");
    controller.abort();
  });
});

describe("the inputs tab", () => {
  test("shows the inputs with their types, defaults and descriptions, then the output expressions", async () => {
    const server = withBlocks(new FakeServer());
    const { view, controller } = await openPipeline(server, "word-report", "tab=inputs");

    const tables = view.querySelectorAll(".pipeline-contract table");
    expect(tables.length).toBe(2);
    const inputs = tables[0]!.querySelectorAll("tbody tr");
    expect(text(inputs[0])).toContain("lines");
    expect(text(inputs[0])).toContain("integer");
    expect(text(inputs[0])).toContain("100");
    expect(text(inputs[0])).toContain("How many lines.");
    expect(text(inputs[1])).toContain("title");
    expect(text(inputs[1])).toContain("required");
    expect(text(inputs[2])).toContain("source");
    expect(text(inputs[2])).toContain("file");

    const outputs = tables[1]!.querySelectorAll("tbody tr");
    expect(text(outputs[0])).toContain("report");
    expect(text(outputs[0])).toContain("${{ steps.render.outputs.report }}");
    expect(outputs[0]!.querySelector("code")!.className).toContain("mono");
    controller.abort();
  });
});

describe("starting a run from the pipeline", () => {
  test("opens the version's inputs, sends the touched ones, and opens the new run", async () => {
    const server = withBlocks(new FakeServer());
    const started: Run = { ...runFixture(), inputs: { title: "Weekly words" } };
    server.started = started;
    const { view, controller } = await openPipeline(server, "word-report");

    buttonNamed(view, "Run")!.fire("click");
    const dialog = view.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    expect(text(dialog)).toContain("Start word-report");

    const title = dialog.querySelector('[id="start-in-title"]')!;
    const lines = dialog.querySelector('[id="start-in-lines"]')!;
    expect(lines.value).toBe("100");
    title.value = "Weekly words";
    dialog.querySelector("[id=\"start-in-source\"]")!.value = "/tmp/corpus.txt";
    dialog.querySelector("form")!.fire("submit");
    await settle();

    expect(server.posted).toEqual([
      { pipeline: "word-report", version: 3, inputs: { title: "Weekly words", source: "/tmp/corpus.txt" } },
    ]);
    expect(appStub.navigations.at(-1)?.path).toBe(`/runs/${started.id}`);
    controller.abort();
  });

  test("a refused start stays in the dialog in the server's own words", async () => {
    const server = withBlocks(new FakeServer());
    server.failures.set("POST /v1/runs", "the engine is not running");
    const { view, controller } = await openPipeline(server, "word-report");

    buttonNamed(view, "Run")!.fire("click");
    const dialog = view.querySelector("dialog")!;
    dialog.querySelector('[id="start-in-title"]')!.value = "Weekly words";
    dialog.querySelector('[id="start-in-source"]')!.value = "/tmp/corpus.txt";
    dialog.querySelector("form")!.fire("submit");
    await settle();

    expect(dialog.open).toBe(true);
    expect(text(dialog)).toContain("internal_error");
    expect(text(dialog)).toContain("the engine is not running");
    controller.abort();
  });
});

// A version whose parsed form is missing is still read by analyze, so the tab does not go blank when
// an older server sends a shape this build does not know.
describe("a version whose parsed form cannot be read", () => {
  test("the inputs tab falls back to the YAML's own contract", async () => {
    const server = withBlocks(new FakeServer());
    const record = wordReport().versions[2]! as PipelineVersion;
    record.parsed = {};
    const { view, controller } = await openPipeline(server, "word-report", "tab=inputs");

    const tables = view.querySelectorAll(".pipeline-contract table");
    const inputs = tables[0]!.querySelectorAll("tbody tr");
    expect(text(inputs[0])).toContain("lines");
    expect(text(inputs[0])).toContain("integer");
    controller.abort();
  });
});
