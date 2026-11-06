// The graph, painted. The DOM is the stand-in in dom.testkit.ts and the modules are the bytes the
// server serves, so what runs here is what the browser runs — see that file for what the stand-in does
// and does not pretend to be.
//
// Every case is one paint: analyse, hand it to the graph, and check the layout ran to the end. The
// ones that matter are the first paint of a stored pipeline, which has wires whose steps have no
// contracts yet and so no ports to anchor on, and the repaint after the library answers.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { blockSource, decls, installDom, serveModules, uninstallDom, type FakeElement } from "./client.testkit.ts";
import type { Library } from "./model.ts";

const dom = installDom();
const served = serveModules(["dom", "yaml", "model", "graph"]);
const { analyze } = (await import(join(served, "model.js"))) as typeof import("./model.ts");
const { createGraph } = (await import(join(served, "graph.js"))) as typeof import("./graph.ts");

afterAll(() => {
  uninstallDom(dom);
  rmSync(served, { recursive: true, force: true });
});

// ---------- documents, and the library that arrives later ----------

const YAML = `name: word-report
description: Count the words of a corpus and render a report.

max_parallel: 2

inputs:
  lines:
    type: integer
    default: 200

steps:
  generate:
    name: Generate the corpus
    uses: generate-corpus@1
    with:
      lines: \${{ inputs.lines }}

  check:
    name: Check the corpus
    uses: check-corpus@1
    needs: generate
    with:
      corpus: \${{ steps.generate.outputs.corpus }}
`;

const EMPTY = `name: empty-pipeline
description: Nothing in it yet.

steps:
`;

const INDEPENDENT = `name: two-at-once
description: Two steps that do not read each other.

steps:
  left:
    uses: left-block@1
  right:
    uses: right-block@1
`;

const DIAMOND = `name: diamond
description: One in, two in parallel, one out.

steps:
  a:
    uses: a-block@1
  b:
    uses: b-block@1
    with:
      in: \${{ steps.a.outputs.out }}
  c:
    uses: c-block@1
    with:
      in: \${{ steps.a.outputs.out }}
  d:
    uses: d-block@1
    with:
      left: \${{ steps.b.outputs.out }}
      right: \${{ steps.c.outputs.out }}
`;

const CHAIN = `name: chain
description: Six steps, each reading the one before.

steps:
${[0, 1, 2, 3, 4, 5]
  .map((n) => `  step-${n}:\n    uses: block-${n}@1${n === 0 ? "" : `\n    with:\n      in: \${{ steps.step-${n - 1}.outputs.out }}`}`)
  .join("\n")}
`;

const LIBRARY: Library = {
  "generate-corpus": {
    name: "generate-corpus",
    versions: [
      {
        version: 1,
        source: blockSource("generate-corpus", decls("inputs", [["lines", "integer"]]), decls("outputs", [["corpus", "string"]])),
      },
    ],
  },
  "check-corpus": {
    name: "check-corpus",
    versions: [
      {
        version: 1,
        source: blockSource("check-corpus", decls("inputs", [["corpus", "string"]]), decls("outputs", [["ok", "boolean"]])),
      },
    ],
  },
};

/** One paint, the way `setText(..., { source: "load" })` does it: analyse, then hand it to the graph. */
function paint(text: string, library: Library, width: number) {
  const analysis = analyze(text, library);
  if (!analysis.ok) throw new Error(`the test document does not parse: ${JSON.stringify(analysis.problems)}`);
  const stage = dom.document.createElement("div");
  stage.className = "stage";
  stage.clientWidth = width;
  const graph = createGraph(stage as unknown as HTMLElement, { onSelect: () => {} });
  graph.update({ analysis, selected: analysis.order[0] ?? null, stale: false });
  return { analysis, stage };
}

/** Every wire the layout drew, with the numbers it drew them at. */
function wires(stage: FakeElement): { from: string; to: string; d: string }[] {
  return stage.querySelectorAll(".wire").map((wire) => ({
    from: wire.getAttribute("data-from") ?? "",
    to: wire.getAttribute("data-to") ?? "",
    d: wire.getAttribute("d") ?? "",
  }));
}

/** A wire that was drawn: a move and a run of horizontal and vertical legs, all whole pixels.
 *  Negative coordinates are allowed, because the layering defect (BASHR-14) still sends some off
 *  the left of the canvas; that ticket is where the check for them belongs. */
const DRAWN = /^M-?\d+ -?\d+(?:[HV]-?\d+)+$/;

