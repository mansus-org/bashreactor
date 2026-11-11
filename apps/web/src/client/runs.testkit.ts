// The machinery both run screens' tests share: a stand-in DOM, a fake server, a clock a test turns,
// and the fixtures. The two test files beside this one hold the describes, one screen each.
//
// The modules come from the bytes the server serves, as in client/logs.test.ts, and they are written
// to a directory of their own so their `./dom.js`, `./api.js`, `./logs.js` and `./run-shared.js`
// specifiers resolve. `./app.js` is the one module this file writes itself: the real shell starts
// rendering the moment it is imported, and a run screen only reaches for it to navigate from the
// run-jump box, which is not what is under test here. The DOM stand-in lives in this file too,
// because Bun has no browser: it takes clicks, it holds focus, and — the part that matters for a
// screen that redraws itself every second — it drops focus to the body when the focused node is
// thrown away, so a rebuild cannot pass unnoticed.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAssets } from "../assets.ts";
import type { Attempt, Run, RunClaim, RunStep, RunSummary } from "./api.ts";
import type { Clock } from "./run-shared.ts";
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

  /** The same map seen through `dataset`, which is how the segmented control records its value. */
  get dataset(): Record<string, string> {
    return new Proxy({} as Record<string, string>, {
      get: (_target, key) => this.attrs.get(`data-${String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`) ?? "",
      set: (_target, key, value: string) => {
        this.attrs.set(`data-${String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, String(value));
        return true;
      },
      has: (_target, key) => this.attrs.has(`data-${String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`),
    });
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

// Bun has no browser, so it has no object URLs. `save()` needs two: it turns the bytes it fetched into
// one and clicks an anchor at it. Recording what came back is how the download tests know a click
// really went to the API and came back as a file, rather than just navigating somewhere.
const savedFiles: { name: string; url: string }[] = [];
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;

/**
 * Puts the stand-in browser on the globals. Every test file in one `bun test` process shares them, and
 * this module is evaluated once for all of them, so a file that uses it calls this at its own top
 * level: another file's teardown may have taken the globals away since the first import put them up.
 */
function installRunsGlobals(): void {
  globals.document = fakeDocument;
  globals.window = { setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args), clearTimeout };
  globals.location = { origin: "http://runs.test", href: "http://runs.test/app/runs" };
  globals.localStorage = storage();
  globals.sessionStorage = storage();
  globals.CSS = { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) };
  globals.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  URL.createObjectURL = ((blob: Blob) => `blob:${blob.size}`) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
}

/**
 * Gives the globals back as they were before the first install, the real `fetch` among them. A file
 * that installed calls this in its `afterAll`: the files after it in the same process include the
 * browser tests, which talk to a real server and get a stub's 500 for every call if one is left behind.
 */
function restoreRunsGlobals(): void {
  for (const controller of controllers) controller.abort();
  for (const stop of cleanups.splice(0)) stop();
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
  for (const [name, value] of Object.entries(installed)) {
    if (value === undefined) delete globals[name];
    else globals[name] = value;
  }
}

installRunsGlobals();
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
for (const name of ["dom", "api", "logs", "run-shared", "ui", "runs-list", "run-page"]) {
  writeFileSync(join(served, `${name}.js`), buildAssets().files.get(`assets/${name}.js`)!.data);
}
writeFileSync(join(served, "app.js"), "export function navigate() {}\n");

const { sign, when, isoInstant, duration } = (await import(join(served, "dom.js"))) as typeof import("./dom.ts");
const { session } = (await import(join(served, "api.js"))) as typeof import("./api.ts");
const { MAX_DRAWN_LINES } = (await import(join(served, "logs.js"))) as typeof import("./logs.ts");
const { POLL_MS, IDLE_POLL_MS } = (await import(join(served, "run-shared.js"))) as typeof import("./run-shared.ts");
const { renderRunsList } = (await import(join(served, "runs-list.js"))) as typeof import("./runs-list.ts");
const { renderRunPage } = (await import(join(served, "run-page.js"))) as typeof import("./run-page.ts");

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

/** Renders one run the way the router does. `renderRunPage` is fire and forget, so this waits for it. */
async function render(run: Run, serving: () => void = () => serve(run), keepOpen = false): Promise<FakeElement> {
  const view = new FakeElement("div");
  const controller = new AbortController();
  controllers.push(controller);
  serving();
  renderRunPage(
    view as unknown as HTMLElement,
    run.id,
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

process.once("exit", () => {
  restoreRunsGlobals();
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

function runFixture(steps: RunStep[], status: string, claim: RunClaim | null = null): Run {
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
    claim,
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

/** The pane stops polling for a finished run, so whatever it reads at the start is all it will ever read. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 200; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}
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
  renderRunPage(
    view as unknown as HTMLElement,
    server.run.id,
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

/**
 * Who holds a run's lock (SPEC 4.7). Nothing on the page can tell a live claim from a stale one
 * without this, and it is the only thing that decides whether Resume can possibly work.
 */
const HELD: RunClaim = { pid: 4242, live: true };
/** The same lock left behind by an engine that died: it blocks nothing, and it is worth taking up. */
const STALE: RunClaim = { pid: 4242, live: false };

/** A run an engine is driving this second, which is every run this server is driving. */
const HELD_RUN = runFixture([step("fetch", "succeeded"), step("render", "running", ["fetch"])], "running", HELD);

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

// ---------- which actions a run is offered ----------
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
  renderRunsList(
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
/** Two digits, for reading a date back off a `Date`'s local getters. */
const pair = (n: number) => String(n).padStart(2, "0");
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
  renderRunsList(view as unknown as HTMLElement, { path: "/runs", parts: ["runs"], query: new URLSearchParams() }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  return view;
}

/** Every element the screen put on the page that carries an inline style. */
const styled = (view: FakeElement): string[] =>
  [...view.descendants()].filter((node) => node.attrs.has("style")).map((node) => `${node.tagName.toLowerCase()}[${node.getAttribute("style")}]`);
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

export {
  installRunsGlobals,
  restoreRunsGlobals,
  FakeElement,
  FakeClock,
  FakeServer,
  MAX_DRAWN_LINES,
  POLL_MS,
  IDLE_POLL_MS,
  FAILED_RUN,
  EVERY_STATUS,
  LIVE,
  LIVE_RETRYING,
  DONE,
  HELD_RUN,
  STALE,
  TWICE_FAILED,
  SIX_FAILED,
  cleanups,
  controllers,
  fakeDocument,
  showTab,
  savedFiles,
  session,
  sign,
  when,
  isoInstant,
  duration,
  serve,
  serveLog,
  reply,
  render,
  renderList,
  openRun,
  liveList,
  waitFor,
  click,
  statusLine,
  runStamp,
  drawnLines,
  alarmOf,
  attemptButtons,
  attemptButton,
  buttonNamed,
  word,
  shape,
  signOf,
  one,
  rowOf,
  stampOf,
  note,
  panelTitle,
  metaLine,
  pair,
  sheet,
  ruleBody,
  summary,
  styled,
  filesServer,
  fileLink,
  panelLinks,
  buildAssets,
  byteLength,
  FILES_RUN,
  ATTEMPT_DIR,
  REPORT,
  CHUNKS,
  LOGFILE,
  FILES_MANIFEST,
  settle,
  T0,
  T1,
  attempt,
  step,
  runFixture,
};
