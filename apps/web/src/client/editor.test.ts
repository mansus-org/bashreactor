// The pipeline screen against a stubbed API: open a stored pipeline and check what a person would
// notice. The blocks the document names get fetched, their ports draw, nothing is reported as missing,
// and the buttons that need a valid document are enabled.
//
// The screen is the real `renderPipeline`, run the way the router runs it, over the bytes the server
// serves. The DOM is the stand-in in client.testkit.ts; the API is a `fetch` that answers the same
// routes with the shapes apps/api answers, and records the paths it was asked for.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { blockSource, decls, installDom, observedStages, serveModules, uninstallDom, type FakeElement } from "./client.testkit.ts";
import type { Route } from "./app.ts";

const dom = installDom({ href: "http://x/app/pipeline/word-report" });
const served = serveModules(["app", "api", "dom", "yaml", "model", "graph", "editor", "runs", "blocks", "logs"]);
const { session } = (await import(join(served, "api.js"))) as typeof import("./api.ts");
const { renderPipeline } = (await import(join(served, "editor.js"))) as typeof import("./editor.ts");

afterAll(() => {
  uninstallDom(dom);
  rmSync(served, { recursive: true, force: true });
  (globalThis as unknown as Record<string, unknown>).fetch = realFetch;
});

// ---------- what the API has ----------

const PINNED = `name: word-report
description: Count the words of a corpus.

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

/** The form `pipelines add` leaves a file in, rewritten to the library — except when it is not. */
const AS_PATHS = PINNED.replace("generate-corpus@1", "./generate-corpus.sh").replace("check-corpus@1", "./check-corpus.sh");

const ONE_UNKNOWN = `name: half-broken
description: One step whose block was never published.

steps:
  lonely:
    uses: gone@1
