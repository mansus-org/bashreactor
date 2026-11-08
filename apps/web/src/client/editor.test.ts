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

// The editor keeps work in progress in `sessionStorage`, which the stand-in browser gives every test
// in this file at once. This is the same store with a `clear`, so one test's draft cannot be the next
// one's surprise.
const tab = new Map<string, string>();
(globalThis as unknown as Record<string, unknown>).sessionStorage = {
  getItem: (key: string) => tab.get(key) ?? null,
  setItem: (key: string, value: string) => void tab.set(key, value),
  removeItem: (key: string) => void tab.delete(key),
  clear: () => tab.clear(),
};

// The stand-in browser has no events on `document` or `window`, and no dialog box. The editor guards
// leaving with all three, so these record what it registered and what the reader was asked.
const pageEvents: { type: string; handler: (event: unknown) => void }[] = [];
const windowEvents: { type: string; handler: (event: unknown) => void }[] = [];
const asked: string[] = [];
let answers: boolean[] = [];

const fakeWindow = (globalThis as unknown as Record<string, unknown>).window as Record<string, unknown>;
(dom.document as unknown as Record<string, unknown>).addEventListener = (type: string, handler: (event: unknown) => void) =>
  void pageEvents.push({ type, handler });
fakeWindow.addEventListener = (type: string, handler: (event: unknown) => void) => void windowEvents.push({ type, handler });
fakeWindow.confirm = (message: string) => {
  asked.push(message);
  return answers.shift() ?? true;
};
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

const defaultCreated = (version: number) => `2026-01-0${version}T09:00:00Z`;
/** What the fake server writes for a version's `created_at`, so a test can hand over a nonsense one. */
let created = defaultCreated;

