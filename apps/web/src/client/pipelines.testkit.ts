// The stand-in browser and server the pipeline screens' tests share. It is a `.testkit.ts` file, so
// the asset table knows it is never shipped: what it exists for is a DOM that can lose focus, a
// server whose answers a test chooses, and a clock a test turns instead of sleeping.

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveModules } from "./client.testkit.ts";
import type { PipelineVersion, Run, RunSummary } from "./api.ts";
import type { Clock } from "./run-shared.ts";

class FakeElement {
  readonly tagName: string;
  readonly attrs = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, ((event: FakeEvent) => void)[]>();
  readonly style: Record<string, string> = {};
  parent: FakeElement | null = null;
  value = "";
  checked = false;
  selected = false;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  clientWidth = 800;
  open = false;
  tabIndex = 0;
  private text = "";
  private classes = new Set<string>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

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

  get disabled(): boolean {
    return this.flag("disabled");
  }

  set disabled(value: boolean) {
    this.setFlag("disabled", value);
  }

  get title(): string {
    return this.attrs.get("title") ?? "";
  }

  set title(value: string) {
    this.attrs.set("title", value);
  }

  get classList(): {
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
    toggle(name: string, force?: boolean): boolean;
  } {
    return {
      add: (name) => void this.classes.add(name),
      remove: (name) => void this.classes.delete(name),
      contains: (name) => this.classes.has(name),
      toggle: (name, force) => {
        const on = force ?? !this.classes.has(name);
        if (on) this.classes.add(name);
        else this.classes.delete(name);
        return on;
      },
    };
  }

  get className(): string {
    return [...this.classes].join(" ");
  }

  set className(value: string) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }

  get dataset(): Record<string, string> {
    return new Proxy({} as Record<string, string>, {
      get: (_target, key: string) => this.attrs.get(dataAttribute(key)) ?? "",
      set: (_target, key: string, value: string) => {
        this.attrs.set(dataAttribute(key), value);
        return true;
      },
      has: (_target, key: string) => this.attrs.has(dataAttribute(key)),
    });
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

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  addEventListener(type: string, handler: (event: FakeEvent) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    if (!handlers.includes(handler)) handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type: string, handler: (event: FakeEvent) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    const at = handlers.indexOf(handler);
    if (at >= 0) handlers.splice(at, 1);
  }

  dispatchEvent(type: string, extra: Record<string, unknown> = {}): void {
    const event: FakeEvent = { type, target: this, currentTarget: this, preventDefault: () => {}, ...extra };
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  fire(type: string, extra: Record<string, unknown> = {}): void {
    this.dispatchEvent(type, extra);
  }

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

  insertBefore(node: FakeElement, reference: FakeElement | null): void {
    node.parent?.children.splice(node.parent.children.indexOf(node), 1);
    const at = reference === null ? this.children.length : this.children.indexOf(reference);
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
    node.parent = this;
  }

  remove(): void {
    loseFocusIf(this);
    if (this.parent === null) return;
    const at = this.parent.children.indexOf(this);
    if (at >= 0) this.parent.children.splice(at, 1);
    this.parent = null;
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

  get innerText(): string {
    return this.textContent;
  }

  contains(node: FakeElement | null): boolean {
    for (let at = node; at !== null; at = at.parent) if (at === this) return true;
    return false;
  }

  closest(selector: string): FakeElement | null {
    // eslint-disable-next-line typescript/no-this-alias -- walking from this node is the method.
    let at: FakeElement | null = this;
    for (; at !== null; at = at.parent) {
      if (matches(at, parseCompound(selector.trim()))) return at;
    }
    return null;
  }

  *descendants(): Generator<FakeElement> {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

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

  focus(): void {
    // eslint-disable-next-line typescript/no-this-alias -- the fake document holds the focused node.
    activeElement = this;
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
  }

  get offsetLeft(): number {
    return px(this.style.left);
  }

  get offsetTop(): number {
    return px(this.style.top);
  }

  get offsetWidth(): number {
    return px(this.style.width) || (this.classList.contains("node") ? 200 : 8);
  }

  get offsetHeight(): number {
    return px(this.style.height) || (this.classList.contains("node") ? 72 + 18 * this.querySelectorAll(".port").length : 8);
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    const parent = this.parent?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 };
    const index = this.parent?.children.indexOf(this) ?? 0;
    const placed = this.style.left !== undefined || this.style.top !== undefined;
    return {
      left: parent.left + (placed ? px(this.style.left) : (index + 1) * 3),
      top: parent.top + (placed ? px(this.style.top) : (index + 1) * 2),
      width: this.offsetWidth,
      height: this.offsetHeight,
    };
  }
}

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

function loseFocusIf(node: FakeElement): void {
  if (activeElement === null) return;
  for (let at: FakeElement | null = activeElement; at !== null; at = at.parent) {
    if (at === node) {
      activeElement = null;
      return;
    }
  }
}

const px = (value: string | undefined): number => {
  const n = Number.parseFloat(value ?? "");
  return Number.isNaN(n) ? 0 : n;
};

const dataAttribute = (key: string): string => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

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

const visibilityHandlers: (() => void)[] = [];

const fakeDocument = {
  body: new FakeElement("body"),
  title: "",
  hidden: false,
  get activeElement(): FakeElement {
    return activeElement ?? this.body;
  },
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_namespace: string, tag: string) => new FakeElement(tag),
  getElementById(id: string) {
    return this.body.querySelector(`[id="${id}"]`);
  },
  querySelector(selector: string): FakeElement | null {
    return this.body.querySelector(selector);
  },
  querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector);
  },
  addEventListener(type: string, handler: () => void): void {
    if (type === "visibilitychange") visibilityHandlers.push(handler);
  },
  removeEventListener(type: string, handler: () => void): void {
    if (type !== "visibilitychange") return;
    const at = visibilityHandlers.indexOf(handler);
    if (at >= 0) visibilityHandlers.splice(at, 1);
  },
};