`;

const meta = (name: string, version: number) => ({
  name,
  version,
  sha256: `${name}-${version}`,
  size: 64,
  created_at: `2026-01-0${version}T09:00:00Z`,
});

const BLOCKS: Record<string, Record<number, string>> = {
  "generate-corpus": {
    1: blockSource("generate-corpus", decls("inputs", [["lines", "integer"]]), decls("outputs", [["corpus", "string"]])),
    3: blockSource(
      "generate-corpus",
      decls("inputs", [["lines", "integer"], ["seed", "integer"]]),
      decls("outputs", [["corpus", "string"]]),
    ),
  },
  "check-corpus": {
    1: blockSource("check-corpus", decls("inputs", [["corpus", "string"]]), decls("outputs", [["ok", "boolean"]])),
  },
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const calls: string[] = [];
let storedYaml = PINNED;

/** A held door, for the tests that need an answer to arrive after the reader has already left. */
class Gate {
  readonly held: Promise<void>;
  release!: () => void;

  constructor() {
    this.held = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
}

/** A gate nobody is holding: the answer goes straight through. */
function openGate(): Gate {
  const opened = new Gate();
  opened.release();
  return opened;
}

let blockGate = openGate();
let pipelineGate = openGate();
let refusePipeline = false;

/** The routes the editor uses, answered the way apps/api answers them. */
async function answer(href: string): Promise<Response> {
  const path = new URL(href).pathname;
  calls.push(path);
  const parts = path.split("/").filter((part) => part !== "");
  if (parts[0] !== "v1") return json({ code: "not_found", message: `no route ${path}` }, 404);

  if (parts[1] === "pipelines" && parts[2] === "word-report") {
    await pipelineGate.held;
    if (refusePipeline) return json({ code: "pipeline_not_found", message: `pipeline "word-report" has no versions` }, 404);
    if (parts.length === 3) return json({ name: "word-report", latest: 2, versions: [meta("word-report", 1), meta("word-report", 2)] });
    return json({ ...meta("word-report", parts[3] === "latest" ? 2 : Number(parts[3])), yaml: storedYaml, parsed: {} });
  }

  if (parts[1] === "blocks" && parts[2] !== undefined) {
    const versions = BLOCKS[parts[2]];
    if (versions === undefined) return json({ code: "block_not_found", message: `block "${parts[2]}" has no versions` }, 404);
    const latest = Math.max(...Object.keys(versions).map(Number));
    if (parts.length === 3) return json({ name: parts[2], latest, versions: Object.keys(versions).map((v) => meta(parts[2]!, Number(v))) });
    const version = parts[3] === "latest" ? latest : Number(parts[3]);
    if (parts[4] === "content") {
      await blockGate.held;
      const source = versions[version];
      if (source === undefined) return json({ code: "block_not_found", message: `no version ${version}` }, 404);
      return new Response(source, { headers: { "content-type": "text/plain; charset=utf-8", "x-block-sha256": "x" } });
    }
    return json(meta(parts[2], version));
  }

  return json({ code: "not_found", message: `no route ${path}` }, 404);
}

const realFetch = globalThis.fetch;
(globalThis as unknown as Record<string, unknown>).fetch = (href: string | URL) => answer(href.toString());

// ---------- opening it ----------
/** The stub answers at once, so this is only the screen's own chain of awaits settling. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const route: Route = { path: "/pipeline/word-report", parts: ["pipeline", "word-report"], query: new URLSearchParams() };

/** What the router does between two screens: paint the next one into the same `view`. */
function navigateAway(view: FakeElement, title: string): void {
  view.replaceChildren(dom.document.createElement("p"));
  dom.document.title = title;
}

beforeEach(() => {
  blockGate = openGate();
  pipelineGate = openGate();
  refusePipeline = false;
});

async function open(yaml: string, signal: AbortSignal = new AbortController().signal): Promise<FakeElement> {
  storedYaml = yaml;
  calls.length = 0;
  session.identity = { name: "test", scope: "admin", admin: true };
  const view = dom.document.createElement("div");
  renderPipeline(view as unknown as HTMLElement, route, signal);
  await settle();
  return view;
}

const button = (view: FakeElement, label: string): FakeElement | undefined =>
  view.querySelectorAll("button").find((node) => node.textContent === label);

describe("opening a stored pipeline", () => {
  test("fetches the blocks the document names", async () => {
    const view = await open(PINNED);
    expect(calls).toEqual([
      "/v1/pipelines/word-report",
      "/v1/pipelines/word-report/2",
      "/v1/blocks/generate-corpus",
      "/v1/blocks/generate-corpus/1/content",
      "/v1/blocks/check-corpus",
      "/v1/blocks/check-corpus/1/content",
    ]);
    expect(view.querySelector(".state--error")).toBeNull();
  });

  test("draws the contracts it fetched, and calls nothing missing", async () => {
    const view = await open(PINNED);
    expect(view.querySelectorAll(".node").length).toBe(2);
    expect(view.querySelectorAll(".wire").length).toBe(1);
    expect(view.querySelectorAll(".port").length).toBe(4);
    expect(view.querySelectorAll('.port--out[data-name="corpus"]').length).toBe(1);
    expect(view.querySelectorAll(".stamp--type").length).toBe(2);
    expect(view.querySelectorAll(".node__problem").length).toBe(0);
    expect(view.querySelectorAll(".problems__list li").length).toBe(0);
    expect(view.querySelector(".state--error")).toBeNull();
  });

  test("lets the reader store and run what the library can answer", async () => {
    const view = await open(PINNED);
    expect(button(view, "Save version")?.disabled).toBe(false);
    expect(button(view, "Start a run")?.disabled).toBe(false);
    expect(button(view, "Validate")?.disabled).toBe(false);
    expect(button(view, "Add step")?.disabled).toBe(false);
  });

  // A `./x.sh` reference has no version in it, and the contract still has to come from somewhere:
  // the newest version in the library is the one analyze draws, and the one the pin button offers.
  test("takes the newest version for a step that names a path", async () => {
    const view = await open(AS_PATHS);
    expect(calls).toContain("/v1/blocks/generate-corpus/3/content");
    expect(calls).not.toContain("/v1/blocks/generate-corpus/1/content");
    expect(view.querySelectorAll(".port").length).toBe(5);
    expect(button(view, "Use library versions (2)")?.hidden).toBe(false);
  });

  test("still paints when a block the library has never heard of is named", async () => {
    const view = await open(ONE_UNKNOWN);
    expect(calls).toContain("/v1/blocks/gone");
    expect(view.querySelector(".state--error")).toBeNull();
    expect(view.querySelectorAll(".node").length).toBe(1);
    expect(view.querySelectorAll(".node__problem").length).toBe(1);
    expect(button(view, "Save version")?.disabled).toBe(true);
  });
});

// The router aborts the signal it hands a screen the moment the reader moves on, and the next screen
// is painted into the same `view`. Anything the pipeline screen answers with after that belongs to
// nobody: it would overwrite the title and land its error card on a screen that is not its own.

describe("leaving the pipeline screen", () => {
  test("drops a library answer that arrives after the reader has gone", async () => {
    const controller = new AbortController();
    blockGate = new Gate();
    const view = await open(PINNED, controller.signal);
    expect(view.querySelectorAll(".port--out").length).toBe(0);

    controller.abort();
    navigateAway(view, "Runs — Bashreactor");
    blockGate.release();
    await settle();

    expect(dom.document.title).toBe("Runs — Bashreactor");
    expect(view.querySelectorAll(".node").length).toBe(0);
    expect(view.querySelectorAll(".state--error").length).toBe(0);
  });

  test("drops an open that fails after the reader has gone", async () => {
    const controller = new AbortController();
    pipelineGate = new Gate();
    const view = await open(PINNED, controller.signal);

    controller.abort();
    navigateAway(view, "Runs — Bashreactor");
    refusePipeline = true;
    pipelineGate.release();
    await settle();

    expect(dom.document.title).toBe("Runs — Bashreactor");
    expect(view.querySelectorAll(".state--error").length).toBe(0);
  });

  test("stops watching the stage when the screen goes away", async () => {
    const controller = new AbortController();
    const observers = observedStages().length;
    await open(PINNED, controller.signal);
    expect(observedStages()[observers]).toEqual({ targets: 1, disconnected: false });

    controller.abort();

    expect(observedStages()[observers]?.disconnected).toBe(true);
  });
});