const meta = (name: string, version: number) => ({
  name,
  version,
  sha256: `${name}-${version}`,
  size: 64,
  created_at: created(version),
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
  toggle: {
    1: blockSource("toggle", decls("inputs", [["flag", "boolean"], ["payload", "json"]]), decls("outputs", [["done", "boolean"]])),
  },
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

interface StartBody {
  pipeline?: string;
  version?: number;
  yaml?: string;
  inputs?: Record<string, unknown>;
}

const calls: string[] = [];
const started: StartBody[] = [];
let storedYaml = PINNED;

/** What `POST /v1/pipelines/validate` answers. The editor's own checks are live as you type; this is
 *  the API's report on the bytes it was sent, which is the half of the problems list #21 is about. */
let validationReport: { valid: boolean; issues: { code: string; message: string; path?: string }[] } = {
  valid: true,
  issues: [],
};
const validated: string[] = [];

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
async function answer(href: string, init?: RequestInit): Promise<Response> {
  const path = new URL(href).pathname;
  calls.push(path);
  const parts = path.split("/").filter((part) => part !== "");
  if (parts[0] !== "v1") return json({ code: "not_found", message: `no route ${path}` }, 404);

  // The body is the point. The answer is a refusal because a started run would navigate to the run
  // page, which is another screen's business.
  if (init?.method === "POST" && parts[1] === "runs" && parts.length === 2) {
    started.push(JSON.parse(String(init.body)) as StartBody);
    return json({ code: "stub_refusal", message: "the stub records the request and starts nothing" }, 400);
  }

  if (parts[1] === "pipelines" && parts[2] === "word-report") {
    await pipelineGate.held;
    if (refusePipeline) return json({ code: "pipeline_not_found", message: `pipeline "word-report" has no versions` }, 404);
    if (parts.length === 3) return json({ name: "word-report", latest: 2, versions: [meta("word-report", 1), meta("word-report", 2)] });
    return json({ ...meta("word-report", parts[3] === "latest" ? 2 : Number(parts[3])), yaml: storedYaml, parsed: {} });
  }

  if (init?.method === "POST" && parts[1] === "pipelines" && parts[2] === "validate") {
    validated.push(String((JSON.parse(String(init.body)) as { yaml: string }).yaml));
    return json(validationReport);
  }

  // Any other name is one the store has never heard of, which is what the API says about it.
  if (parts[1] === "pipelines" && parts[2] !== undefined) {
    return json({ code: "pipeline_not_found", message: `pipeline "${parts[2]}" has no versions` }, 404);
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
(globalThis as unknown as Record<string, unknown>).fetch = (href: string | URL, init?: RequestInit) => answer(href.toString(), init);

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
  started.length = 0;
  validated.length = 0;
  blockGate = openGate();
  pipelineGate = openGate();
  refusePipeline = false;
  validationReport = { valid: true, issues: [] };
  tab.clear();
  pageEvents.length = 0;
  windowEvents.length = 0;
  asked.length = 0;
  answers = [];
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

/** The same screen at another address, for the routes this file does not open by default. */
async function openAt(path: string, signal: AbortSignal = new AbortController().signal): Promise<FakeElement> {
  calls.length = 0;
  session.identity = { name: "test", scope: "admin", admin: true };
  const view = dom.document.createElement("div");
  renderPipeline(
    view as unknown as HTMLElement,
    { path, parts: path.split("/").filter((part) => part !== ""), query: new URLSearchParams() },
    signal,
  );
  await settle();
  return view;
}

const stampOf = (view: FakeElement): string => view.querySelector(".ed__yaml .bar .stamp")?.textContent ?? "";
const openError = (view: FakeElement): FakeElement | undefined => view.querySelector('[id="open-error"]') ?? undefined;
const visibleHelp = (view: FakeElement): string[] => view.querySelectorAll(".help").filter((node) => !node.hidden).map((node) => node.textContent);

/** What the router would answer: a link in the chrome, seen first by whatever is watching. */
function clickLink(href: string): { prevented: boolean; stopped: boolean } {
  const link = dom.document.createElement("a");
  link.setAttribute("href", href);
  link.setAttribute("data-link", "");
  dom.document.body.append(link);
  let prevented = false;
  let stopped = false;
  const event = {
    target: link,
    preventDefault: () => void (prevented = true),
    stopImmediatePropagation: () => void (stopped = true),
  };
  for (const entry of pageEvents.filter((recorded) => recorded.type === "click")) entry.handler(event);
  return { prevented, stopped };
}

/** Whether the screen told the browser this tab has work in it. */
function unloadTold(): boolean {
  let told = false;
  for (const entry of windowEvents.filter((recorded) => recorded.type === "beforeunload")) {
    entry.handler({ preventDefault: () => void (told = true) });
  }
  return told;
}

function choose(view: FakeElement, id: string, value: string): void {
  const control = view.querySelector(`[id="${id}"]`)!;
  control.value = value;
  control.fire("change");
}

const button = (view: FakeElement, label: string): FakeElement | undefined =>
  view.querySelectorAll("button").find((node) => node.textContent === label);

describe("opening a stored pipeline", () => {
  test("fetches the blocks the document names", async () => {
    const view = await open(PINNED);
    // The first two are the screen asking once what the library holds, which it does not wait on. The
    // rest is the document: the list of versions, then the bytes, for each block it names.
    expect(calls).toEqual([
      "/v1/blocks",
      "/v1/pipelines",
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

// ---------- Start a run ----------

// What the Start dialog sends is what the API checks with the literal rule, so each value has to
// leave in the type its input declares. Nothing here looks at how a value reads.

const WITH_DEFAULTS = `name: with-defaults
description: Every type, each with a default.

inputs:
  title:
    type: string
    default: Report
  code:
    type: string
    default: "007"
  verbose:
    type: boolean
    default: false
  loud:
    type: boolean
    default: true
  config:
    type: json
    default:
      a: 1
      b: [1, 2]
  count:
    type: integer
    default: 3
  ratio:
    type: number
    default: 0.5

steps:
  generate:
    uses: generate-corpus@1
    with:
      lines: \${{ inputs.count }}
`;

const WITH_REQUIRED = `name: with-required
description: Inputs that have no default.

inputs:
  label:
    type: string
  limit:
    type: integer
  source:
    type: file

steps:
  generate:
    uses: generate-corpus@1
    with:
      lines: \${{ inputs.limit }}
`;

const status = (view: FakeElement): string => view.querySelector(".head__text .help")?.textContent ?? "";
const yamlOf = (view: FakeElement): string => view.querySelector('[id="doc"]')!.value;

/** Types into the YAML pane the way a person does: the textarea changes, then it says so. */
function typeYaml(view: FakeElement, next: string): void {
  const pane = view.querySelector('[id="doc"]')!;
  pane.value = next;
  pane.fire("input");
}

const startDialog = (view: FakeElement): FakeElement => view.querySelector('dialog[aria-labelledby="start-title"]')!;
const field = (view: FakeElement, name: string): FakeElement => startDialog(view).querySelector(`[id="start-in-${name}"]`)!;
const message = (view: FakeElement): string | null => {
  const box = startDialog(view).querySelector(".form-error");
  return box === null || box.hidden ? null : box.textContent;
};

/** Opens the dialog, lets `fill` set its fields, presses Start the run, and returns what was sent. */
async function startWith(view: FakeElement, fill: (set: (name: string, value: string | boolean) => void) => void = () => {}): Promise<StartBody | undefined> {
  button(view, "Start a run")!.fire("click");
  fill((name, value) => {
    const control = field(view, name);
    if (typeof value === "boolean") {
      control.checked = value;
      control.fire("change");
    } else {
      control.value = value;
      control.fire("input");
    }
  });
  startDialog(view).querySelector("form")!.fire("submit");
  await settle();
  return started.at(-1);
}

describe("what Start a run sends for each type", () => {
  test("a string that looks like a number leaves as a string", async () => {
    const view = await open(WITH_DEFAULTS);
    const sent = await startWith(view, (set) => set("title", "2024"));
    expect(sent?.inputs).toEqual({ title: "2024" });
  });

  test("a string default of 007 is shown as typed and runs as declared when nobody touches it", async () => {
    const view = await open(WITH_DEFAULTS);
    button(view, "Start a run")!.fire("click");
    expect(field(view, "code").value).toBe("007");
    const sent = await startWith(view);
    expect(sent?.inputs).toEqual({});
  });

  test("a string cleared on purpose is sent empty, not dropped", async () => {
    const view = await open(WITH_DEFAULTS);
    const sent = await startWith(view, (set) => set("title", ""));
    expect(sent?.inputs).toEqual({ title: "" });
  });

  test("a boolean is a checkbox and leaves as true or false", async () => {
    const view = await open(WITH_DEFAULTS);
    button(view, "Start a run")!.fire("click");
    expect(field(view, "verbose").getAttribute("type")).toBe("checkbox");
    expect(field(view, "verbose").checked).toBe(false);
    expect(field(view, "loud").checked).toBe(true);
    startDialog(view).querySelector("form")!.fire("submit");
    await settle();
    expect(started.at(-1)?.inputs).toEqual({});

    const flipped = await startWith(view, (set) => {
      set("verbose", true);
      set("loud", false);
    });
    expect(flipped?.inputs).toEqual({ verbose: true, loud: false });
  });

  test("a boolean put back to its default is not sent", async () => {
    const view = await open(WITH_DEFAULTS);
    const sent = await startWith(view, (set) => {
      set("verbose", true);
      set("verbose", false);
    });
    expect(sent?.inputs).toEqual({});
  });

  test("a json default is shown as JSON and runs untouched with its value intact", async () => {
    const view = await open(WITH_DEFAULTS);
    button(view, "Start a run")!.fire("click");
    expect(field(view, "config").tagName).toBe("TEXTAREA");
    expect(field(view, "config").value).toBe(JSON.stringify({ a: 1, b: [1, 2] }, null, 2));
    expect(field(view, "config").value).not.toContain("[object Object]");
    startDialog(view).querySelector("form")!.fire("submit");
    await settle();
    expect(started.at(-1)?.inputs).toEqual({});
  });

  test("an edited json field leaves parsed, in its own type", async () => {
    const view = await open(WITH_DEFAULTS);
    const sent = await startWith(view, (set) => set("config", '{"a": 2, "c": null}'));
    expect(sent?.inputs).toEqual({ config: { a: 2, c: null } });
  });

  test("invalid json is a message in the dialog and nothing is sent", async () => {
    const view = await open(WITH_DEFAULTS);
    const sent = await startWith(view, (set) => set("config", '{"a": '));
    expect(sent).toBeUndefined();
    expect(message(view)).toContain("config is JSON, and this is not");
    expect(startDialog(view).open).toBe(true);
  });

  test("numbers leave as numbers", async () => {
    const view = await open(WITH_DEFAULTS);
    const sent = await startWith(view, (set) => {
      set("count", "42");
      set("ratio", "2.5e1");
    });
    expect(sent?.inputs).toEqual({ count: 42, ratio: 25 });
  });

  test("a number that will not parse is a message in the dialog and nothing is sent", async () => {
    for (const [name, value] of [["count", "12abc"], ["count", "1.5"], ["count", ""], ["ratio", "abc"], ["ratio", "1,5"]] as const) {
      const view = await open(WITH_DEFAULTS);
      const sent = await startWith(view, (set) => set(name, value));
      expect(sent).toBeUndefined();
      expect(message(view)).toContain(`${name} is a`);
    }
  });

  test("a required input left empty is refused, and the message goes away once it is filled", async () => {
    const view = await open(WITH_REQUIRED);
    expect(await startWith(view)).toBeUndefined();
    expect(message(view)).toBe("label has no default, so this run needs a value for it.");

    const sent = await startWith(view, (set) => {
      set("label", "x");
      set("limit", "5");
      set("source", "/srv/in.csv");
    });
    expect(message(view)).toBeNull();
    expect(sent?.inputs).toEqual({ label: "x", limit: 5, source: "/srv/in.csv" });
  });

  test("a file says it wants an absolute path on the server, and a relative one is refused", async () => {
    const view = await open(WITH_REQUIRED);
    button(view, "Start a run")!.fire("click");
    const help = startDialog(view).querySelector('[id="start-in-source-help"]')!.textContent;
    expect(help).toContain("absolute path");
    expect(help).toContain("on the server");

    const sent = await startWith(view, (set) => {
      set("label", "x");
      set("limit", "5");
      set("source", "data/in.csv");
    });
    expect(sent).toBeUndefined();
    expect(message(view)).toContain("absolute path");
  });
});

// The dialog says which of two things it does, and the screen has to make that true: the stored
// version by name only when what is on screen is byte for byte that version, the YAML otherwise.

describe("what Start a run runs", () => {
  test("a stored pipeline nobody touched runs by name and version", async () => {
    const view = await open(PINNED);
    expect(status(view)).toBe("Stored as v2, unchanged.");
    button(view, "Start a run")!.fire("click");
    expect(startDialog(view).textContent).toContain("This starts the stored version you have open");
    const sent = await startWith(view);
    expect(sent).toEqual({ pipeline: "word-report", version: 2, inputs: {} });
  });

  test("typing in the YAML pane marks it unsaved at once, and Start runs the typed text", async () => {
    const view = await open(PINNED);
    const typed = PINNED.replace("default: 200", "default: 321");
    typeYaml(view, typed);
    expect(status(view)).toBe("Unsaved changes.");

    button(view, "Start a run")!.fire("click");
    expect(startDialog(view).textContent).toContain("These are unsaved changes");
    const sent = await startWith(view);
    expect(sent?.yaml).toBe(typed);
    expect(sent?.pipeline).toBeUndefined();
    expect(sent?.version).toBeUndefined();
  });

  test("retyping or undoing back to the stored bytes reads as unchanged and runs by name again", async () => {
    const view = await open(PINNED);
    typeYaml(view, `${PINNED}# one more line\n`);
    expect(status(view)).toBe("Unsaved changes.");
    typeYaml(view, PINNED);
    expect(status(view)).toBe("Stored as v2, unchanged.");
    const sent = await startWith(view);
    expect(sent).toEqual({ pipeline: "word-report", version: 2, inputs: {} });
  });

  test("a graph edit and its Undo end where they began", async () => {
    const view = await open(PINNED);
    button(view, "Remove step")!.fire("click");
    expect(status(view)).toBe("Unsaved changes.");
    expect(yamlOf(view)).not.toBe(PINNED);
    button(view, "Undo")!.fire("click");
    expect(yamlOf(view)).toBe(PINNED);
    expect(status(view)).toBe("Stored as v2, unchanged.");
  });

  test("YAML that does not parse is unsaved, not unchanged", async () => {
    const view = await open(PINNED);
    typeYaml(view, "name: [broken\n  steps: {");
    expect(status(view)).toBe("Unsaved changes.");
    expect(button(view, "Start a run")!.disabled).toBe(true);
  });
});

// ---------- the inspector's typed values ----------

const ONE_TOGGLE = `name: toggled
description: One step with a boolean and a json input typed in.

steps:
  flip:
    uses: toggle@1
    with:
      flag: true
      payload: [1, 2]
`;

const ONE_CHECK = `name: checked
description: One step with a string typed in.

steps:
  check:
    uses: check-corpus@1
    with:
      corpus: "007"
`;

const ONE_GENERATE = `name: generated
description: One step with an integer typed in.

steps:
  generate:
    uses: generate-corpus@1
    with:
      lines: 5
`;

/** Types into one of the inspector's own fields. */
function typeInto(view: FakeElement, id: string, value: string): void {
  const control = view.querySelector(`[id="${id}"]`)!;
  control.value = value;
  control.fire("input");
}

describe("a typed value in the inspector follows the input's declared type", () => {
  test("a string that looks like a number is written quoted, so it stays a string", async () => {
    const view = await open(ONE_CHECK);
    typeInto(view, "f-in-corpus-value", "2024");
    expect(yamlOf(view)).toContain('corpus: "2024"');
  });

  test("an integer is written as a number, and text that is not one is not written", async () => {
    const view = await open(ONE_GENERATE);
    typeInto(view, "f-in-lines-value", "7");
    expect(yamlOf(view)).toContain("lines: 7");
    typeInto(view, "f-in-lines-value", "7x");
    expect(yamlOf(view)).toContain("lines: 7");
    expect(view.querySelector(".wire-row .form-error")?.hidden).toBe(false);
    expect(view.querySelector(".wire-row .form-error")?.textContent).toContain("lines is an integer");
  });

  test("a boolean is a checkbox that writes true or false", async () => {
    const view = await open(ONE_TOGGLE);
    const box = view.querySelector('[id="f-in-flag-value"]')!;
    expect(box.getAttribute("type")).toBe("checkbox");
    expect(box.checked).toBe(true);
    box.checked = false;
    box.fire("change");
    expect(yamlOf(view)).toContain("flag: false");
  });

  test("json is edited as JSON; what the graph cannot write safely is refused", async () => {
    const view = await open(ONE_TOGGLE);
    expect(view.querySelector('[id="f-in-payload-value"]')!.value).toBe("[1,2]");
    typeInto(view, "f-in-payload-value", "[3, 4]");
    expect(yamlOf(view)).toContain("payload: [3, 4]");

    typeInto(view, "f-in-payload-value", '{"a": 1}');
    expect(yamlOf(view)).toContain("payload: [3, 4]");
    expect(view.querySelector(".wire-row .form-error")?.textContent).toContain("edit it in the YAML pane");

    typeInto(view, "f-in-payload-value", "{nope");
    expect(yamlOf(view)).toContain("payload: [3, 4]");
    expect(view.querySelector(".wire-row .form-error")?.textContent).toContain("payload is JSON, and this is not");
  });

  test("timeout stays a string and max attempts is a number", async () => {
    const view = await open(ONE_GENERATE);
    typeInto(view, "f-timeout", "90");
    typeInto(view, "f-attempts", "3");
    expect(yamlOf(view)).toContain('timeout: "90"');
    expect(yamlOf(view)).toContain("max_attempts: 3");
  });
});

// ---------- the API's report, which is about the bytes it was given (finding #21) ----------

/** What the API answers for a file input given a string. The editor's own checks never see it. */
const FILE_AS_TEXT = `name: stale-case
description: One step whose file input was given a string.

steps:
  a:
    uses: check-corpus@1
    with:
      corpus: not-a-file
`;

const FILE_REPORT = {
  valid: false,
  issues: [{ code: "type_mismatch", message: "a file value cannot be written in YAML", path: "steps.a.with.corpus" }],
};

describe("an API report that stops describing the text", () => {
  test("stops blocking the moment the line it named goes away", async () => {
    validationReport = FILE_REPORT;
    const view = await open(FILE_AS_TEXT);

    button(view, "Validate")!.fire("click");
    await settle();
    expect(stampOf(view)).toContain("1 problem");
    expect(view.querySelectorAll(".problems__list li").length).toBe(1);
    expect(button(view, "Save version")!.disabled).toBe(true);
    expect(button(view, "Start a run")!.disabled).toBe(true);
    expect(visibleHelp(view).some((line) => line.startsWith("Fix the problem"))).toBe(true);

    // The reader deletes the line the report was about. Nothing else should be asked of them.
    typeYaml(view, PINNED);
    await settle(); // the new document names a block the library had no reason to fetch yet
    expect(stampOf(view)).toBe("valid");
    expect(view.querySelectorAll(".problems__list li").length).toBe(0);
    expect(button(view, "Save version")!.disabled).toBe(false);
    expect(button(view, "Start a run")!.disabled).toBe(false);
    expect(visibleHelp(view).some((line) => line.startsWith("Fix the problem"))).toBe(false);
  });

  test("is still the report while the text it describes is on screen", async () => {
    validationReport = FILE_REPORT;
    const view = await open(FILE_AS_TEXT);
    button(view, "Validate")!.fire("click");
    await settle();
    expect(validated.length).toBe(1);
    expect(stampOf(view)).toContain("1 problem");
    // A re-render that changes nothing changes nothing: the report still stands.
    button(view, "Validate")!.fire("click");
    await settle();
    expect(stampOf(view)).toContain("1 problem");
  });
});

// ---------- the id Add step suggests (finding #23) ----------

const addDialog = (view: FakeElement): FakeElement => view.querySelector('dialog[aria-labelledby="add-title"]')!;
const suggestedId = (view: FakeElement): string => addDialog(view).querySelector('[id="add-id"]')!.value;

/** SPEC 1.1, the rule the API will apply to whatever the dialog offers. */
const STEP_ID_RULE = /^[a-z][a-z0-9_]{0,63}$/;

const ALREADY_SUGGESTED = `name: twice
description: A step already has the id the block name would suggest.

steps:
  check_corpus:
    uses: check-corpus@1
`;

describe("the step id Add step suggests", () => {
  test("turns the block name's hyphens into underscores, and passes the step id rule", async () => {
    const view = await open(PINNED);
    button(view, "Add step")!.fire("click");
    // The option carries the ref the step will be written with, so the version on offer is the
    // version that ends up in the file.
    expect(addDialog(view).querySelector('[id="add-uses"]')!.value).toBe("check-corpus@1");
    expect(suggestedId(view)).toBe("check_corpus");
    expect(STEP_ID_RULE.test(suggestedId(view))).toBe(true);

    addDialog(view).querySelector("form")!.fire("submit");
    await settle();
    expect(yamlOf(view)).toContain("  check_corpus:");
    // The step still has to be wired up, which is a problem of its own. What must not be there is a
    // complaint about the id the dialog chose.
    const problems = view.querySelectorAll(".problems__list li").map((row) => row.textContent);
    expect(problems.some((row) => row.includes("step id"))).toBe(false);
    expect(problems.some((row) => row.includes("check-corpus"))).toBe(false);
  });

  test("counts a step that already has the id with an underscore, not a hyphen", async () => {
    const view = await open(ALREADY_SUGGESTED);
    button(view, "Add step")!.fire("click");
    expect(suggestedId(view)).toBe("check_corpus_2");
    expect(STEP_ID_RULE.test(suggestedId(view))).toBe(true);
  });

  test("refuses a hyphen typed by hand, and writes nothing", async () => {
    const view = await open(PINNED);
    button(view, "Add step")!.fire("click");
    const id = addDialog(view).querySelector('[id="add-id"]')!;
    id.value = "check-corpus";
    id.fire("input");
    addDialog(view).querySelector("form")!.fire("submit");
    expect(addDialog(view).open).toBe(true);
    expect(addDialog(view).querySelector(".form-error")!.hidden).toBe(false);
    expect(yamlOf(view)).not.toContain("check-corpus:");
  });
});

// ---------- leaving with work in progress (finding #24) ----------

const MY_EDIT = `${PINNED}# my edit\n`;

describe("leaving with unsaved changes", () => {
  test("asks before a link takes the reader away, and stays when the answer is no", async () => {
    const view = await open(PINNED);
    typeYaml(view, MY_EDIT);
    answers = [false];

    const outcome = clickLink("/app/runs");
    expect(asked.length).toBe(1);
    expect(outcome.prevented).toBe(true);
    expect(outcome.stopped).toBe(true);
  });

  test("hands the click to the router when the answer is yes", async () => {
    const view = await open(PINNED);
    typeYaml(view, MY_EDIT);
    answers = [true];

    const outcome = clickLink("/app/runs");
    expect(asked.length).toBe(1);
    expect(outcome.prevented).toBe(false);
    expect(outcome.stopped).toBe(false);
  });

  test("says nothing when the document is the record", async () => {
    await open(PINNED);
    expect(clickLink("/app/runs").prevented).toBe(false);
    expect(asked.length).toBe(0);
  });

  test("tells the browser the tab has work in it, and stops when it does not", async () => {
    const view = await open(PINNED);
    expect(unloadTold()).toBe(false);
    typeYaml(view, MY_EDIT);
    expect(unloadTold()).toBe(true);
    typeYaml(view, PINNED);
    expect(unloadTold()).toBe(false);
  });

  test("keeps the work in the tab, so coming back brings it back", async () => {
    const leaving = new AbortController();
    const view = await open(PINNED, leaving.signal);
    typeYaml(view, MY_EDIT);
    expect(status(view)).toBe("Unsaved changes.");

    leaving.abort(); // what the router does to a screen on its way out
    const back = await open(PINNED);
    expect(yamlOf(back)).toBe(MY_EDIT);
    expect(status(back)).toContain("Unsaved changes");
  });

  test("keeps one document's work off another, and forgets it once it is stored", async () => {
    const view = await open(PINNED);
    typeYaml(view, MY_EDIT);

    button(view, "Discard changes")!.fire("click");
    expect(yamlOf(view)).toBe(PINNED);
    expect(status(view)).toBe("Stored as v2, unchanged.");
    // Gone from the tab too: a fresh screen opens the record, not the draft that was.
    expect(yamlOf(await open(PINNED))).toBe(PINNED);
  });
});

// ---------- what the line under the title claims (finding #31, the editor half) ----------

const BLANK_TEMPLATE = "name: new-pipeline\ndescription: What this pipeline does.\n\nsteps:\n";

describe("the line under the title", () => {
  test("does not call a blank editor unsaved, before or after New pipeline", async () => {
    const view = await openAt("/pipeline");
    expect(yamlOf(view)).toBe(BLANK_TEMPLATE);
    expect(status(view)).toBe("Not stored yet.");
    button(view, "New pipeline")!.fire("click");
    expect(status(view)).toBe("Not stored yet.");

    typeYaml(view, `${BLANK_TEMPLATE}# one step to go\n`);
    expect(status(view)).toBe("Unsaved changes.");
  });
});

// ---------- a failed open (finding #32) ----------

describe("a failed open", () => {
  test("is one line beside the field that caused it, and the next attempt replaces it", async () => {
    const view = await openAt("/pipeline");
    const nameInput = view.querySelector('[id="open-name"]')!;
    nameInput.value = "nope";
    for (let attempt = 0; attempt < 3; attempt++) {
      button(view, "Open")!.fire("click");
      await settle();
    }

    expect(view.querySelectorAll('[id="open-error"]').length).toBe(1);
    expect(view.querySelectorAll(".state--error").length).toBe(0);
    const slot = openError(view)!;
    expect(slot.hidden).toBe(false);
    expect(slot.textContent).toContain("pipeline_not_found");
    expect(slot.textContent).toContain("nope");

    nameInput.value = "word-report";
    button(view, "Open")!.fire("click");
    await settle();
    expect(openError(view)!.hidden).toBe(true);
    expect(status(view)).toBe("Stored as v2, unchanged.");
  });
});

// ---------- the version in the address bar (finding #35) ----------

/** What the router does to the address bar, which the test DOM cannot show on its own. */
function watchAddress(): { urls: string[]; stop: () => void } {
  const urls: string[] = [];
  const real = globalThis.history;
  (globalThis as unknown as Record<string, unknown>).history = {
    pushState: () => {},
    replaceState: (_data: unknown, _title: string, url?: string | null) => void urls.push(String(url)),
  };
  return { urls, stop: () => void ((globalThis as unknown as Record<string, unknown>).history = real) };
}

describe("the version in the address bar", () => {
  test("follows the version that was picked", async () => {
    const address = watchAddress();
    try {
      const view = await open(PINNED);
      expect(view.querySelector('[id="open-version"]')!.value).toBe("2");
      choose(view, "open-version", "1");
      await settle();
      expect(address.urls).toContain("/app/pipeline/word-report/1");
    } finally {
      address.stop();
    }
  });

  test("does not move over unsaved work without asking", async () => {
    const address = watchAddress();
    try {
      const view = await open(PINNED);
      typeYaml(view, MY_EDIT);
      answers = [false];
      choose(view, "open-version", "1");
      expect(asked.length).toBe(1);
      expect(address.urls).toEqual([]);
      expect(view.querySelector('[id="open-version"]')!.value).toBe("2");
    } finally {
      address.stop();
    }
  });

  test("opens the version the route names", async () => {
    await openAt("/pipeline/word-report/1");
    expect(calls).toContain("/v1/pipelines/word-report/1");
  });

  test("says there is no such version, instead of asking the API for NaN", async () => {
    const view = await openAt("/pipeline/word-report/abc");
    // Nothing asked the API for a version of the document; the library's own lists are not the document.
    expect(calls.filter((call) => call.startsWith("/v1/pipelines/"))).toEqual([]);
    expect(view.querySelectorAll(".state--error").length).toBe(0);
    expect(openError(view)!.hidden).toBe(false);
    expect(openError(view)!.textContent).toContain("no version");
    expect(openError(view)!.textContent).toContain("abc");
  });
});

// ---------- the clock the version list is written in (finding #49) ----------

describe("the time a stored version was written", () => {
  test("is the reader's own clock, with the exact instant kept on the option", async () => {
    const view = await open(PINNED);
    const option = view
      .querySelector('[id="open-version"]')!
      .children.find((node) => node.value === "1")!;

    // Printed in the zone the browser is already in, and never stamped "UTC" in a box of times that
    // are not: the pipeline screen used to name a third clock next to the run's two. To the second,
    // because two saves either side of a fix are a breath apart and minutes cannot tell them apart.
    expect(option.textContent).toMatch(/^v1, \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(option.textContent).not.toMatch(/UTC|GMT|Z$/);
    // The instant the server actually said, for anyone who wants the exact one rather than the local
    // one. No browser shows a tooltip on an `<option>`, so it is in the label a screen reader reads too.
    expect(option.getAttribute("title")).toBe("stored 2026-01-01T09:00:00Z");
    expect(option.getAttribute("aria-label")).toBe(`${option.textContent}, stored 2026-01-01T09:00:00Z`);
  });

  test("a version whose time cannot be read is named on its own rather than with an empty time", async () => {
    created = () => "not a time at all";
    try {
      const view = await open(PINNED);
      const option = view
        .querySelector('[id="open-version"]')!
        .children.find((node) => node.value === "1")!;

      // "v1, " with nothing after the comma reads as a control that lost its text, and echoing the
      // string back would dress a wrong time up as a right one.
      expect(option.textContent).toBe("v1");
      expect(option.getAttribute("title")).toBeNull();
    } finally {
      created = defaultCreated;
    }
  });
});