/** Switch tabs the way the browser does: a live view stops reading, or starts again. */
export function setHidden(hidden: boolean): void {
  if (fakeDocument.hidden === hidden) return;
  fakeDocument.hidden = hidden;
  for (const handler of visibilityHandlers.slice()) handler();
}

const storage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
};

const fakeLocation = { href: "http://pipelines.test/app/pipelines", origin: "http://pipelines.test", pathname: "/app/pipelines", search: "", hash: "" };
export const historyCalls: { kind: "replace" | "push"; href: string }[] = [];

const globals = globalThis as unknown as Record<string, unknown>;
const installed = {
  document: globals.document,
  window: globals.window,
  location: globals.location,
  history: globals.history,
  localStorage: globals.localStorage,
  sessionStorage: globals.sessionStorage,
  CSS: globals.CSS,
  ResizeObserver: globals.ResizeObserver,
  requestAnimationFrame: globals.requestAnimationFrame,
  fetch: globals.fetch,
  URL: globals.URL,
};

const fakeWindow = {
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
  clearTimeout,
  addEventListener(): void {},
  removeEventListener(): void {},
};

const fakeHistory = {
  replaceState(_state: unknown, _title: string, href: string) {
    historyCalls.push({ kind: "replace", href });
    navigateLocation(href);
  },
  pushState(_state: unknown, _title: string, href: string) {
    historyCalls.push({ kind: "push", href });
    navigateLocation(href);
  },
};

const fakeCss = { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) };

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * Puts the stand-in browser back on the globals. Every test file in one `bun test` process shares
 * them, and this module is evaluated once for all of them, so a file that uses it calls this at its
 * own top level: another file's teardown may have taken the globals away since the first import put
 * them up.
 */
