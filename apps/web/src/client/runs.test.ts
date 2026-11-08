// The run screen is the page a person watches while their work runs, and it used to say things that
// were not true. A step stamped `pending` when the engine had written `skipped` into `run.json`; a
// refusal that vanished before the frame was painted; a status line still reporting the byte offset
// of the step you had just left; a server that had died and was not mentioned. So: every status in
// SPEC 4.4 gets its own word and its own sign, an action the server refuses keeps its own words on
// the page until they are dismissed, the controls are built once and updated in place, and the line
// under the log says where the cursor really is and when there is no server to read it from.
//
// The modules come from the bytes the server serves, as in client/logs.test.ts, and they are written
// to a directory of their own so their `./dom.js`, `./api.js` and `./logs.js` specifiers resolve.
// `./app.js` is the one module this file writes itself: the real shell starts rendering the moment it
// is imported, and runs.ts only reaches for it to navigate from the run-jump box, which is not what is
// under test here. The DOM stand-in lives in this file too, because Bun has no browser: it takes
// clicks, it holds focus, and — the part that matters for a screen that redraws itself every second —
// it drops focus to the body when the focused node is thrown away, so a rebuild cannot pass unnoticed.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAssets } from "../assets.ts";
import type { Attempt, Run, RunStep, RunSummary } from "./api.ts";
import type { Clock } from "./runs.ts";
import type { State as DomState } from "./dom.ts";

// ---------- the stand-in DOM ----------

/**
 * Enough of a DOM for dom.ts and runs.ts to build a run screen: elements, attributes, text, the few
 * properties the log pane reads while it scrolls, and the click a test needs to press a button. It is
 * a stand-in and not a browser — nothing is laid out — but it does lose focus the way a browser does
 * when the focused node is thrown away, because half of what is tested here is a rebuild.
 */
class FakeElement {
  readonly tagName: string;
  readonly attrs = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, ((event: FakeEvent) => void)[]>();
  parent: FakeElement | null = null;
  value = "";
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  offsetWidth = 0;
  private text = "";
  private classes = new Set<string>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  /** `hidden` and `disabled` are attributes that read as properties, in a browser and in dom.ts. */
  private flag(name: string): boolean {
    return this.attrs.has(name);
  }

  private setFlag(name: string, on: boolean): void {
    if (on) this.attrs.set(name, "");
    else this.attrs.delete(name);
  }

  get hidden(): boolean {
    return this.flag("hidden");
  }

  set hidden(value: boolean) {
    this.setFlag("hidden", value);
  }

  /** `title` is an attribute that reads as a property, and it is where the exact instant lives. */
  get title(): string {
    return this.attrs.get("title") ?? "";
  }

  set title(value: string) {
    this.attrs.set("title", value);
  }

  get disabled(): boolean {
    return this.flag("disabled");
  }

