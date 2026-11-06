// The run screen stamps a step with the word the engine wrote into `run.json`, and it used to know
// four of them. A `skipped` step — final, and with a note underneath saying why it never started —
// came back stamped `pending`, which is a lie about a step that is never going to run. So: every
// status in SPEC 4.4 gets its own word and its own sign, and only a status this UI has genuinely
// never seen falls back.
//
// The modules come from the bytes the server serves, as in client/logs.test.ts, and they are written
// to a directory of their own so their `./dom.js`, `./api.js` and `./logs.js` specifiers resolve.
// `./app.js` is the one module this file writes itself: the real shell starts rendering the moment it
// is imported, and runs.ts only reaches for it to navigate from the run-jump box, which is not what is
// under test here. The DOM stand-in lives in this file too, because Bun has no browser.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAssets } from "../assets.ts";
import type { Attempt, Run, RunStep } from "./api.ts";
import type { State as DomState } from "./dom.ts";

// ---------- the stand-in DOM ----------

/**
 * Enough of a DOM for dom.ts and runs.ts to build a run screen: elements, attributes, text, and the
 * few properties the log pane reads while it scrolls. It is a stand-in and not a browser — nothing is
 * laid out, and no handler is ever fired — which is enough to answer what is asked here: what word and
 * what shape ended up in each stamp.
 */
class FakeElement {
  readonly tagName: string;
  readonly attrs = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  value = "";
  hidden = false;
  disabled = false;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  offsetWidth = 0;
  private text = "";
  private classes = new Set<string>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get classList(): { add(name: string): void; remove(name: string): void; contains(name: string): boolean } {
    return {
      add: (name) => void this.classes.add(name),
      remove: (name) => void this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
  }

  get className(): string {
    return [...this.classes].join(" ");
  }

  set className(value: string) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }

  setAttribute(name: string, value: string): void {
    if (name === "class") {
      this.className = String(value);
      return;
    }
    this.attrs.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return name === "class" ? this.className : (this.attrs.get(name) ?? null);
  }

  addEventListener(): void {
    // The handlers are wired but never fired: nothing here clicks Follow or scrolls the log.
  }

  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      if (typeof node === "string") {
        this.text += node;
        continue;
      }
      node.parent?.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = this;
      this.children.push(node);
    }
  }

  remove(): void {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  replaceChildren(...nodes: (FakeElement | string)[]): void {
    for (const child of this.children) child.parent = null;
    this.children.length = 0;
    this.text = "";
    this.append(...nodes);
  }

  set textContent(value: string) {
    this.replaceChildren(value);
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  *descendants(): Generator<FakeElement> {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  /** The selectors used here: tags, `.class`, `[attr="value"]`, and descendant spaces. Nothing else. */
  querySelectorAll(selector: string): FakeElement[] {
    const parts = selector.trim().split(/\s+/).map(parseCompound);
    const last = parts[parts.length - 1]!;
    const out: FakeElement[] = [];
    for (const node of this.descendants()) {
      if (!matches(node, last)) continue;
      let at: FakeElement | null = node.parent;
      let rest = parts.length - 2;
      while (rest >= 0 && at !== null) {
        if (matches(at, parts[rest]!)) rest--;
        at = at.parent;
      }
      if (rest < 0) out.push(node);
    }
    return out;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  focus(): void {}
}

interface Compound {
  tag: string | null;
  classes: string[];
  attrs: { name: string; value: string | null }[];
}

function parseCompound(source: string): Compound {
  const out: Compound = { tag: null, classes: [], attrs: [] };
  let rest = source;
  while (rest !== "") {
    const cls = /^\.[\w-]+/.exec(rest);
    if (cls !== null) {
      out.classes.push(cls[0].slice(1));
      rest = rest.slice(cls[0].length);
      continue;
    }
    const attr = /^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/.exec(rest);
    if (attr !== null) {
      out.attrs.push({ name: attr[1]!, value: attr[2] ?? null });
      rest = rest.slice(attr[0].length);
      continue;
    }
    const tag = /^[\w-]+/.exec(rest);
    if (tag !== null) {
      out.tag = tag[0].toUpperCase();
      rest = rest.slice(tag[0].length);
      continue;
    }
    throw new Error(`the test DOM cannot parse "${rest}"`);
  }
  return out;
}

function matches(node: FakeElement, compound: Compound): boolean {
  if (compound.tag !== null && node.tagName !== compound.tag) return false;
  for (const name of compound.classes) if (!node.classList.contains(name)) return false;
  for (const attr of compound.attrs) {
    const have = node.getAttribute(attr.name);
    if (have === null || (attr.value !== null && have !== attr.value)) return false;
  }
  return true;
}

const storage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
};

const fakeDocument = {
  body: new FakeElement("body"),
  title: "",
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_namespace: string, tag: string) => new FakeElement(tag),
  getElementById(id: string) {
    return this.body.querySelector(`[id="${id}"]`);
  },
  addEventListener(): void {},
};

const globals = globalThis as unknown as Record<string, unknown>;
const installed = {
  document: globals.document,
  window: globals.window,
  location: globals.location,
  localStorage: globals.localStorage,
  sessionStorage: globals.sessionStorage,
  CSS: globals.CSS,
  requestAnimationFrame: globals.requestAnimationFrame,
  fetch: globals.fetch,
};

globals.document = fakeDocument;
globals.window = { setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args), clearTimeout };
globals.location = { origin: "http://runs.test", href: "http://runs.test/app/runs" };
globals.localStorage = storage();
globals.sessionStorage = storage();
globals.CSS = { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) };
globals.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);