export function installPipelinesGlobals(): void {
  globals.document = fakeDocument;
  globals.window = fakeWindow;
  globals.location = fakeLocation;
  globals.history = fakeHistory;
  globals.localStorage = storage();
  globals.sessionStorage = storage();
  globals.CSS = fakeCss;
  globals.ResizeObserver = FakeResizeObserver;
  globals.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  fakeDocument.hidden = false;
  activeElement = null;
  visibilityHandlers.length = 0;
  historyCalls.length = 0;
}

installPipelinesGlobals();

function navigateLocation(href: string): void {
  const url = new URL(href, fakeLocation.origin);
  fakeLocation.href = url.href;
  fakeLocation.pathname = url.pathname;
  fakeLocation.search = url.search;
  fakeLocation.hash = url.hash;
}

/** Set the address a screen reads, the way the router would before it draws. */
export function setLocation(href: string): void {
  navigateLocation(href);
}

const served = serveModules(["pipelines", "pipeline-page", "start-run"]);
writeFileSync(
  join(served, "app.js"),
  `export const navigations = [];
export function navigate(path, options = {}) {
  navigations.push({ path, options });
  const href = "/app" + (path === "/" ? "" : path);
  if (options.replace) history.replaceState({}, "", href);
  else history.pushState({}, "", href);
}
`,
);

export const dom = (await import(join(served, "dom.js"))) as typeof import("./dom.ts");
export const apiModule = (await import(join(served, "api.js"))) as typeof import("./api.ts");
export const ui = (await import(join(served, "ui.js"))) as typeof import("./ui.ts");
export const pipelinesModule = (await import(join(served, "pipelines.js"))) as typeof import("./pipelines.ts");
export const pipelinePageModule = (await import(join(served, "pipeline-page.js"))) as typeof import("./pipeline-page.ts");
export const appStub = (await import(join(served, "app.js"))) as { navigations: { path: string; options: { replace?: boolean } }[] };
export const session = apiModule.session;

export interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  headers: { get: (name: string) => string | null };
  clone: () => FakeResponse;
}

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): FakeResponse {
  const response: FakeResponse = {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    clone: () => response,
  };
  return response;
}

export interface PipelineFixture {
  name: string;
  latest: number;
  versions: PipelineVersion[];
}

/** A stored pipeline version whose parsed form is the core parser's shape. */
export function pipelineFixture(name: string, versions: PipelineVersion[]): PipelineFixture {
  return { name, latest: versions[versions.length - 1]!.version, versions };
}

export function version(
  name: string,
  number: number,
  options: {
    yaml?: string;
    description?: string;
    inputs?: { name: string; type: string; description?: string; default?: unknown }[];
    outputs?: { name: string; step: string; output: string }[];
    sha?: string;
    created?: string;
  } = {},
): PipelineVersion {
  const inputs = (options.inputs ?? []).map((input) => ({
    name: input.name,
    type: input.type,
    description: input.description ?? "",
    ...(Object.prototype.hasOwnProperty.call(input, "default") ? { default: input.default } : {}),
  }));
  const outputs = (options.outputs ?? []).map((output) => ({
    name: output.name,
    ref: { kind: "step_output" as const, step: output.step, output: output.output },
  }));
  return {
    name,
    version: number,
    sha256: options.sha ?? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    created_at: options.created ?? new Date(Date.UTC(2026, 10, 5, 20, 0, 0)).toISOString(),
    yaml: options.yaml ?? `name: ${name}\nsteps: {}\n`,
    parsed: { name, description: options.description ?? "", max_parallel: 4, inputs, steps: [], outputs },
  };
}

export function summary(id: string, status: string, extra: Partial<RunSummary> = {}): RunSummary {
  return {
    id,
    pipeline: "word-report",
    status,
    created_at: "2026-11-04T10:00:00Z",
    finished_at: status === "running" ? null : "2026-11-04T10:00:05Z",
    cancel_requested_at: null,
    step_counts: { total: 2, pending: 0, running: 0, waiting_retry: 0, succeeded: 2, failed: 0, skipped: 0, cancelled: 0 },
    pipeline_version: 1,
    ...extra,
  };
}