  set disabled(value: boolean) {
    this.setFlag("disabled", value);
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

  addEventListener(type: string, handler: (event: FakeEvent) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  /** Press it. `el` wired the handlers with `on…` attributes, so a click is all a test has to do. */
  dispatchEvent(type: string, extra: Record<string, unknown> = {}): void {
    const event: FakeEvent = { type, target: this, currentTarget: this, preventDefault: () => {}, ...extra };
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  /** What a browser calls when something is pressed, and what `save()` calls on the anchor it makes. */
  click(): void {
    this.dispatchEvent("click");
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
    loseFocusIf(this);
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }

  /**
   * Put `node` before `ref`, or at the end when `ref` is null. A live list moves its rows to the order
   * the server just said rather than rebuilding them, and this is the only way to do that.
   */
  insertBefore(node: FakeElement, ref: FakeElement | null): void {
    node.parent?.children.splice(node.parent.children.indexOf(node), 1);
    const at = ref === null ? this.children.length : this.children.indexOf(ref);
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
    node.parent = this;
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  replaceChildren(...nodes: (FakeElement | string)[]): void {
    for (const child of this.children) {
      loseFocusIf(child);
      child.parent = null;
    }
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

  /** A dialog is opened and closed by the cancel box; nothing here is drawn, so nothing has to happen. */
  showModal(): void {}

  close(): void {}

  focus(): void {
    setFocus(this);
  }
}

/** What a handler gets: enough of an Event for the two handlers on this screen. */
interface FakeEvent {
  type: string;
  target: FakeElement;
  currentTarget: FakeElement;
  preventDefault(): void;
  [extra: string]: unknown;
}

let activeElement: FakeElement | null = null;

function setFocus(node: FakeElement): void {
  activeElement = node;
}

/**
 * A browser drops focus to the body when the element holding it is taken out of the page, and that is
 * the whole of one bug here, so the stand-in has to drop it too or every rebuild passes unnoticed.
 */
function loseFocusIf(node: FakeElement): void {
  if (activeElement === null) return;
  for (let at: FakeElement | null = activeElement; at !== null; at = at.parent) {
    if (at === node) {
      activeElement = null;
      return;
    }
  }
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
  /** Whether the tab is in the background. Neither live view reads while it is. */
  hidden: false,
  get activeElement(): FakeElement {
    return activeElement ?? this.body;
  },
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_namespace: string, tag: string) => new FakeElement(tag),
  getElementById(id: string) {
    return this.body.querySelector(`[id="${id}"]`);
  },
  addEventListener(_type: string, handler: () => void): void {
    visibilityHandlers.push(handler);
  },
  removeEventListener(_type: string, handler: () => void): void {
    const at = visibilityHandlers.indexOf(handler);
    if (at >= 0) visibilityHandlers.splice(at, 1);
  },
};

const visibilityHandlers: (() => void)[] = [];

/** Switch tabs the way the browser does: a live view stops reading, or starts again. */
function showTab(hidden: boolean): void {
  if (fakeDocument.hidden === hidden) return;
  fakeDocument.hidden = hidden;
  // Walking a copy: a handler can take itself off the list in the middle of the switch.
  for (const handler of visibilityHandlers.slice()) handler();
}

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

// Bun has no browser, so it has no object URLs. `save()` needs two: it turns the bytes it fetched into
// one and clicks an anchor at it. Recording what came back is how the download tests know a click
// really went to the API and came back as a file, rather than just navigating somewhere.
const savedFiles: { name: string; url: string }[] = [];
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
URL.createObjectURL = ((blob: Blob) => `blob:${blob.size}`) as typeof URL.createObjectURL;
URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
fakeDocument.createElement = (tag: string) => {
  const node = new FakeElement(tag);
  if (tag === "a") {
    const anchor = node as unknown as { download: string; href: string; click: () => void };
    anchor.click = () => void savedFiles.push({ name: anchor.download, url: anchor.href });
  }
  return node;
};

// ---------- the modules the browser runs, and the server it talks to ----------

const served = mkdtempSync(join(tmpdir(), "bashreactor-runs-"));
for (const name of ["dom", "api", "logs", "runs"]) {
  writeFileSync(join(served, `${name}.js`), buildAssets().files.get(`assets/${name}.js`)!.data);
}
writeFileSync(join(served, "app.js"), "export function navigate() {}\n");

const { sign, when, isoInstant, duration } = (await import(join(served, "dom.js"))) as typeof import("./dom.ts");
const { session } = (await import(join(served, "api.js"))) as typeof import("./api.ts");
const { MAX_DRAWN_LINES } = (await import(join(served, "logs.js"))) as typeof import("./logs.ts");
const { renderRuns, POLL_MS, IDLE_POLL_MS } = (await import(join(served, "runs.js"))) as typeof import("./runs.ts");

// Most of what is tested here is a button, and a read-only token is never offered one.
session.identity = { name: "tester", scope: "write", admin: false };

const controllers: AbortController[] = [];
/** Undo anything a test put on the globals, so the next file gets the ones it came with. */
const cleanups: (() => void)[] = [];

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
  for (const stop of cleanups) stop();
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
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

// ---------- a server you can talk back to ----------

/** What the stand-in hands back in place of a `Response`. */
interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  blob: () => Promise<Blob>;
  headers: { get: (name: string) => string | null };
  /** The real Response has one, and `errorOf` reads through it so the caller keeps a body of its own. */
  clone: () => FakeResponse;
}

const reply = (body: unknown, status = 200): FakeResponse => {
  // Reading a fake never uses the body up, so a clone of it is the same answer again.
  const response: FakeResponse = {
    ok: status < 400,
    status,
    json: async () => body,
    blob: async () => new Blob([JSON.stringify(body)]),
    headers: { get: () => null },
    clone: () => response,
  };
  return response;
};

/**
 * A download: bytes and a filename, and a `json()` that refuses, so a page that tried to read a
 * tarball as JSON finds out rather than being handed a lie.
 */
const replyBytes = (text: string, filename: string): FakeResponse => {
  const response: FakeResponse = {
    ok: true,
    status: 200,
    json: async (): Promise<unknown> => {
      throw new TypeError("this is a file, not JSON");
    },
    blob: async () => new Blob([text]),
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-disposition" ? `attachment; filename="${filename}"` : null,
    },
    clone: () => response,
  };
  return response;
};

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/**
 * The server this page talks to: one run, its logs by byte offset, and the actions. A route is
 * `METHOD /path`, and anything nobody asked for answers 500 with an error object, so a page that
 * reads somewhere unexpected fails loudly instead of reading a hole.
 */
class FakeServer {
  /** The run this server answers with; a test swaps it to watch a run reach its end. */
  run: Run;
  /** Log bytes, keyed by step id, or by `step/attempt` when the attempts differ. */
  logs: Record<string, string> = {};
  /** How many bytes one answer holds, which is how a log takes more than one read. */
  chunkBytes = 1_000_000;
  /** Real milliseconds an answer takes, so a test can look at the page in the middle of a read. */
  logDelayMs = 0;
  /**
   * What the manifest route answers (SPEC 4.10). Left null so a run with nothing listed reads as a
   * 404, which is what a server that has no files for a run says, and what the page has to survive.
   */
  files: unknown | null = null;
  /**
   * Downloadable bytes, keyed by the `?path=` a file route is asked for, plus `archive` for the whole
   * run. A path nobody gave bytes for answers 404, the way the API answers a path that is not there.
   */
  downloads: Record<string, string> = {};
  readonly asked: string[] = [];
  private dead = false;
  private routes = new Map<string, () => FakeResponse>();

  constructor(run: Run) {
    this.run = run;
  }

  install(): void {
    globals.fetch = (async (href: string, init?: { method?: string }) =>
      this.answer(new URL(String(href), "http://runs.test"), init?.method ?? "GET")) as unknown as typeof fetch;
  }

  /** How often the run itself has been re-read; waiting for this is waiting for one poll. */
  get polls(): number {
    return this.asked.filter((entry) => entry === `GET ${this.runPath}`).length;
  }

  /** The process is gone: nothing answers, which is the `api_unreachable` SPEC 5 gives a client. */
  stop(): void {
    this.dead = true;
  }

  live(): void {
    this.dead = false;
  }

  /** An action refused, in the SPEC 5 shape the API answers it with. */
  refuse(action: "cancel" | "retry" | "resume", code: string, message: string, status = 409): void {
    this.routes.set(`POST ${this.runPath}/${action}`, () => reply({ code, message }, status));
  }

  /** An action that worked, answering with the run as it is after. */
  allow(action: "cancel" | "retry" | "resume", after?: Run): void {
    this.routes.set(`POST ${this.runPath}/${action}`, () => reply(after ?? this.run));
  }

  /** Stop answering the read of the run, until `answerPollAgain`. This is what a lost poll looks like. */
  refusePoll(message = "the api is down"): void {
    this.routes.set(`GET ${this.runPath}`, () => reply({ code: "internal_error", message }, 500));
  }

  answerPollAgain(): void {
    this.routes.delete(`GET ${this.runPath}`);
  }

  private get runPath(): string {
    return `/v1/runs/${this.run.id}`;
  }

  private async answer(url: URL, method: string): Promise<FakeResponse> {
    const key = `${method} ${url.pathname}`;
    this.asked.push(key);
    if (this.dead) throw new TypeError("connection refused");
    const route = this.routes.get(key);
    if (route !== undefined) return route();
    if (key === `GET ${this.runPath}`) return reply(this.run);
    if (key === `GET ${this.runPath}/files`) {
      return this.files === null
        ? reply({ code: "not_found", message: `run "${this.run.id}" has no files listed` }, 404)
        : reply(this.files);
    }
    if (key === `GET ${this.runPath}/file`) {
      const path = url.searchParams.get("path") ?? "";
      const text = this.downloads[path];
      return text === undefined
        ? reply({ code: "file_not_found", message: `no file ${path} in run "${this.run.id}"` }, 404)
        : replyBytes(text, path.slice(path.lastIndexOf("/") + 1));
    }
    if (key === `GET ${this.runPath}/archive`) {
      const stepId = url.searchParams.get("step");
      const attemptNo = url.searchParams.get("attempt");
      // The same names apps/api names them with, so a test that reads a filename reads something true.
      const name =
        stepId === null ? this.run.id : `${this.run.id}-${stepId}${attemptNo === null ? "" : `-attempt${attemptNo}`}`;
      return replyBytes(this.downloads.archive ?? "", `${name}.tar.gz`);
    }
    const log = /^\/v1\/runs\/[^/]+\/logs\/([^/]+)\/(\d+)$/.exec(url.pathname);
    if (log !== null) return this.logChunk(url, log[1]!, log[2]!);
    return reply({ code: "internal_error", message: `nothing on this server answers ${key}` }, 500);
  }

  private async logChunk(url: URL, stepId: string, attemptNo: string): Promise<FakeResponse> {
    if (this.logDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.logDelayMs));
    const bytes = new TextEncoder().encode(this.logs[`${stepId}/${attemptNo}`] ?? this.logs[stepId] ?? "");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const piece = bytes.slice(offset, offset + this.chunkBytes);
    return reply({
      run: this.run.id,
      step: stepId,
      attempt: Number(attemptNo),
      offset,
      next_offset: offset + piece.length,
      text: new TextDecoder().decode(piece),
      truncated: offset + piece.length < bytes.length,
    });
  }
}

/**
 * A clock a test turns by hand.
 *
 * Both live views ask for the time and arm their next read through one object, so a test can say what
 * time it is and when the next read is owed instead of sleeping for a poll that would only tell it
 * what it already knows. `waking` is the whole of finding 45 reduced to a number: a live view is one
 * that has a read waiting, and a finished one is a view that has none.
 */
class FakeClock {
  private hand = 0;
  private readonly armed: { at: number; run: () => void }[] = [];

  /** How many reads are waiting to be woken. */
  get waking(): number {
    return this.armed.length;
  }

  now(): number {
    return this.hand;
  }

  after(ms: number, run: () => void): () => void {
    const job = { at: this.hand + ms, run };
    this.armed.push(job);
    return () => {
      const at = this.armed.indexOf(job);
      if (at >= 0) this.armed.splice(at, 1);
    };
  }