// ---------- the modules the browser runs, and the server it talks to ----------

const served = mkdtempSync(join(tmpdir(), "bashreactor-runs-"));
for (const name of ["dom", "api", "logs", "runs"]) {
  writeFileSync(join(served, `${name}.js`), buildAssets().files.get(`assets/${name}.js`)!.data);
}
writeFileSync(join(served, "app.js"), "export function navigate() {}\n");

const { sign } = (await import(join(served, "dom.js"))) as typeof import("./dom.ts");
const { MAX_DRAWN_LINES } = (await import(join(served, "logs.js"))) as typeof import("./logs.ts");
const { renderRuns } = (await import(join(served, "runs.js"))) as typeof import("./runs.ts");

const controllers: AbortController[] = [];

/** One run, and an empty log for whichever attempt the pane asks for. Nothing else is answered. */
function serve(run: Run): void {
  globals.fetch = (async (href: string) => {
    const url = String(href);
    const body = url.includes("/logs/")
      ? { run: run.id, step: "", attempt: 1, offset: 0, next_offset: 0, text: "", truncated: false }
      : run;
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
}

/** One run, and a log served by byte offset in chunks of `chunkBytes`, the way the API cuts it. */
function serveLog(run: Run, log: string, chunkBytes: number): void {
  const bytes = new TextEncoder().encode(log);
  globals.fetch = (async (href: string) => {
    const url = new URL(String(href), "http://runs.test");
    let body: unknown = run;
    if (url.pathname.includes("/logs/")) {
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const piece = bytes.slice(offset, offset + chunkBytes);
      body = {
        run: run.id,
        step: "",
        attempt: 1,
        offset,
        next_offset: offset + piece.length,
        text: new TextDecoder().decode(piece),
        truncated: offset + piece.length < bytes.length,
      };
    }
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
}

/** Renders one run the way the router does. `renderRuns` is fire and forget, so this waits for it. */
async function render(run: Run, serving: () => void = () => serve(run), keepOpen = false): Promise<FakeElement> {
  const view = new FakeElement("div");
  const controller = new AbortController();
  controllers.push(controller);
  serving();
  renderRuns(
    view as unknown as HTMLElement,
    { path: `/runs/${run.id}`, parts: ["runs", run.id], query: new URLSearchParams() },
    controller.signal,
  );
  for (let turn = 0; turn < 50; turn++) {
    const rows = view.querySelectorAll(".steprow");
    if (rows.length > 0 && rows.every((row) => row.querySelector(".steprow__stamp")?.textContent !== "")) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  // A log read that is still going when the pane is aborted is dropped, so the log tests leave it open.
  if (!keepOpen) controller.abort();
  return view;
}

afterAll(() => {
  for (const controller of controllers) controller.abort();
  for (const [name, value] of Object.entries(installed)) {
    if (value === undefined) delete globals[name];
    else globals[name] = value;
  }
  rmSync(served, { recursive: true, force: true });
});

// ---------- the runs on screen ----------

const T0 = "2026-11-04T10:15:00Z";
const T1 = "2026-11-04T10:15:41Z";

function attempt(n: number, status: string): Attempt {
  return {
    n,
    status,
    pid: 4000 + n,
    pid_start: 91_000 + n,
    started_at: T0,
    finished_at: status === "running" ? null : T1,
    exit_code: status === "succeeded" ? 0 : null,
    signal: null,
    failure: null,
  };
}

/** A step in one status, with an attempt only if that status means the step ever started. */
function step(id: string, status: string, needs: string[] = []): RunStep {
  const started = status !== "pending" && status !== "skipped";
  return {
    id,
    name: id,
    status,
    block: { uses: `${id}@1`, name: id, sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
    needs,
    with: null,
    outputs: status === "succeeded" ? { report: "out/report.html" } : null,
    failure: status === "failed" ? { code: "exit_nonzero", message: "the script exited 1" } : null,
    attempts_used: started ? 1 : 0,
    next_attempt_at: status === "waiting_retry" ? T1 : null,
    attempts: started ? [attempt(1, status)] : [],
  };
}

function runFixture(steps: RunStep[], status: string): Run {
  return {
    schema: 1,
    id: "20261104T101500Z-3fa9c2d1",
    pipeline: "word-report",
    status,
    created_at: T0,
    finished_at: status === "running" ? null : T1,
    cancel_requested_at: null,
    inputs: { lines: 200 },
    outputs: null,
    steps: Object.fromEntries(steps.map((entry) => [entry.id, entry])),
  };
}

/** The run from the bug report: `render` failed, so `report` never started. */
const FAILED_RUN = runFixture(
  [step("fetch", "succeeded"), step("render", "failed", ["fetch"]), step("report", "skipped", ["render"])],
  "failed",
);

/** Not a run that happened: one step per status, so all of them are on screen at once. */
const EVERY_STATUS = runFixture(
  ["pending", "running", "waiting_retry", "succeeded", "failed", "skipped", "cancelled", "interrupted"].map((status) =>
    step(status, status),
  ),
  "running",
);

/** The word a stamp prints, and the shape it prints beside it. */
const word = (stamp: FakeElement): string => stamp.textContent.trim();
const shape = (node: FakeElement): string => node.querySelector("svg path")?.getAttribute("d") ?? "";
const signOf = (state: DomState): string => shape(sign(state) as unknown as FakeElement);

/** Fails loudly rather than letting a row that was never drawn read as an empty stamp. */
function one(node: FakeElement | null, what: string): FakeElement {
  if (node === null) throw new Error(`the run screen drew no ${what}`);
  return node;
}

const rowOf = (view: FakeElement, stepId: string): FakeElement =>
  one(view.querySelector(`[data-step="${stepId}"]`), `row for ${stepId}`);
const stampOf = (view: FakeElement, stepId: string): FakeElement =>
  one(rowOf(view, stepId).querySelector(".steprow__stamp"), `stamp for ${stepId}`);

// ---------- what it proves ----------

describe("stamping a step", () => {
  test("a skipped step is stamped skipped, with the skipped sign", async () => {
    const view = await render(FAILED_RUN);
    const stamp = stampOf(view, "report");

    expect(word(stamp)).toBe("skipped");
    expect(word(stamp)).not.toBe("pending");
    expect(shape(stamp)).toBe(signOf("skipped"));
    expect(shape(stamp)).not.toBe(signOf("pending"));

    // The note is still the reason, which is the half that was never wrong.
    expect(rowOf(view, "report").querySelector(".steprow__note")?.textContent).toBe(
      "render failed, so this never started.",
    );
    // And the steps that were always stamped right still are.
    expect(word(stampOf(view, "fetch"))).toBe("succeeded");
    expect(word(stampOf(view, "render"))).toBe("failed");
  });

  test("every status the spec allows gets its own word and its own sign", async () => {
    const view = await render(EVERY_STATUS);

    const drawn = new Map<string, string>();
    // In this fixture the step id is its status, so one name does for both.
    for (const status of Object.keys(EVERY_STATUS.steps)) {
      const stamp = stampOf(view, status);
      expect(word(stamp)).toBe(status);
      expect(word(stamp)).not.toBe("");
      expect(shape(stamp)).not.toBe("");
      drawn.set(status, shape(stamp));
    }

    // Eight statuses, eight shapes: nothing is sharing pending's empty box any more.
    expect(drawn.size).toBe(Object.keys(EVERY_STATUS.steps).length);
    expect(new Set(drawn.values()).size).toBe(drawn.size);
    expect(drawn.get("pending")).toBe(signOf("pending"));
    for (const [status, shapeOf] of drawn) if (status !== "pending") expect(shapeOf).not.toBe(signOf("pending"));
  });

  test("the run's own status is stamped the same way", async () => {
    const view = await render(FAILED_RUN);
    const head = one(view.querySelector(".runhead__meta"), "run head");
    expect(word(one(head.querySelector(".stamp"), "head stamp"))).toBe("failed");
  });
});

/** The pane stops polling for a finished run, so whatever it reads at the start is all it will ever read. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 200; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("a log longer than one read", () => {
  const FINISHED = runFixture([step("render", "succeeded")], "succeeded");

  test("reads on until the server stops truncating, and ends on the last line", async () => {
    const lines = Array.from({ length: 600 }, (_, n) => `line ${n}`);
    const log = `${lines.join("\n")}\nEND\n`;
    const view = await render(FINISHED, () => serveLog(FINISHED, log, 1000), true);
    await settle();

    const drawn = view.querySelectorAll(".log__text");
    expect(drawn.at(-1)?.textContent).toBe("END");
    expect(drawn.length).toBe(601);
    expect(view.querySelector("[id=log-note]")?.hidden).toBe(true);
    expect(view.querySelector("[id=log-status]")?.textContent).toBe(`Read to byte ${new TextEncoder().encode(log).length}.`);
  });

  test("a line cut by a chunk boundary is whole once the rest arrives", async () => {
    const log = `${"x".repeat(2500)}\nEND\n`;
    const view = await render(FINISHED, () => serveLog(FINISHED, log, 1000), true);
    await settle();

    const drawn = view.querySelectorAll(".log__text");
    expect(drawn.map((node) => node.textContent.length)).toEqual([2500, 3]);
    expect(drawn.at(-1)?.textContent).toBe("END");
  });

  test("past the drawing cap it keeps the end and says how much it left out", async () => {
    const total = MAX_DRAWN_LINES + 700;
    const log = `${Array.from({ length: total }, (_, n) => `line ${n}`).join("\n")}\nEND\n`;
    const view = await render(FINISHED, () => serveLog(FINISHED, log, 4000), true);
    await settle();

    const drawn = view.querySelectorAll(".log__text");
    expect(drawn.length).toBe(MAX_DRAWN_LINES);
    expect(drawn.at(-1)?.textContent).toBe("END");
    const note = one(view.querySelector("[id=log-note]"), "cap note");
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain(`The first ${total + 1 - MAX_DRAWN_LINES} lines`);
    expect(note.textContent).toContain("are not drawn");
  });
});

describe("a status this UI has never seen", () => {
  test("falls back to pending rather than printing a word with no shape", async () => {
    const view = await render(runFixture([step("fetch", "approved", [])], "approved"));
    const stamp = stampOf(view, "fetch");

    // `stateStamp` prints the word it is given and `sign` has no art for a name it does not know, so
    // passing an unknown status through would pair a word with the wrong shape. `pending` claims
    // nothing about the outcome and is not final, so it cannot call a live run finished.
    expect(word(stamp)).toBe("pending");
    expect(shape(stamp)).toBe(signOf("pending"));
    const head = one(view.querySelector(".runhead__meta"), "run head");
    expect(word(one(head.querySelector(".stamp"), "head stamp"))).toBe("pending");
  });

  test("interrupted is a word the screen knows, even though the spec keeps it to attempts", async () => {
    const view = await render(runFixture([step("render", "interrupted")], "interrupted"));
    expect(word(stampOf(view, "render"))).toBe("interrupted");
    expect(shape(stampOf(view, "render"))).toBe(signOf("interrupted"));
  });
});