const STORE = new Map<string, FakeResponse>();

export class FakeServer {
  pipelines: PipelineFixture[] = [];
  runs: RunSummary[] = [];
  blocks = new Map<string, string>();
  started: Run | null = null;
  /** Bodies POSTed to `/v1/runs`, so a Start dialog's request can be read back. */
  posted: unknown[] = [];
  calls: string[] = [];
  active = 0;
  mostActive = 0;
  delayMs = 0;
  /** A route key like `GET /v1/runs`, made to answer a 500 with this message. */
  failures = new Map<string, string>();

  install(): void {
    globals.fetch = (async (href: string, init?: { method?: string; body?: string }) => {
      const url = new URL(String(href));
      const method = init?.method ?? "GET";
      this.active += 1;
      this.mostActive = Math.max(this.mostActive, this.active);
      this.calls.push(`${method} ${url.pathname}${url.search}`);
      try {
        if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        const failure = this.failures.get(`${method} ${url.pathname}`);
        if (failure !== undefined) return reply({ code: "internal_error", message: failure }, 500);
        return await this.answer(url, method, init);
      } finally {
        this.active -= 1;
      }
    }) as unknown as typeof fetch;
  }

  count(match: string): number {
    return this.calls.filter((call) => call.includes(match)).length;
  }

  private async answer(url: URL, method: string, init?: { body?: string }): Promise<FakeResponse> {
    if (method === "POST" && url.pathname === "/v1/runs") {
      this.posted.push(JSON.parse(init?.body ?? "{}"));
      return reply(this.started ?? runFixture(), 201);
    }
    if (method === "GET" && url.pathname === "/v1/pipelines") {
      return reply({
        pipelines: this.pipelines.map((pipeline) => ({ name: pipeline.name, latest: pipeline.latest, versions: pipeline.versions.length })),
      });
    }
    if (method === "GET" && url.pathname === "/v1/runs") {
      const pipeline = url.searchParams.get("pipeline");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const cursor = url.searchParams.get("cursor");
      const all = this.runs
        .filter((run) => pipeline === null || run.pipeline === pipeline)
        .toSorted((a, b) => b.id.localeCompare(a.id));
      const start = cursor === null ? 0 : Math.max(0, all.findIndex((run) => run.id === cursor) + 1);
      const page = all.slice(start, start + limit);
      const next = start + limit < all.length ? page[page.length - 1]!.id : null;
      return reply(page, 200, next === null ? {} : { "x-next-cursor": next });
    }
    const content = /^\/v1\/blocks\/([^/]+)\/(\d+)\/content$/.exec(url.pathname);
    if (method === "GET" && content !== null) {
      const key = `${content[1]}@${content[2]}`;
      const source = this.blocks.get(key);
      if (source === undefined) {
        return reply({ code: "block_not_found", message: `block "${content[1]}" has no version ${content[2]}` }, 404);
      }
      return reply(source, 200, { "x-block-sha256": "abc" });
    }
    const versionRoute = /^\/v1\/pipelines\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && versionRoute !== null) {
      const pipeline = this.pipelines.find((entry) => entry.name === decodeURIComponent(versionRoute[1]!));
      if (pipeline === undefined) {
        return reply({ code: "pipeline_not_found", message: `pipeline "${versionRoute[1]}" has no versions` }, 404);
      }
      const wanted = versionRoute[2]!;
      const found =
        wanted === "latest"
          ? pipeline.versions.find((entry) => entry.version === pipeline.latest)
          : pipeline.versions.find((entry) => entry.version === Number(wanted));
      if (found === undefined) {
        return reply({ code: "pipeline_not_found", message: `pipeline "${pipeline.name}@${wanted}" does not exist` }, 404);
      }
      return reply(found);
    }
    const listRoute = /^\/v1\/pipelines\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && listRoute !== null) {
      const pipeline = this.pipelines.find((entry) => entry.name === decodeURIComponent(listRoute[1]!));
      if (pipeline === undefined) {
        return reply({ code: "pipeline_not_found", message: `pipeline "${listRoute[1]}" has no versions` }, 404);
      }
      return reply({
        name: pipeline.name,
        latest: pipeline.latest,
        versions: pipeline.versions.map(({ name, version: number, sha256, created_at }) => ({ name, version: number, sha256, created_at })),
      });
    }
    return STORE.get(`${method} ${url.pathname}`) ?? reply({ code: "internal_error", message: `nothing answers ${method} ${url.pathname}` }, 500);
  }
}