  /** Stand the clock at a wall-clock instant, written the way run.json writes them. */
  set(instant: string): void {
    this.hand = Date.parse(instant);
  }

  /** Move the hand on and wake whatever came due, each read landing before the next is considered. */
  async advance(ms: number): Promise<void> {
    this.hand += ms;
    for (;;) {
      const due = this.armed.filter((job) => job.at <= this.hand).toSorted((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.armed.splice(this.armed.indexOf(due), 1);
      due.run();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // The last read has to finish and arm (or refuse to arm) its successor before the test looks.
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Opens one run and leaves it open, because these tests are about what a poll does to the page. */
let previous: AbortController | null = null;

async function openRun(server: FakeServer, clock?: Clock): Promise<FakeElement> {
  previous?.abort();
  const view = new FakeElement("div");
  const controller = new AbortController();
  controllers.push(controller);
  previous = controller;
  server.install();
  renderRuns(
    view as unknown as HTMLElement,
    { path: `/runs/${server.run.id}`, parts: ["runs", server.run.id], query: new URLSearchParams() },
    controller.signal,
    clock,
  );
  await waitFor("the steps to be drawn", () => {
    const rows = view.querySelectorAll(".steprow");
    return rows.length > 0 && rows.every((row) => row.querySelector(".steprow__stamp")?.textContent !== "");
  });
  return view;
}

/** Gives up with a message rather than hanging the suite. Polls are a second apart, so this waits. */
async function waitFor(what: string, done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 400; turn++) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const click = (node: FakeElement): void => void node.dispatchEvent("click");
const statusLine = (view: FakeElement): string => one(view.querySelector('[id="log-status"]'), "the log status line").textContent;
const runStamp = (view: FakeElement): string =>
  one(one(view.querySelector(".runhead__meta"), "the run head").querySelector(".stamp"), "the head stamp").textContent.trim();
const drawnLines = (view: FakeElement): string[] => view.querySelectorAll(".log__text").map((node) => node.textContent);
const alarmOf = (view: FakeElement): FakeElement => one(view.querySelector(".alarm"), "the alarm");
const attemptButtons = (view: FakeElement): FakeElement[] =>
  one(view.querySelector(".attempts"), "the attempt picker").querySelectorAll("button");
const attemptButton = (view: FakeElement, index: number): FakeElement =>
  one(attemptButtons(view)[index] ?? null, `the attempt button number ${index + 1}`);
const buttonNamed = (view: FakeElement, label: string): FakeElement =>
  one(view.querySelectorAll("button").find((node) => node.textContent.trim() === label) ?? null, `the ${label} button`);

// ---------- the runs these tests are about ----------

/** A run that is working, with one step on its first attempt. */
const LIVE = runFixture([step("fetch", "succeeded"), step("render", "running", ["fetch"])], "running");

/** The same, but the running step is on its second attempt, so the picker has a choice to make. */
const LIVE_RETRYING = (() => {
  const live = runFixture([step("render", "running")], "running");
  const retrying = live.steps["render"]!;
  retrying.attempts = [attempt(1, "failed"), attempt(2, "running")];
  retrying.attempts_used = 2;
  return live;
})();

/** A finished run with two steps that both printed something. */
const DONE = runFixture([step("fetch", "succeeded"), step("render", "succeeded", ["fetch"])], "succeeded");

/** A step that failed twice, so its attempt picker has two buttons and the run is over. */
const TWICE_FAILED = (() => {
  const failed = runFixture([step("render", "failed")], "failed");
  const twice = failed.steps["render"]!;
  twice.attempts = [attempt(1, "failed"), attempt(2, "failed")];
  twice.attempts_used = 2;
  return failed;
})();

/** The report from the bug: six steps failed and the one that needed them never started. */
const SIX_FAILED = runFixture(
  [
    step("fetch", "succeeded"),
    ...["a", "b", "c", "d", "e", "f"].map((id) => step(id, "failed", ["fetch"])),
    step("report", "skipped", ["a", "b", "c", "d", "e", "f"]),
  ],
  "failed",
);

// ---------- what a refused action does ----------

describe("an action the server refuses", () => {
  test("a refused resume stays on the page, in the server's own words, through a poll", async () => {
    const server = new FakeServer(LIVE);
    server.refuse("resume", "run_claimed", "Another engine holds this run.");
    const view = await openRun(server);

    const resume = buttonNamed(view, "Resume");
    expect(resume.hidden).toBe(false);
    click(resume);
    await waitFor("the refusal to be drawn", () => !alarmOf(view).hidden);

    const alarm = alarmOf(view);
    expect(alarm.textContent).toContain("Resume refused");
    expect(alarm.textContent).toContain("run_claimed");
    expect(alarm.textContent).toContain("Another engine holds this run.");

    // The bug was here: the next poll rendered the head, and the head hid the box in the same tick.
    const polls = server.polls;
    await waitFor("another poll", () => server.polls > polls);
    expect(alarm.hidden).toBe(false);
    expect(alarm.textContent).toContain("run_claimed");
  });

  test("dismiss takes the refusal away", async () => {
    const server = new FakeServer(LIVE);
    server.refuse("resume", "run_claimed", "Another engine holds this run.");
    const view = await openRun(server);
    const resume = buttonNamed(view, "Resume");
    expect(resume.hidden).toBe(false);
    click(resume);
    await waitFor("the refusal to be drawn", () => !alarmOf(view).hidden);

    click(one(alarmOf(view).querySelector('[data-action="dismiss"]'), "the Dismiss button"));
    expect(alarmOf(view).hidden).toBe(true);
  });

  test("an action that works clears the refusal that came before it", async () => {
    const server = new FakeServer(LIVE);
    server.refuse("resume", "run_claimed", "Another engine holds this run.");
    const view = await openRun(server);
    const resume = buttonNamed(view, "Resume");
    expect(resume.hidden).toBe(false);
    click(resume);
    await waitFor("the refusal to be drawn", () => !alarmOf(view).hidden);

    server.allow("resume");
    click(resume);
    await waitFor("the alarm to clear", () => alarmOf(view).hidden);
    expect(alarmOf(view).textContent).toBe("");
  });

  test("retry on a run that already succeeded says so, and stays said", async () => {
    const server = new FakeServer(DONE);
    server.refuse("retry", "run_not_retryable", "A run that succeeded is not retried.", 400);
    const view = await openRun(server);

    const retry = buttonNamed(view, "Retry");
    expect(retry.hidden).toBe(false);
    click(retry);
    await waitFor("the refusal to be drawn", () => !alarmOf(view).hidden);

    expect(alarmOf(view).textContent).toContain("Retry refused");
    expect(alarmOf(view).textContent).toContain("run_not_retryable");
    // Nothing is polled for a finished run, so nothing is waiting to hide the reason again.
    await settle();
    expect(alarmOf(view).hidden).toBe(false);
  });
});

// ---------- what a poll does to the controls ----------

describe("the controls of a live run", () => {
  test("the jump box keeps what you typed and Cancel keeps focus across a poll", async () => {
    const server = new FakeServer(LIVE);
    const view = await openRun(server);
    const box = one(view.querySelector('[id="run-jump"]'), "the run jump box");
    const cancel = buttonNamed(view, "Cancel run");
    box.value = "20261104T120000Z-deadbeef";
    cancel.focus();
    expect(fakeDocument.activeElement).toBe(cancel);

    const polls = server.polls;
    await waitFor("a poll", () => server.polls > polls);

    expect(view.querySelector('[id="run-jump"]')).toBe(box);
    expect(one(view.querySelector('[id="run-jump"]'), "the run jump box").value).toBe("20261104T120000Z-deadbeef");
    expect(buttonNamed(view, "Cancel run")).toBe(cancel);
    expect(fakeDocument.activeElement).toBe(cancel);
  });

  test("the attempt picker is the same two buttons every poll", async () => {
    const server = new FakeServer(LIVE_RETRYING);
    const view = await openRun(server);
    const first = attemptButton(view, 0);
    const second = attemptButton(view, 1);
    expect(attemptButtons(view).map((node) => node.textContent)).toEqual(["1", "2"]);
    expect(second.getAttribute("aria-pressed")).toBe("true");
    first.focus();

    const polls = server.polls;
    await waitFor("a poll", () => server.polls > polls);

    expect(attemptButtons(view).map((node) => node.textContent)).toEqual(["1", "2"]);
    expect(attemptButton(view, 0)).toBe(first);
    expect(attemptButton(view, 1)).toBe(second);
    expect(fakeDocument.activeElement).toBe(first);
  });

  test("picking another attempt reads that attempt's bytes, and says which is pressed", async () => {
    const server = new FakeServer(TWICE_FAILED);
    server.logs = { "render/1": "the first try\n", "render/2": "the second try\n" };
    const view = await openRun(server);
    await waitFor("the newest attempt", () => drawnLines(view).join() === "the second try");
    expect(attemptButton(view, 1).getAttribute("aria-pressed")).toBe("true");

    click(attemptButton(view, 0));
    await waitFor("attempt 1's log", () => drawnLines(view).join() === "the first try");

    expect(attemptButton(view, 0).getAttribute("aria-pressed")).toBe("true");
    expect(attemptButton(view, 1).getAttribute("aria-pressed")).toBe("false");
    expect(statusLine(view)).toBe(`Read to byte ${byteLength("the first try\n")}.`);
  });
});

// ---------- the line that says where the log is ----------

describe("the line under the log", () => {
  test("it moves with the cursor while a long log is still being read", async () => {
    const server = new FakeServer(DONE);
    server.logs = { render: "one line\nthen another\nlast one\n" };
    server.chunkBytes = 10;
    server.logDelayMs = 150;
    const view = await openRun(server);

    // The old line was written once, before any of the log had arrived, and never again.
    await waitFor("the first chunk", () => drawnLines(view).length > 0);
    expect(statusLine(view)).toBe("Read to byte 10; more of the log is waiting.");

    await waitFor("the whole log", () => statusLine(view) === `Read to byte ${byteLength("one line\nthen another\nlast one\n")}.`);
  });

  test("switching steps starts the line again rather than going on from the step you left", async () => {
    const server = new FakeServer(DONE);
    server.logs = { fetch: "fetched three bytes\n", render: "rendered\n" };
    server.logDelayMs = 200;
    const view = await openRun(server);
    await waitFor("render's log", () => statusLine(view) === `Read to byte ${byteLength("rendered\n")}.`);

    click(rowOf(view, "fetch"));
    // The pane belongs to fetch now and its bytes are still on the way; the line must not still be
    // reporting where render left the cursor.
    expect(statusLine(view)).toBe("Read to byte 0.");

    await waitFor("fetch's log", () => statusLine(view) === `Read to byte ${byteLength("fetched three bytes\n")}.`);
    expect(drawnLines(view)).toEqual(["fetched three bytes"]);
  });
});

// ---------- when the server goes away ----------

describe("a server that stops answering", () => {
  test("the page says it lost the server, and stops saying it when the server comes back", async () => {
    const server = new FakeServer(LIVE);
    server.logs = { render: "hello\n" };
    const view = await openRun(server);
    await waitFor("the first log read", () => statusLine(view) === "Reading from byte 6.");

    server.stop();
    await waitFor("the page to notice", () => statusLine(view).includes("Lost the server, still trying."));
    expect(statusLine(view)).toContain("api_unreachable");
    // The last good poll stays on screen, which is why the line has to carry the bad news.
    expect(one(view.querySelector('[id="panel-title"]'), "the panel title").textContent).toBe("render");

    server.live();
    await waitFor("a good poll", () => !statusLine(view).includes("Lost the server"));
    expect(statusLine(view)).toBe("Reading from byte 6.");
  });
});

// ---------- what the alarm says ----------

describe("the alarm over the steps", () => {
  test("it names every step that failed, each one a way to its log", async () => {
    const server = new FakeServer(SIX_FAILED);
    const view = await openRun(server);
    const alarm = alarmOf(view);

    expect(alarm.hidden).toBe(false);
    expect(one(alarm.querySelector(".h2"), "the alarm's title").textContent).toBe("6 steps failed");
    expect(alarm.querySelectorAll("[data-log-step]").map((node) => node.textContent)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    expect(alarm.textContent).toContain("exit_nonzero: the script exited 1");
  });

  test("the retry button is labelled with what a retry does, which is more than the failed steps", async () => {
    const server = new FakeServer(SIX_FAILED);
    const view = await openRun(server);
    const alarm = alarmOf(view);

    // SPEC 4.6: retry sets every failed, skipped and cancelled step back to pending.
    expect(one(alarm.querySelector('[data-action="retry-all"]'), "the retry button").textContent).toBe("Retry 7 steps");
    expect(alarm.textContent).toContain("Retry sets 6 failed steps, 1 skipped step back to pending");
  });

  test("one failed step is named, not counted", async () => {
    const server = new FakeServer(FAILED_RUN);
    const view = await openRun(server);
    const alarm = alarmOf(view);

    expect(one(alarm.querySelector(".h2"), "the alarm's title").textContent).toBe("render failed");
    expect(alarm.querySelectorAll("[data-log-step]").map((node) => node.textContent)).toEqual(["render"]);
    expect(one(alarm.querySelector('[data-action="retry-all"]'), "the retry button").textContent).toBe("Retry 2 steps");
  });

  test("the alarm is not rebuilt under you while the run polls", async () => {
    const limping = runFixture([step("render", "failed"), step("report", "running", ["render"])], "running");
    const server = new FakeServer(limping);
    const view = await openRun(server);
    const retry = one(alarmOf(view).querySelector('[data-action="retry-all"]'), "the retry button");
    retry.focus();

    const polls = server.polls;
    await waitFor("a poll", () => server.polls > polls);

    expect(one(alarmOf(view).querySelector('[data-action="retry-all"]'), "the retry button")).toBe(retry);
    expect(fakeDocument.activeElement).toBe(retry);
  });

  test("a failed step's name in the alarm points the pane at its log and puts the focus on its row", async () => {
    const server = new FakeServer(SIX_FAILED);
    const view = await openRun(server);
    expect(one(view.querySelector('[id="panel-title"]'), "the panel title").textContent).toBe("a");

    click(one(alarmOf(view).querySelector('[data-log-step="c"]'), "the link to c's log"));
    await waitFor("the pane to move to c", () => one(view.querySelector('[id="panel-title"]'), "the panel title").textContent === "c");

    expect(rowOf(view, "c").getAttribute("aria-selected")).toBe("true");
    expect(fakeDocument.activeElement).toBe(rowOf(view, "c"));
  });
});

// ---------- following a log that cannot grow ----------

describe("following a log", () => {
  test("a finished run does not offer to follow or pause a log that cannot grow", async () => {
    const server = new FakeServer(DONE);
    server.logs = { render: "rendered\n" };
    const view = await openRun(server);
    await waitFor("the log", () => drawnLines(view).length > 0);

    expect(buttonNamed(view, "Follow").disabled).toBe(true);
    expect(buttonNamed(view, "Pause").disabled).toBe(true);
  });

  test("a live run offers both", async () => {
    const server = new FakeServer(LIVE);
    server.logs = { render: "hello\n" };
    const view = await openRun(server);
    await waitFor("the log", () => drawnLines(view).length > 0);

    expect(buttonNamed(view, "Follow").disabled).toBe(false);
    expect(buttonNamed(view, "Pause").disabled).toBe(false);
  });

  test("a pause made while the run was live can still be undone after it finishes", async () => {
    const server = new FakeServer(LIVE);
    server.logs = { render: "hello\n" };
    const view = await openRun(server);
    await waitFor("the log", () => drawnLines(view).length > 0);
    click(buttonNamed(view, "Pause"));
    expect(statusLine(view)).toContain("Paused.");

    server.run = DONE;
    await waitFor("the run to finish", () => runStamp(view) === "succeeded");
    expect(buttonNamed(view, "Follow").disabled).toBe(true);
    expect(buttonNamed(view, "Resume reading").disabled).toBe(false);

    click(buttonNamed(view, "Resume reading"));
    await waitFor("the reading to start again", () => !statusLine(view).startsWith("Paused."));
    expect(statusLine(view)).toBe("Read to byte 6.");
  });

  test("a step that has never started has nothing to pause", async () => {
    const server = new FakeServer(runFixture([step("build", "pending")], "running"));
    const view = await openRun(server);

    expect(statusLine(view)).toBe("Not started.");
    expect(buttonNamed(view, "Pause").disabled).toBe(true);
    expect(buttonNamed(view, "Follow").disabled).toBe(false);
  });
});

// ---------- a live view keeps up with the run ----------
//
// Both screens are a read of run.json on a timer, and the whole of finding 45 was that the timer was
// never there: the list was painted once and left, so a run that started, finished or was retried
// while you were looking only turned up after a reload. What is pinned here is the loop and not the
// wait. Each test hands the screen a clock it turns itself and counts the reads the screen asked for,
// so "it polled, and then it stopped" is a number rather than a nap, and "running for 4 m 07 s" is
// measured against a now the test chose rather than whatever the machine running the suite believes.

/**
 * The Runs list, on a clock the test turns. `answer` and `fail` say what the next read will say and
 * `reads` counts them, so a test can watch the screen ask rather than wait to see whether it did.
 */
async function liveList(runs: RunSummary[], firstFails = false): Promise<{
  view: FakeElement;
  clock: FakeClock;
  reads(): number;
  answer(runs: RunSummary[] | (() => Promise<FakeResponse>)): void;
  fail(message: string): void;
}> {
  previous?.abort();
  const controller = new AbortController();
  controllers.push(controller);
  previous = controller;
  const view = new FakeElement("div");
  const clock = new FakeClock();
  let asked = 0;
  let next: () => Promise<FakeResponse> = firstFails
    ? async () => {
        throw new Error("the api is down");
      }
    : async () => reply(runs);
  const saved = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.endsWith("/v1/runs")) return saved(input);
    asked += 1;
    return next();
  }) as typeof fetch;
  cleanups.push(() => {
    globalThis.fetch = saved;
  });
  renderRuns(
    view as unknown as HTMLElement,
    { path: "/runs", parts: ["runs"], query: new URLSearchParams() },
    controller.signal,
    clock,
  );
  // The first read has landed once there are rows, or the list has said it is empty, or it has said
  // nothing at all because the read failed and the whole screen is the error.
  await waitFor("the list's first read", () => view.querySelectorAll(".runrow").length > 0 || note(view).hidden);
  return {
    view,
    clock,
    reads: () => asked,
    answer: (list) => {
      // Either the page to answer with, or the whole answer: a test that wants to hold a read open
      // until it says so passes a function.
      next = typeof list === "function" ? list : async () => reply(list);
    },
    fail: (message) => {
      next = async () => {
        throw new Error(message);
      };
    },
  };
}

const note = (view: FakeElement): FakeElement => one(view.querySelector(".runlist__note"), "the line under the heading");
const panelTitle = (view: FakeElement): string => one(view.querySelector('[id="panel-title"]'), "the log panel's title").textContent;
const metaLine = (view: FakeElement, starts: string): FakeElement =>
  one(
    view.querySelectorAll(".runhead__meta span").find((node) => node.textContent.startsWith(starts)) ?? null,
    `the head line starting "${starts}"`,
  );

describe("a list that keeps up", () => {
  test("reads again while a run on it is going", async () => {
    const list = await liveList([summary("20261104T101500Z-3fa9c2d1", "running")]);
    expect(list.clock.waking).toBe(1);

    list.answer([summary("20261104T101500Z-3fa9c2d1", "succeeded")]);
    await list.clock.advance(POLL_MS);

    expect(list.reads()).toBe(2);
    expect(word(one(list.view.querySelector(".stamp"), "the row's state"))).toBe("succeeded");
  });

  test("goes quiet the moment nothing on it is running, and keeps a slow watch", async () => {
    const list = await liveList([summary("20261104T101500Z-3fa9c2d1", "running")]);
    list.answer([summary("20261104T101500Z-3fa9c2d1", "succeeded")]);
    await list.clock.advance(POLL_MS);

    // One timer, and it is the slow one: nothing here is moving, but the list is still the front door.
    expect(list.clock.waking).toBe(1);
    const reads = list.reads();
    await list.clock.advance(POLL_MS * 10);
    expect(list.reads()).toBe(reads);
    await list.clock.advance(IDLE_POLL_MS);
    expect(list.reads()).toBe(reads + 1);
  });

  test("a run started somewhere else turns up while the list is quiet", async () => {
    const list = await liveList([summary("20261104T101500Z-3fa9c2d1", "succeeded")]);
    expect(list.reads()).toBe(1);

    // Started from the CLI, or in another tab: nobody has touched this page.
    list.answer([summary("20261104T111500Z-1a2b3c4d", "running"), summary("20261104T101500Z-3fa9c2d1", "succeeded")]);
    await list.clock.advance(IDLE_POLL_MS);

    expect(list.reads()).toBe(2);
    expect(list.view.querySelectorAll(".runrow").length).toBe(2);
    expect(word(one(list.view.querySelector(".stamp"), "the row's state"))).toBe("running");
    // And with something running, the fast loop is back on its own.
    await list.clock.advance(POLL_MS);
    expect(list.reads()).toBe(3);
  });

  test("one read that reorders, gains and loses in the same breath", async () => {
    const list = await liveList([
      summary("20261104T101500Z-3fa9c2d1", "running"),
      summary("20261104T091500Z-4b5c6d7e", "running"),
    ]);
    const before = list.view.querySelectorAll(".runrow");
    const kept = one(before[0] ?? null, "the older row");
    const gone = one(before[1] ?? null, "the row that is about to go");
    kept.focus();

    // The older of the two has been deleted, a newer one has arrived, and the survivor has moved up.
    list.answer([summary("20261104T111500Z-1a2b3c4d", "running"), summary("20261104T101500Z-3fa9c2d1", "succeeded")]);
    await list.clock.advance(POLL_MS);

    const rows = list.view.querySelectorAll(".runrow");
    expect(rows.length).toBe(2);
    expect(rows[1]).toBe(kept);
    expect(fakeDocument.activeElement).toBe(kept);
    expect(rows[0]).not.toBe(kept);
    expect(rows[0]).not.toBe(gone);
  });

  test("an empty list fills, and empties again", async () => {
    const list = await liveList([]);
    expect(one(list.view.querySelector(".stage__empty"), "the empty message").hidden).toBe(false);
    expect(note(list.view).hidden).toBe(true);

    list.answer([summary("20261104T101500Z-3fa9c2d1", "running")]);
    await list.clock.advance(IDLE_POLL_MS);
    expect(list.view.querySelectorAll(".runrow").length).toBe(1);
    expect(one(list.view.querySelector(".stage__empty"), "the empty message").hidden).toBe(true);
    expect(note(list.view).hidden).toBe(true);

    list.answer([]);
    await list.clock.advance(POLL_MS);
    expect(list.view.querySelectorAll(".runrow").length).toBe(0);
    expect(one(list.view.querySelector(".stage__empty"), "the empty message").hidden).toBe(false);
    expect(note(list.view).hidden).toBe(true);
  });

  test("a first read that fails does not leave the page saying it is loading", async () => {
    const list = await liveList([], true);
    expect(list.view.querySelector("[role=alert]")).not.toBeNull();
    // The box is the whole of the screen now: the line that said it was loading has to get out of it.
    expect(note(list.view).hidden).toBe(true);

    list.answer([summary("20261104T101500Z-3fa9c2d1", "running")]);
    await list.clock.advance(POLL_MS);
    expect(list.view.querySelectorAll(".runrow").length).toBe(1);
    expect(list.view.querySelector("[role=alert]")).toBeNull();
    expect(note(list.view).hidden).toBe(true);
  });

  test("a run that starts while you are looking turns up, and the row you were on is the same row", async () => {
    const list = await liveList([summary("20261104T101500Z-3fa9c2d1", "running")]);
    const row = one(list.view.querySelector(".runrow"), "the row for the run already there");
    row.focus();

    // Newest first, so the old row has to move down a place.
    list.answer([summary("20261104T111500Z-1a2b3c4d", "running"), summary("20261104T101500Z-3fa9c2d1", "running")]);
    await list.clock.advance(POLL_MS);

    const rows = list.view.querySelectorAll(".runrow");
    expect(rows.length).toBe(2);
    expect(rows[1]).toBe(row);
    // The reason rows are patched rather than rebuilt: a rebuilt one takes the focus off you.
    expect(fakeDocument.activeElement).toBe(row);
  });

  test("says the reading is lost while the server is down, and stops saying it when it is not", async () => {
    const list = await liveList([summary("20261104T101500Z-3fa9c2d1", "running")]);
    list.fail("the api is down");
    await list.clock.advance(POLL_MS);

    expect(note(list.view).hidden).toBe(false);
    expect(note(list.view).textContent).toContain("Lost the server");
    // The rows stay: a list that cannot read is not a list that is empty.
    expect(list.view.querySelectorAll(".runrow").length).toBe(1);
    // and it keeps trying, because the run may still be going.
    expect(list.clock.waking).toBe(1);

    list.answer([summary("20261104T101500Z-3fa9c2d1", "succeeded")]);
    await list.clock.advance(POLL_MS);
    expect(note(list.view).hidden).toBe(true);
  });

  test("a tab nobody is looking at reads nothing, and reads the moment it is looked at again", async () => {
    const list = await liveList([summary("20261104T101500Z-3fa9c2d1", "running")]);
    showTab(true);
    try {
      await list.clock.advance(POLL_MS * 5);
      expect(list.reads()).toBe(1);
      expect(list.clock.waking).toBe(0);

      list.answer([summary("20261104T101500Z-3fa9c2d1", "succeeded")]);
      showTab(false);
      await waitFor("the row to say the run is over", () => list.view.textContent.includes("succeeded"));
      expect(word(one(list.view.querySelector(".stamp"), "the row's state"))).toBe("succeeded");
    } finally {
      showTab(false);
    }
  });

  test("a tab looked at again while a read is on its way does not start a second one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let out = 0;
    let peak = 0;
    const list = await liveList([summary("20261104T101500Z-3fa9c2d1", "running")]);
    list.answer(() => {
      out += 1;
      peak = Math.max(peak, out);
      return gate.then(() => {
        out -= 1;
        return reply([summary("20261104T101500Z-3fa9c2d1", "running")]);
      });
    });

    // The tab goes away and comes back while that read is still in the air.
    await list.clock.advance(POLL_MS);
    showTab(true);
    showTab(false);
    release();
    await waitFor("the read to land", () => out === 0);

    expect(peak).toBe(1);
    // The read that landed is what re-armed the timer, so the list has not gone quiet on its own.
    expect(list.clock.waking).toBe(1);
  });
});

describe("a run screen that keeps up", () => {
  test("stops asking once the run is finished, and leaves no timer behind", async () => {
    const server = new FakeServer(runFixture([step("build", "running")], "running"));
    const clock = new FakeClock();
    const view = await openRun(server, clock);
    expect(clock.waking).toBe(1);

    server.run = runFixture([step("build", "succeeded")], "succeeded");
    await clock.advance(POLL_MS);

    expect(runStamp(view)).toBe("succeeded");
    expect(clock.waking).toBe(0);
    const polls = server.polls;
    await clock.advance(POLL_MS * 10);
    expect(server.polls).toBe(polls);
  });

  test("follow stays on a step that failed an attempt and is due another one", async () => {
    const server = new FakeServer(runFixture([step("build", "running"), step("report", "pending", ["build"])], "running"));
    const clock = new FakeClock();
    const view = await openRun(server, clock);
    expect(panelTitle(view)).toBe("build");

    // The attempt failed and the retry timer has it now. The run is still going, and so is this step:
    // the next attempt is its log continuing, not another step's starting.
    server.run = runFixture([step("build", "waiting_retry"), step("report", "running", ["build"])], "running");
    await clock.advance(POLL_MS);

    expect(panelTitle(view)).toBe("build");
    expect(word(one(rowOf(view, "build").querySelector(".stamp"), "the row's state"))).toBe("waiting_retry");
    expect(rowOf(view, "build").textContent).toContain("On screen");
  });

  test("a retry that is already due is not counted backwards", async () => {
    const clock = new FakeClock();
    // The fixture is written around T0, and its retry is due at T1: 41 seconds on.
    clock.set(T0);
    const server = new FakeServer(runFixture([step("build", "waiting_retry"), step("report", "pending", ["build"])], "running"));
    const view = await openRun(server, clock);
    expect(rowOf(view, "build").textContent).toContain("Another attempt in 41 s");

    // The engine's clock and the browser's are two clocks, and the browser can wake after the due time.
    // Counting up from there would read as a countdown that went wrong.
    await clock.advance(42_000);
    expect(rowOf(view, "build").textContent).toContain("Another attempt is due now.");
  });

  test("a stored time this build cannot read says nothing rather than NaN", async () => {
    const broken = runFixture([step("build", "running")], "running");
    broken.created_at = "not a time at all";
    const server = new FakeServer(broken);
    const view = await openRun(server, new FakeClock());

    expect(view.textContent).not.toContain("NaN");
    expect(metaLine(view, "started").textContent).toBe("started");
  });

  test("says the poll is lost, and stops saying it when the server answers again", async () => {
    const server = new FakeServer(LIVE);
    const clock = new FakeClock();
    const view = await openRun(server, clock);

    server.refusePoll();
    await clock.advance(POLL_MS);
    expect(metaLine(view, "lost the server").textContent).toBe("lost the server, still trying");
    expect(metaLine(view, "lost the server").getAttribute("title")).toContain("the api is down");
    // The state on screen stays the last good one, because that is the last thing known about it.
    expect(runStamp(view)).toBe("running");

    server.answerPollAgain();
    await clock.advance(POLL_MS);
    expect(metaLine(view, "lost the server").hidden).toBe(true);
  });

  test("follow moves the pane to the step that is running now", async () => {
    const server = new FakeServer(runFixture([step("fetch", "running")], "running"));
    const clock = new FakeClock();
    const view = await openRun(server, clock);
    expect(panelTitle(view)).toBe("fetch");

    // `render` starts and `fetch` finishes on the same poll, which is the case the old rule missed:
    // there was no new attempt to notice, so the pane sat on a finished log while the run went on.
    server.run = runFixture([step("fetch", "succeeded"), step("render", "running", ["fetch"])], "running");
    await clock.advance(POLL_MS);

    expect(panelTitle(view)).toBe("render");
  });

  test("follow off pins the pane to the step it was left on", async () => {
    const server = new FakeServer(runFixture([step("fetch", "running")], "running"));
    const clock = new FakeClock();
    const view = await openRun(server, clock);
    click(buttonNamed(view, "Follow"));
    expect(buttonNamed(view, "Follow").getAttribute("aria-pressed")).toBe("false");

    server.run = runFixture([step("fetch", "succeeded"), step("render", "running", ["fetch"])], "running");
    await clock.advance(POLL_MS);

    // Somebody chose this step and turned following off to keep it: the run moving on is not their
    // business. Only the pane moving is, and only when they asked for it.
    expect(panelTitle(view)).toBe("fetch");
  });

  test("the time it has been going is counted from the run's own clock, not the machine's", async () => {
    const server = new FakeServer(LIVE);
    const clock = new FakeClock();
    clock.set("2026-11-04T10:19:07Z"); // 4 m 07 s after the run was created
    const view = await openRun(server, clock);

    expect(metaLine(view, "running for").textContent).toBe("running for 4 m 07 s");
  });

  test("a run that has finished says how long it took, and stops counting", async () => {
    const server = new FakeServer(DONE);
    const clock = new FakeClock();
    clock.set("2026-11-04T13:00:00Z"); // hours after it was over
    const view = await openRun(server, clock);

    expect(metaLine(view, "took").textContent).toBe(`took ${duration(41)}`);
    expect(clock.waking).toBe(0);
  });
});

/** Two digits, for reading a date back off a `Date`'s local getters. */
const pair = (n: number) => String(n).padStart(2, "0");

describe("one clock on the screen", () => {
  test("a time is the reader's own clock, and does not name a zone", () => {
    const stamp = when("2026-11-04T10:15:00Z");
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Read back as the reader's own local time it is the same instant: nothing is printed in a zone
    // the reader did not choose, which is what made three screens disagree by hours.
    expect(Date.parse(stamp)).toBe(Date.parse("2026-11-04T10:15:00Z"));
  });

  test("the exact instant is on the page for anyone who wants it", async () => {
    const server = new FakeServer(LIVE);
    const view = await openRun(server);

    expect(metaLine(view, "started").getAttribute("title")).toBe(LIVE.created_at);
    expect(metaLine(view, "started").textContent).toBe(`started ${when(LIVE.created_at)}`);
  });

  test("the printed time is the same instant the server sent", () => {
    // Computed from the reader's own local getters, so it holds in any zone the test machine runs in:
    // this is the one place that says out loud what `when` promises.
    const local = new Date(Date.UTC(2026, 10, 4, 10, 15, 0));
    expect(when("2026-11-04T10:15:00Z")).toBe(
      `${local.getFullYear()}-${pair(local.getMonth() + 1)}-${pair(local.getDate())} ${pair(local.getHours())}:${pair(local.getMinutes())}:${pair(local.getSeconds())}`,
    );
  });

  test("a time that is not there is nothing, not a date invented", () => {
    expect(when(null)).toBe("");
    expect(isoInstant(null)).toBe("");
  });
});

// ---------- the words on the page, and the box they have to fit in ----------
//
// Everything above is what the screen says; this is whether it still fits when what it says is the
// length real things are. A run id is 26 characters, a pipeline description can be one unbroken
// 300-character word, and the app serves `style-src 'self'`, which drops an inline `style` attribute
// on the floor with a console error. None of that is a screenshot: it is the shape of the markup and
// the rule in the stylesheet the server ships, so that is what is asserted here. The browser half —
// that the id lands on one line, that the page does not scroll sideways — was checked by hand at
// 1440 px and 390 px; the rules that make it happen are what these tests hold in place.

const sheet = new TextDecoder().decode(buildAssets().files.get("assets/style.css")!.data);

/** The body of one rule, written out with this exact selector. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(sheet);
  if (found === null) throw new Error(`style.css has no rule whose selector is exactly ${selector}`);
  return found[1]!;
}

/** A run in the list, which is what `GET /v1/runs` answers with and less than a whole run. */
function summary(id: string, status: string): RunSummary {
  return { id, pipeline: "word-report", status, created_at: T0, finished_at: T1, cancel_requested_at: null };
}

/** The list screen: one read, and the rows it answers with. */
async function renderList(runs: RunSummary[]): Promise<FakeElement> {
  const view = new FakeElement("div");
  const controller = new AbortController();
  controllers.push(controller);
  globals.fetch = (async () => ({ ok: true, status: 200, json: async () => runs })) as unknown as typeof fetch;
  renderRuns(view as unknown as HTMLElement, { path: "/runs", parts: ["runs"], query: new URLSearchParams() }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  return view;
}

/** Every element the screen put on the page that carries an inline style. */
const styled = (view: FakeElement): string[] =>
  [...view.descendants()].filter((node) => node.attrs.has("style")).map((node) => `${node.tagName.toLowerCase()}[${node.getAttribute("style")}]`);

describe("a run's name", () => {
  test("the display word is Run and the id is set under it in the code face", async () => {
    const view = await render(runFixture([step("build", "succeeded")], "succeeded"));

    const title = one(view.querySelector(".title"), "the run's heading");
    expect(title.textContent.startsWith("Run ")).toBe(true);

    const id = one(title.querySelector(".title__id"), "the run id inside the heading");
    expect(id.textContent).toBe("20261104T101500Z-3fa9c2d1");
    // The code face is what makes an id read as a string, and it comes from the class, not a font
    // the heading happens to inherit.
    expect(id.classList.contains("mono")).toBe(true);
  });

  test("the id is smaller than the smallest the display heading ever gets", () => {
    const idSize = Number(/font-size:\s*([\d.]+)rem/.exec(ruleBody(".title__id"))?.[1]);
    const displayFloor = Number(/font-size:\s*clamp\(\s*([\d.]+)rem/.exec(ruleBody(".title"))?.[1]);
    expect(idSize).toBeGreaterThan(0);
    expect(idSize).toBeLessThan(displayFloor);
  });

  test("the id still breaks at its own hyphen rather than in the middle of a group of digits", () => {
    expect(ruleBody(".title__id")).toMatch(/overflow-wrap:\s*break-word/);
  });
});

describe("a run in the list", () => {
  test("the row says its state once: the stamp, with no second sign beside it", async () => {
    const view = await renderList([summary("20261104T101500Z-3fa9c2d1", "failed")]);

    const row = one(view.querySelector(".runrow"), "a row in the run list");
    expect(row.querySelectorAll(".sign--large").length).toBe(0);
    expect(row.querySelectorAll(".stamp").length).toBe(1);
    expect(word(one(row.querySelector(".stamp"), "the row's stamp"))).toBe("failed");
  });

  test("the stylesheet leaves no column for a sign in front of the stamp", () => {
    expect(ruleBody(".runrow")).toMatch(/grid-template-columns:\s*minmax\(0, ?1fr\) auto/);
  });

  test("the line that reports the reading is a control, not a caption", () => {
    // Both live views read on their own now, so "loading" and "lost the server, still trying" are
    // things the page tells you rather than things you find out by reloading. They take the same
    // emphasis as the line under the log, and nothing else on those screens is bold at that size.
    expect(ruleBody(".runlist__note")).toMatch(/font-weight:\s*700/);
    expect(ruleBody(".runhead__stale")).toMatch(/font-weight:\s*700/);
  });
});

describe("text longer than the box it is in", () => {
  test("a description that is one long word breaks inside its own box", () => {
    // A pipeline's `description:` is whatever the file says it is. Without this the page scrolled
    // sideways: 2635 px of page in a 1440 px window.
    expect(ruleBody(".lead")).toMatch(/overflow-wrap:\s*(anywhere|break-word)/);
  });

  test("the graph gives a port name the whole width of its step", () => {
    // Two columns of port names inside a step whose width the graph sets from the room its columns
    // leave behind is how `total_words` came out as `total_wor/ds` at 1440 px. One column, and the
    // mark on each side is what still says which way the name runs.
    expect(sheet).not.toMatch(/\.node__ports\s*\{[^}]*grid-template-columns/);
    expect(ruleBody(".stage--flow .port--out")).toContain("text-align: right");
  });
});

describe("the app's own content security policy", () => {
  test("no module the browser runs puts a style attribute on an element", () => {
    // The CSP the server sends is `style-src 'self'`: an inline style is dropped, so the control it
    // was styling sits out of line and the console fills up once per poll.
    const offenders: string[] = [];
    for (const [name, asset] of buildAssets().files) {
      if (!name.startsWith("assets/") || !name.endsWith(".js")) continue;
      if (/\bstyle:\s*["']/.test(new TextDecoder().decode(asset.data))) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  test("neither run screen leaves a style attribute on the page", async () => {
    const view = await render(runFixture([step("build", "succeeded")], "succeeded"));
    expect(styled(view)).toEqual([]);
    expect(styled(await renderList([summary("20261104T101500Z-3fa9c2d1", "failed")]))).toEqual([]);
  });

  test("a label beside its buttons is a class, and the class zeroes the margin", () => {
    expect(ruleBody(".label--inline")).toMatch(/margin:\s*0/);
  });
});

// ---------- the files a run can hand out ----------
//
// A run leaves files on the node (SPEC 4.9) and the API will give them back (SPEC 4.10), so the run
// screen has to offer them: the manifest, each file of the attempt on screen, and an archive of a
// step's attempt. What is pinned here is that the links name the run and the path they will fetch,
// that clicking one goes through the API rather than navigating, and that a run whose files cannot be
// listed still shows the run.

const FILES_RUN = runFixture([step("ingest", "succeeded")], "succeeded");
const ATTEMPT_DIR = "steps/ingest/attempts/1";
const REPORT = `${ATTEMPT_DIR}/outputs/report.html`;
const CHUNKS = `${ATTEMPT_DIR}/outputs/chunks/chunks.jsonl`;
const LOGFILE = `${ATTEMPT_DIR}/log/output.txt`;

/** What the manifest route answers for FILES_RUN: three files, one of them in a subdirectory. */
const FILES_MANIFEST = {
  run: FILES_RUN.id,
  status: "succeeded",
  partial: false,
  outputs: [{ name: "report", path: REPORT, size: 24 }],
  steps: {
    ingest: {
      attempts: [
        {
          n: 1,
          status: "succeeded",
          partial: false,
          log: { path: LOGFILE, size: 118 },
          outputs: [
            { name: "report", path: REPORT, size: 24 },
            { name: "chunks.jsonl", path: CHUNKS, size: 1_536 },
          ],
          work: [],
        },
      ],
    },
  },
};

function filesServer(): FakeServer {
  const server = new FakeServer(FILES_RUN);
  server.files = FILES_MANIFEST;
  server.downloads = { [REPORT]: "<html></html>", [CHUNKS]: '{"url":"a"}\n', [LOGFILE]: "fetched\n", archive: "tar.gz bytes" };
  return server;
}

/** A download link, found by the words on it — the fake selector cannot quote a label with spaces. */
function fileLink(view: FakeElement, label: string): FakeElement {
  const link = view
    .querySelectorAll(".file")
    .find((node) => node.getAttribute("data-download") === label);
  if (link === undefined) throw new Error(`the run screen drew no link for ${label}`);
  return link;
}

/** The links under the attempt, which is where the manifest's files are drawn. */
const panelLinks = (view: FakeElement): string[] =>
  view.querySelectorAll(".files .file").map((link) => link.getAttribute("data-download") ?? "");

describe("the files of a run", () => {
  test("the attempt on screen links to each of its files, at that run's own address", async () => {
    const view = await openRun(filesServer());

    expect(panelLinks(view)).toEqual([
      REPORT,
      CHUNKS,
      LOGFILE,
      "Everything in ingest as one archive",
    ]);
    for (const path of [REPORT, CHUNKS, LOGFILE]) {
      expect(fileLink(view, path).getAttribute("href")).toBe(
        `http://runs.test/v1/runs/${FILES_RUN.id}/file?path=${encodeURIComponent(path)}`,
      );
    }
  });

  test("the archive links say which run, which step and which attempt", async () => {
    const view = await openRun(filesServer());

    expect(fileLink(view, "Everything in ingest as one archive").getAttribute("href")).toBe(
      `http://runs.test/v1/runs/${FILES_RUN.id}/archive?step=ingest&attempt=1`,
    );
    expect(fileLink(view, "Download the run").getAttribute("href")).toBe(
      `http://runs.test/v1/runs/${FILES_RUN.id}/archive`,
    );
    expect(fileLink(view, "Download the manifest").getAttribute("href")).toBe(
      `http://runs.test/v1/runs/${FILES_RUN.id}/files`,
    );
  });

  test("a size is said, so nobody clicks blind into a gigabyte", async () => {
    const view = await openRun(filesServer());

    expect(fileLink(view, CHUNKS).textContent).toBe(`${CHUNKS} 1.5 kB`);
    expect(fileLink(view, REPORT).textContent).toBe(`${REPORT} 24 B`);
  });

  test("clicking a file link asks the API for it and does not navigate", async () => {
    const server = filesServer();
    const view = await openRun(server);
    savedFiles.length = 0;

    let navigated = false;
    fileLink(view, REPORT).dispatchEvent("click", { preventDefault: () => void (navigated = true) });
    await waitFor("the file to be handed to the browser", () => savedFiles.length > 0);

    expect(navigated).toBe(true);
    expect(savedFiles).toEqual([{ name: "report.html", url: "blob:13" }]);
    expect(server.asked).toContain(`GET /v1/runs/${FILES_RUN.id}/file`);
  });

  test("clicking the archive link downloads that step's attempt", async () => {
    const server = filesServer();
    const view = await openRun(server);
    savedFiles.length = 0;

    click(fileLink(view, "Everything in ingest as one archive"));
    await waitFor("the archive to be handed to the browser", () => savedFiles.length > 0);

    expect(savedFiles).toEqual([{ name: `${FILES_RUN.id}-ingest-attempt1.tar.gz`, url: "blob:12" }]);
  });

  test("a run whose files cannot be listed still shows the run", async () => {
    const server = new FakeServer(FILES_RUN);
    const view = await openRun(server);

    expect(word(one(view.querySelector(".steprow .stamp"), "the step's stamp"))).toBe("succeeded");
    expect(panelLinks(view)).toEqual([]);
    expect(one(view.querySelector('[id="panel-title"]'), "the panel title").textContent).toBe("ingest");
  });
});