/** The one paint every case has to survive: steps drawn, one wire per edge, every wire a real path. */
function expectDrawn(stage: FakeElement, analysis: ReturnType<typeof analyze>): void {
  if (!analysis.ok) throw new Error("expected an analysis");
  expect(stage.querySelectorAll(".node").length).toBe(analysis.steps.length);
  expect(wires(stage).length).toBe(analysis.edges.length);
  for (const wire of wires(stage)) expect(wire.d).toMatch(DRAWN);
}

describe("drawing a graph", () => {
  test("lays out every step and every wire in the wide flow layout", () => {
    const { analysis, stage } = paint(YAML, LIBRARY, 960);
    expect(analysis.maxParallel).toBe(2);
    expect(stage.classList.contains("stage--flow")).toBe(true);
    expect(analysis.edges.length).toBeGreaterThan(0);
    expect(stage.querySelectorAll(".port").length).toBe(4);
    expect(stage.querySelectorAll('.port--out[data-name="corpus"]').length).toBe(1);
    expectDrawn(stage, analysis);
  });

  test("lays out every step and every wire in the narrow lane layout", () => {
    const { analysis, stage } = paint(YAML, LIBRARY, 200);
    expect(stage.classList.contains("stage--lanes")).toBe(true);
    expectDrawn(stage, analysis);
  });

  // The load path, which is what threw: opening a stored pipeline hands the whole document over at
  // once, and the block contracts come from the API afterwards. So the first paint has a wire whose
  // source step has no contract and therefore no output ports at all.
  test("draws the graph of a stored pipeline before the library has answered", () => {
    const { analysis, stage } = paint(YAML, {}, 960);
    expect(analysis.steps.every((step) => step.contract === null)).toBe(true);
    expect(analysis.edges.length).toBeGreaterThan(0);
    // Only the `with:` keys have ports: the outputs are named by the contract, and there is none.
    expect(stage.querySelectorAll(".port").length).toBe(2);
    expect(stage.querySelectorAll(".port--out").length).toBe(0);
    expectDrawn(stage, analysis);
  });

  test("draws it in the lane layout too, before the library has answered", () => {
    const { analysis, stage } = paint(YAML, {}, 200);
    expect(stage.classList.contains("stage--lanes")).toBe(true);
    expectDrawn(stage, analysis);
  });

  // The pair of paints the editor actually makes: the document first, then the same text once the
  // library has answered. The wire that had to leave from a step's edge now leaves from its port.
  // editor.test.ts is where the fetch itself is tested; this is the drawing half of it.
  test("moves a wire onto its port in the paint after the library answers", () => {
    const before = wires(paint(YAML, {}, 960).stage);
    const after = wires(paint(YAML, LIBRARY, 960).stage);
    expect(before.length).toBe(after.length);
    expect(before.map((wire) => `${wire.from}>${wire.to}`)).toEqual(after.map((wire) => `${wire.from}>${wire.to}`));
    expect(before.map((wire) => wire.d)).not.toEqual(after.map((wire) => wire.d));
  });

  // A block the library has never heard of keeps its contract null for good, so its wires never get
  // ports to move onto: the fallback is not only a first-paint thing.
  test("draws a wire out of a step whose block the library does not have", () => {
    const partial: Library = { "check-corpus": LIBRARY["check-corpus"]! };
    const { analysis, stage } = paint(YAML, partial, 960);
    expect(analysis.byId["generate"]!.contract).toBeNull();
    expect(analysis.byId["check"]!.contract).not.toBeNull();
    expectDrawn(stage, analysis);
  });

  test("draws the empty state for a pipeline with no steps", () => {
    const { analysis, stage } = paint(EMPTY, {}, 960);
    expect(analysis.steps).toEqual([]);
    expect(stage.querySelector(".stage__empty")).not.toBeNull();
    expect(stage.querySelectorAll(".node").length).toBe(0);
    expect(wires(stage)).toEqual([]);
  });

  test("draws steps that share nothing, with no wires between them", () => {
    const { analysis, stage } = paint(INDEPENDENT, {}, 960);
    expect(analysis.edges).toEqual([]);
    expectDrawn(stage, analysis);
  });

  test("draws a diamond", () => {
    const { analysis, stage } = paint(DIAMOND, {}, 960);
    expect(analysis.steps.length).toBe(4);
    expect(analysis.edges.length).toBe(4);
    expectDrawn(stage, analysis);
  });

  test("draws a chain of six", () => {
    const { analysis, stage } = paint(CHAIN, {}, 960);
    expect(analysis.steps.length).toBe(6);
    expect(analysis.edges.length).toBe(5);
    expectDrawn(stage, analysis);
  });
});