export function runFixture(): Run {
  return {
    schema: 1,
    id: "20261105T201258Z-f1549287",
    pipeline: "word-report",
    status: "running",
    created_at: "2026-11-05T20:12:58Z",
    finished_at: null,
    cancel_requested_at: null,
    inputs: {},
    outputs: null,
    steps: {},
    claim: null,
    pipeline_version: 1,
  };
}

export class FakeClock implements Clock {
  private hand = 0;
  private readonly armed: { at: number; run: () => void }[] = [];

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

  set(instant: string): void {
    this.hand = Date.parse(instant);
  }

  async advance(ms: number): Promise<void> {
    this.hand += ms;
    for (;;) {
      const due = this.armed.filter((job) => job.at <= this.hand).toSorted((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.armed.splice(this.armed.indexOf(due), 1);
      due.run();
      await settle();
    }
    await settle();
  }
}

/** Let every already-resolved promise and its continuations run. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 40; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function waitFor(what: string, done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 400; turn++) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const controllers: AbortController[] = [];

export function route(path: string, query = ""): import("./app.ts").Route {
  setLocation(`http://pipelines.test/app${path}${query === "" ? "" : `?${query}`}`);
  return {
    path,
    parts: path.split("/").filter((part) => part !== ""),
    query: new URLSearchParams(query),
  };
}

export async function openPipelines(server: FakeServer, scope: "read" | "write" = "write"): Promise<FakeElement> {
  session.identity = { name: "tester", scope, admin: false };
  server.install();
  const view = new FakeElement("div");
  const controller = new AbortController();
  controllers.push(controller);
  await pipelinesModule.renderPipelines(view as unknown as HTMLElement, route("/pipelines"), controller.signal);
  return view;
}

export async function openPipeline(
  server: FakeServer,
  name: string,
  query = "",
  options: { scope?: "read" | "write"; clock?: Clock } = {},
): Promise<{ view: FakeElement; controller: AbortController }> {
  session.identity = { name: "tester", scope: options.scope ?? "write", admin: false };
  server.install();
  const view = new FakeElement("div");
  const controller = new AbortController();
  controllers.push(controller);
  await pipelinePageModule.renderPipelinePage(
    view as unknown as HTMLElement,
    route(`/pipelines/${name}`, query),
    controller.signal,
    options.clock,
  );
  return { view, controller };
}

export function closeAll(): void {
  for (const controller of controllers) controller.abort();
  controllers.length = 0;
  activeElement = null;
  // The next test file may talk to a real server, so the stub must not outlive this screen's tests.
  if (installed.fetch === undefined) delete globals.fetch;
  else globals.fetch = installed.fetch;
}

/**
 * Gives the globals back as they were before the first install. A file that installed calls this in
 * its `afterAll`: the files after it in the same process include the browser tests, which talk to a
 * real server and get a stub's 500 for every call if one is left behind.
 */
export function restorePipelinesGlobals(): void {
  closeAll();
  for (const [name, value] of Object.entries(installed)) {
    if (value === undefined) delete globals[name];
    else globals[name] = value;
  }
}

process.once("exit", () => {
  restorePipelinesGlobals();
  rmSync(served, { recursive: true, force: true });
});

export { FakeElement, setFocus };
