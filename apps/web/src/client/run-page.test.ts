// One run's page: its header and actions, the timeline, the tabs, the log, the graph and deleting a
// finished run. The screen comes from the bytes the server serves and the server from a stand-in that
// records every route it was asked for, so a refusal can be arranged between a read and a click.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAssets } from "../assets.ts";
import type { Attempt, Run, RunClaim, RunStep } from "./api.ts";
import type { Clock } from "./run-shared.ts";
import type { State as DomState } from "./dom.ts";
import { FakeElement, installDom, serveModules, uninstallDom } from "./client.testkit.ts";

const served = serveModules(["run-page", "ui", "timeline", "graph", "library", "model"]);
// The real shell starts rendering when it is imported; the run page only reaches for its navigate.
writeFileSync(join(served, "app.js"), "export function navigate(path) { globalThis.navigateTo = path; }\n");

const dom = installDom({ href: "http://runs.test/app/runs/20261104T101500Z-3fa9c2d1" });
const doc = dom.document;
(dom.document as unknown as { hidden: boolean }).hidden = false;

const visibilityHandlers: (() => void)[] = [];
const docEvents = doc as unknown as {
  addEventListener: (type: string, handler: () => void) => void;
  removeEventListener: (type: string, handler: () => void) => void;
};
docEvents.addEventListener = (type, handler) => {
  if (type === "visibilitychange") visibilityHandlers.push(handler);
};
docEvents.removeEventListener = (type, handler) => {
  if (type !== "visibilitychange") return;
  const at = visibilityHandlers.indexOf(handler);
  if (at >= 0) visibilityHandlers.splice(at, 1);
};

// Every fake server below goes onto the global `fetch`; the real one is put back in afterAll, because
// the browser tests share this process and talk to a real server through it.
const realFetch = globalThis.fetch;
const realFocus = FakeElement.prototype.focus;
const realReplace = FakeElement.prototype.replaceChildren;
const realRemoveAttribute = (FakeElement.prototype as unknown as { removeAttribute?: (name: string) => void }).removeAttribute;
FakeElement.prototype.focus = function focus(this: FakeElement): void {
  doc.activeElement = this;
};
FakeElement.prototype.replaceChildren = function replaceChildren(this: FakeElement, ...nodes: (FakeElement | string)[]): void {
  const active = doc.activeElement;
  if (active !== null && this.contains(active)) doc.activeElement = doc.body;
  realReplace.apply(this, nodes);
};
(FakeElement.prototype as unknown as { removeAttribute(name: string): void }).removeAttribute = function removeAttribute(
  this: FakeElement,
  name: string,
): void {
  this.attrs.delete(name);
};
(FakeElement.prototype as unknown as { click(): void }).click = function click(this: FakeElement): void {
  this.fire("click");
};
(FakeElement.prototype as unknown as { remove(): void }).remove = function remove(this: FakeElement): void {
  const parent = this.parent;
  if (parent === null) return;
  const at = parent.children.indexOf(this);
  if (at >= 0) parent.children.splice(at, 1);
  this.parent = null;
};
Object.defineProperty(FakeElement.prototype, "childElementCount", {
  configurable: true,
  get(this: FakeElement): number {
    return this.children.length;
  },
});
Object.defineProperty(FakeElement.prototype, "firstElementChild", {
  configurable: true,
  get(this: FakeElement): FakeElement | null {
    return this.children[0] ?? null;
  },
});
Object.defineProperty(FakeElement.prototype, "title", {
  configurable: true,
  get(this: FakeElement): string {
    return this.getAttribute("title") ?? "";
  },
  set(this: FakeElement, value: string): void {
    this.setAttribute("title", String(value));
  },
});

const globals = globalThis as unknown as Record<string, unknown>;
globals.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
const location = globals.location as unknown as Record<string, string>;
const history = globals.history as unknown as { pushState: (...args: unknown[]) => void; replaceState: (...args: unknown[]) => void };
function setHref(href: string): void {
  const url = new URL(href, location.href);
  location.href = url.href;
  location.origin = url.origin;
  location.pathname = url.pathname;
  location.search = url.search;
  location.hash = url.hash;
}
history.pushState = (_state: unknown, _title: unknown, href?: unknown) => {
  if (typeof href === "string") setHref(href);
};
history.replaceState = (_state: unknown, _title: unknown, href?: unknown) => {
  if (typeof href === "string") setHref(href);
};

const savedFiles: { name: string; url: string }[] = [];
const realCreate = doc.createElement.bind(doc);
doc.createElement = ((tag: string) => {
  const node = realCreate(tag);
  if (tag === "a") {
    const anchor = node as unknown as { download: string; href: string; click: () => void };
    anchor.download = "";
    anchor.href = "";
    anchor.click = () => void savedFiles.push({ name: anchor.download, url: anchor.href });
  }
  return node;
}) as typeof doc.createElement;
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
URL.createObjectURL = ((blob: Blob) => `blob:${blob.size}`) as typeof URL.createObjectURL;
URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

const { renderRunPage } = (await import(join(served, "run-page.js"))) as typeof import("./run-page.ts");
const { session } = (await import(join(served, "api.js"))) as typeof import("./api.ts");
const { exactTime, formatBytes } = (await import(join(served, "ui.js"))) as typeof import("./ui.ts");
session.identity = { name: "tester", scope: "write", admin: false };
const { sign, when, isoInstant } = (await import(join(served, "dom.js"))) as typeof import("./dom.ts");
const { MAX_DRAWN_LINES, MAX_LINE_CHARS } = (await import(join(served, "logs.js"))) as typeof import("./logs.ts");
const { POLL_MS } = (await import(join(served, "run-shared.js"))) as typeof import("./run-shared.ts");

afterAll(() => {
  for (const controller of controllers) controller.abort();
  FakeElement.prototype.focus = realFocus;
  FakeElement.prototype.replaceChildren = realReplace;
  const proto = FakeElement.prototype as unknown as Record<string, unknown>;
  if (realRemoveAttribute === undefined) delete proto.removeAttribute;
  else proto.removeAttribute = realRemoveAttribute;
  delete proto.click;
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
  globalThis.fetch = realFetch;
  uninstallDom(dom);
  rmSync(served, { recursive: true, force: true });
});

// ---------- the stand-in server ----------

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  blob: () => Promise<Blob>;
  headers: { get: (name: string) => string | null };
  clone: () => FakeResponse;
}

const reply = (body: unknown, status = 200): FakeResponse => {
  const response: FakeResponse = {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    blob: async () => new Blob([JSON.stringify(body)]),
    headers: { get: () => null },
    clone: () => response,
  };
  return response;
};

const replyText = (text: string, headers: Record<string, string> = {}): FakeResponse => {
  const response: FakeResponse = {
    ok: true,
    status: 200,
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
    blob: async () => new Blob([text]),
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    clone: () => response,
  };
  return response;
};

const replyBytes = (text: string, filename: string): FakeResponse => {
  const response: FakeResponse = {
    ok: true,
    status: 200,
    json: async (): Promise<unknown> => {
      throw new TypeError("this is a file, not JSON");
    },
    text: async () => text,
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

type Action = "cancel" | "retry" | "resume" | "delete";

class FakeServer {
  run: Run;
  logs: Record<string, string> = {};
  chunkBytes = 1_000_000;
  logDelayMs = 0;
  files: unknown | null = null;
  downloads: Record<string, string> = {};
  pipelineYaml: string | null = null;
  blocks: Record<string, string> = {};
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

  get polls(): number {
    return this.asked.filter((entry) => entry === `GET ${this.runPath}`).length;
  }

  stop(): void {
    this.dead = true;
  }

  live(): void {
    this.dead = false;
  }

  refuse(action: Action, code: string, message: string, status = 409): void {
    const method = action === "delete" ? "DELETE" : "POST";
    this.routes.set(`${method} ${this.runPath}${action === "delete" ? "" : `/${action}`}`, () => reply({ code, message }, status));
  }

  allow(action: Action, after?: Run): void {
    const method = action === "delete" ? "DELETE" : "POST";
    this.routes.set(`${method} ${this.runPath}${action === "delete" ? "" : `/${action}`}`, () =>
      reply(action === "delete" ? { deleted: this.run.id } : (after ?? this.run)),
    );
  }

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
    if (key === `DELETE ${this.runPath}`) return reply({ deleted: this.run.id });
    if (key === `GET ${this.runPath}/files`) {
      return this.files === null
        ? reply({ code: "not_found", message: `run "${this.run.id}" has no files listed` }, 404)
        : reply(this.files);
    }
    if (key === `GET ${this.runPath}/file`) {
      const path = url.searchParams.get("path") ?? "";
      if (path === "pipeline.yaml" && this.pipelineYaml !== null) return replyText(this.pipelineYaml);
      const text = this.downloads[path];
      return text === undefined
        ? reply({ code: "file_not_found", message: `no file ${path} in run "${this.run.id}"` }, 404)
        : replyBytes(text, path.slice(path.lastIndexOf("/") + 1));
    }
    if (key === `GET ${this.runPath}/archive`) {
      const stepId = url.searchParams.get("step");
      const attemptNo = url.searchParams.get("attempt");
      const name =
        stepId === null ? this.run.id : `${this.run.id}-${stepId}${attemptNo === null ? "" : `-attempt${attemptNo}`}`;
      return replyBytes(this.downloads.archive ?? "", `${name}.tar.gz`);
    }
    const block = /^\/v1\/blocks\/([^/]+)\/(\d+)\/content$/.exec(url.pathname);
    if (block !== null) {
      const source = this.blocks[`${block[1]}@${block[2]}`];
      return source === undefined
        ? reply({ code: "block_not_found", message: `no block ${block[1]}@${block[2]}` }, 404)
        : replyText(source, { "x-block-sha256": "0".repeat(64) });
    }
    const log = /^\/v1\/runs\/[^/]+\/logs\/([^/]+)\/(\d+)$/.exec(url.pathname);
    if (log !== null) return this.logChunk(url, log[1]!, log[2]!);
    if (key.endsWith("/cancel") || key.endsWith("/retry") || key.endsWith("/resume")) return reply(this.run);
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

class FakeClock {
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
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function showTab(hidden: boolean): void {
  if ((doc as unknown as { hidden: boolean }).hidden === hidden) return;
  (doc as unknown as { hidden: boolean }).hidden = hidden;
  for (const handler of visibilityHandlers.slice()) handler();
}

const controllers: AbortController[] = [];
let previous: AbortController | null = null;

async function openRun(
  server: FakeServer,
  clock?: Clock,
  options: { tab?: string; step?: string; attempt?: number } = {},
): Promise<FakeElement> {
  previous?.abort();
  const view = new FakeElement("div");
  const controller = new AbortController();
  controllers.push(controller);
  previous = controller;
  const params = new URLSearchParams();
  if (options.tab !== undefined) params.set("tab", options.tab);
  if (options.step !== undefined) params.set("step", options.step);
  if (options.attempt !== undefined) params.set("attempt", String(options.attempt));
  const search = params.toString();
  setHref(`http://runs.test/app/runs/${server.run.id}${search === "" ? "" : `?${search}`}`);
  server.install();
  void renderRunPage(view as unknown as HTMLElement, server.run.id, controller.signal, clock);
  await waitFor("the timeline", () => {
    const rows = view.querySelectorAll(".timeline__row");
    return rows.length > 0 && rows.every((row) => (row.querySelector(".timeline__step")?.getAttribute("aria-label") ?? "") !== "");
  });
  return view;
}

async function waitFor(what: string, done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 500; turn++) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 200; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const click = (node: FakeElement): void => void node.fire("click");
const one = (node: FakeElement | null, what: string): FakeElement => {
  if (node === null) throw new Error(`the run screen drew no ${what}`);
  return node;
};
const text = (node: FakeElement): string => node.textContent.trim();
const shape = (node: FakeElement): string => node.querySelector("svg path")?.getAttribute("d") ?? "";
const signOf = (state: DomState): string => shape(sign(state) as unknown as FakeElement);

const timelineRow = (view: FakeElement, stepId: string): FakeElement =>
  one(view.querySelector(`.timeline__row[data-step="${stepId}"]`), `timeline row ${stepId}`);
const timelineButton = (view: FakeElement, stepId: string): FakeElement =>
  one(timelineRow(view, stepId).querySelector(".timeline__step"), `timeline button ${stepId}`);
const stepTableRow = (view: FakeElement, stepId: string): FakeElement =>
  one(view.querySelector(`.run-steps tbody tr[data-step="${stepId}"]`), `steps table row ${stepId}`);
const stampOf = (view: FakeElement, stepId: string): FakeElement =>
  one(stepTableRow(view, stepId).querySelector(".stamp--status"), `stamp for ${stepId}`);
const action = (view: FakeElement, name: string): FakeElement =>
  one(view.querySelector(`[data-action="${name}"]`), `the ${name} action`);
const buttonNamed = (view: FakeElement, label: string): FakeElement =>
  one(view.querySelectorAll("button").find((node) => node.textContent.trim() === label) ?? null, `the ${label} button`);
const tabButton = (view: FakeElement, label: string): FakeElement =>
  one(view.querySelectorAll(".tab").find((node) => node.textContent.trim() === label) ?? null, `the ${label} tab`);
function openTab(view: FakeElement, label: string): void {
  click(tabButton(view, label));
}
const selectedTab = (view: FakeElement): string =>
  one(view.querySelector('.tab[aria-selected="true"]'), "the selected tab").textContent.trim();
const drawnLines = (view: FakeElement): string[] => view.querySelectorAll(".log__text").map((node) => node.textContent);
const statusLine = (view: FakeElement): string => one(view.querySelector(".log-status"), "the log status line").textContent;
const bytesLine = (view: FakeElement): string => one(view.querySelector(".log-bytes"), "the bytes read").textContent;
const alarmOf = (view: FakeElement): FakeElement => one(view.querySelector(".run-alarm"), "the alarm");
const attemptButtons = (view: FakeElement): FakeElement[] => view.querySelectorAll(".attempts .segmented__btn");
const attemptButton = (view: FakeElement, index: number): FakeElement =>
  one(attemptButtons(view)[index] ?? null, `attempt button ${index + 1}`);
const runStamp = (view: FakeElement): string => text(one(view.querySelector(".id-line .stamp--status"), "the run's stamp"));
const metaValue = (view: FakeElement, label: string): FakeElement => {
  const labelNode = one(
    view.querySelectorAll(".meta-line__label").find((node) => node.textContent === label) ?? null,
    `the ${label} label`,
  );
  const parent = labelNode.parent as FakeElement;
  const index = parent.children.indexOf(labelNode);
  return one(parent.children[index + 1] ?? null, `the ${label} value`);
};
const fileLink = (view: FakeElement, label: string): FakeElement =>
  one(view.querySelectorAll("[data-download]").find((node) => node.getAttribute("data-download") === label) ?? null, `the ${label} link`);
const downloadFor = (view: FakeElement, path: string): FakeElement =>
  one(
    view
      .querySelectorAll("[data-download]")
      .find((node) => (node.getAttribute("href") ?? "").includes(encodeURIComponent(path))) ?? null,
    `the download link for ${path}`,
  );

// ---------- the runs these tests are about ----------

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

function step(id: string, status: string, needs: string[] = []): RunStep {
  const started = status !== "pending" && status !== "skipped";
  return {
    id,
    name: id,
    status,
    block: { uses: `${id}@1`, name: id, sha256: "0".repeat(64) },
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

const FAILED_RUN = runFixture(
  [step("fetch", "succeeded"), step("render", "failed", ["fetch"]), step("report", "skipped", ["render"])],
  "failed",
);

const EVERY_STATUS = runFixture(
  ["pending", "running", "waiting_retry", "succeeded", "failed", "skipped", "cancelled", "interrupted"].map((status) =>
    step(status, status),
  ),
  "running",
);

const LIVE = runFixture([step("fetch", "succeeded"), step("render", "running", ["fetch"])], "running");
const DONE = runFixture([step("fetch", "succeeded"), step("render", "succeeded", ["fetch"])], "succeeded");
const HELD: RunClaim = { pid: 4242, live: true };
const STALE: RunClaim = { pid: 4242, live: false };
const HELD_RUN = runFixture([step("fetch", "succeeded"), step("render", "running", ["fetch"])], "running", HELD);
const SIX_FAILED = runFixture(
  [
    step("fetch", "succeeded"),
    ...["a", "b", "c", "d", "e", "f"].map((id) => step(id, "failed", ["fetch"])),
    step("report", "skipped", ["a", "b", "c", "d", "e", "f"]),
  ],
  "failed",
);

const blockSource = (name: string): string => `#!/usr/bin/env bash
# ---
# name: ${name}
# description: The ${name} block.
# inputs:
#   lines:
#     type: integer
#   corpus:
#     type: string
# outputs:
#   corpus:
#     type: string
#   total_words:
#     type: integer
# ---
echo done
`;

const GRAPH_YAML = `name: word-report
description: Count the words.
steps:
  fetch:
    uses: fetch@1
    with:
      lines: 3
  render:
    uses: render@1
    needs: [fetch]
`;

function graphServer(run: Run, yaml: string, blocks: Record<string, string> = {}): FakeServer {
  const server = new FakeServer(run);
  server.pipelineYaml = yaml;
  server.blocks = blocks;
  return server;
}

// ---------- the files a run can hand out ----------

const FILES_RUN = runFixture([step("ingest", "succeeded")], "succeeded");
const ATTEMPT_DIR = "steps/ingest/attempts/1";
const REPORT = `${ATTEMPT_DIR}/outputs/report.html`;
const CHUNKS = `${ATTEMPT_DIR}/outputs/chunks/chunks.jsonl`;
const LOGFILE = `${ATTEMPT_DIR}/log/output.txt`;
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

// ---------- what the header says ----------

describe("the header of a run", () => {
  test("the pipeline is the title, and the breadcrumb ends at the run's id", async () => {
    const view = await openRun(new FakeServer(FAILED_RUN));

    expect(text(one(view.querySelector(".title"), "the title"))).toBe("word-report");
    const crumbs = one(view.querySelector(".crumbs"), "the breadcrumbs");
    expect(crumbs.querySelectorAll("a").map((node) => node.textContent)).toEqual(["Runs", "word-report"]);
    expect(one(crumbs.querySelector(".crumbs__current"), "the current crumb").textContent).toBe(FAILED_RUN.id);
    expect(one(view.querySelector(".id-line"), "the id line").textContent).toContain(FAILED_RUN.id);
    expect(runStamp(view)).toBe("failed");
  });

  test("the version links to the pipeline at that version, and is left out when there is none", async () => {
    const versioned = { ...DONE, pipeline_version: 3 };
    const view = await openRun(new FakeServer(versioned));
    const version = metaValue(view, "Version");
    expect(version.textContent).toBe("v3");
    expect(version.querySelector("a")?.getAttribute("href")).toBe("/app/pipelines/word-report?version=3");

    const plain = await openRun(new FakeServer({ ...DONE, pipeline_version: null }));
    expect(plain.querySelectorAll(".meta-line__label").some((node) => node.textContent === "Version")).toBe(false);
  });

  test("a cancel request is stamped beside the state", async () => {
    const view = await openRun(new FakeServer({ ...LIVE, cancel_requested_at: T1 }));
    expect(one(view.querySelector(".id-line"), "the id line").textContent).toContain("cancel requested");
  });

  test("the meta line has relative times with the exact instant, steps, and a duration", async () => {
    const clock = new FakeClock();
    clock.set("2026-11-04T10:19:07Z");
    const view = await openRun(new FakeServer(LIVE), clock);

    expect(one(metaValue(view, "Started").querySelector("time"), "the started time").getAttribute("title")).toBe(
      exactTime(LIVE.created_at),
    );
    expect(metaValue(view, "Started").textContent).toBe("4 min ago");
    expect(metaValue(view, "Duration").textContent).toBe("4 m 07 s");
    expect(metaValue(view, "Steps").textContent).toBe("1 / 2");
    expect(metaValue(view, "Finished").hidden).toBe(true);
    expect(one(view.querySelector(".meta-line"), "the meta line").textContent).not.toContain("· ·");

    const finishedClock = new FakeClock();
    finishedClock.set("2026-11-04T13:00:00Z");
    const finished = await openRun(new FakeServer(DONE), finishedClock);
    expect(metaValue(finished, "Finished").textContent).not.toBe("");
    expect(metaValue(finished, "Duration").textContent).toBe("41 s");
    expect(finishedClock.waking).toBe(0);
  });
});

describe("the state of every step", () => {
  test("the timeline keeps a step's sign and accessible word, and every status has its own sign", async () => {
    const view = await openRun(new FakeServer(EVERY_STATUS));
    const shapes = new Map<string, string>();
    for (const status of Object.keys(EVERY_STATUS.steps)) {
      const button = timelineButton(view, status);
      expect(button.getAttribute("aria-label")).toBe(`${status}, ${status}`);
      expect(shape(button)).not.toBe("");
      shapes.set(status, shape(button));
    }
    expect(new Set(shapes.values()).size).toBe(Object.keys(EVERY_STATUS.steps).length);
    expect(shapes.get("failed")).toBe(signOf("failed"));
  });

  test("a skipped step says skipped, not pending, in the steps table", async () => {
    const view = await openRun(new FakeServer(FAILED_RUN));
    openTab(view, "Steps");

    expect(text(stampOf(view, "report"))).toBe("skipped");
    expect(shape(stampOf(view, "report"))).toBe(signOf("skipped"));
    expect(text(stampOf(view, "fetch"))).toBe("succeeded");
    expect(text(stampOf(view, "render"))).toBe("failed");
  });

  test("a status this build has never seen falls back to pending rather than a word with no shape", async () => {
    const view = await openRun(new FakeServer(runFixture([step("fetch", "approved")], "approved")));
    openTab(view, "Steps");

    expect(text(stampOf(view, "fetch"))).toBe("pending");
    expect(shape(stampOf(view, "fetch"))).toBe(signOf("pending"));
    expect(runStamp(view)).toBe("pending");
    expect(timelineButton(view, "fetch").getAttribute("aria-label")).toBe("fetch, pending");
  });
});

// ---------- what a run is offered ----------

describe("the actions a run is offered", () => {
  test("a run an engine holds is offered cancel, and not resume or retry", async () => {
    const view = await openRun(new FakeServer(HELD_RUN));
    expect(action(view, "resume").hidden).toBe(true);
    expect(action(view, "retry").hidden).toBe(true);
    expect(action(view, "cancel").hidden).toBe(false);
    expect(action(view, "delete").hidden).toBe(true);
    expect(action(view, "download").hidden).toBe(false);
  });

  test("a run whose engine went away is offered resume", async () => {
    const view = await openRun(new FakeServer({ ...HELD_RUN, claim: STALE }));
    expect(action(view, "resume").hidden).toBe(false);
  });

  test("a run that succeeded is offered download and delete, and no way to run it again", async () => {
    const view = await openRun(new FakeServer(DONE));
    expect(action(view, "cancel").hidden).toBe(true);
    expect(action(view, "resume").hidden).toBe(true);
    expect(action(view, "retry").hidden).toBe(true);
    expect(action(view, "download").hidden).toBe(false);
    expect(action(view, "delete").hidden).toBe(false);
  });

  test("failed and cancelled runs are offered retry", async () => {
    expect(action(await openRun(new FakeServer(FAILED_RUN)), "retry").hidden).toBe(false);
    expect(
      action(await openRun(new FakeServer(runFixture([step("render", "cancelled")], "cancelled"))), "retry").hidden,
    ).toBe(false);
  });

  test("a read token is offered no action that can only answer 403", async () => {
    session.identity = { name: "reader", scope: "read", admin: false };
    try {
      const view = await openRun(new FakeServer(DONE));
      expect(action(view, "delete").hidden).toBe(true);
      expect(action(view, "retry").hidden).toBe(true);
      expect(action(view, "download").hidden).toBe(false);
    } finally {
      session.identity = { name: "tester", scope: "write", admin: false };
    }
  });

  test("resume arrives on the poll that finds the engine gone", async () => {
    const server = new FakeServer(HELD_RUN);
    const view = await openRun(server);
    expect(action(view, "resume").hidden).toBe(true);

    server.run = { ...HELD_RUN, claim: STALE };
    const polls = server.polls;
    await waitFor("a poll", () => server.polls > polls);
    expect(action(view, "resume").hidden).toBe(false);
  });
});

// ---------- what a refused action does ----------

describe("an action the server refuses", () => {
  test("a refused resume stays on the page, in the server's own words, through a poll", async () => {
    const server = new FakeServer(LIVE);
    server.refuse("resume", "run_claimed", "Another engine holds this run.");
    const view = await openRun(server);

    click(action(view, "resume"));
    await waitFor("the refusal to be drawn", () => !alarmOf(view).hidden);
    expect(alarmOf(view).textContent).toContain("Resume refused");
    expect(alarmOf(view).textContent).toContain("run_claimed");
    expect(alarmOf(view).textContent).toContain("Another engine holds this run.");

    const polls = server.polls;
    await waitFor("another poll", () => server.polls > polls);
    expect(alarmOf(view).hidden).toBe(false);
    expect(alarmOf(view).textContent).toContain("run_claimed");
  });

  test("dismiss takes the refusal away, and an action that works clears it", async () => {
    const server = new FakeServer(LIVE);
    server.refuse("resume", "run_claimed", "Another engine holds this run.");
    const view = await openRun(server);
    click(action(view, "resume"));
    await waitFor("the refusal", () => !alarmOf(view).hidden);
    click(buttonNamed(view, "Dismiss"));
    expect(alarmOf(view).hidden).toBe(true);

    click(action(view, "resume"));
    await waitFor("the refusal again", () => !alarmOf(view).hidden);
    server.allow("resume");
    click(action(view, "resume"));
    await waitFor("the alarm to clear", () => alarmOf(view).hidden);
  });

  test("retry refused because the run finished under us stays said", async () => {
    const server = new FakeServer(FAILED_RUN);
    server.refuse("retry", "run_not_retryable", "A run that succeeded is not retried.", 400);
    const view = await openRun(server);

    click(action(view, "retry"));
    await waitFor("the refusal to be drawn", () => alarmOf(view).textContent.includes("Retry refused"));
    expect(alarmOf(view).textContent).toContain("run_not_retryable");
    await settle();
    expect(alarmOf(view).hidden).toBe(false);
  });

  test("a delete the engine refuses because it still holds the run is shown honestly", async () => {
    const server = new FakeServer(DONE);
    server.refuse("delete", "run_claimed", "Another engine holds this run.");
    const view = await openRun(server);

    click(action(view, "delete"));
    click(buttonNamed(doc.body, "Delete the run"));
    await waitFor("the refusal", () => alarmOf(view).textContent.includes("Delete refused"));
    expect(alarmOf(view).textContent).toContain("run_claimed");
    expect(globals.navigateTo).toBeUndefined();
  });
});

describe("delete a finished run", () => {
  test("it asks first, then deletes, announces it and goes back to the runs list", async () => {
    const server = new FakeServer(DONE);
    const view = await openRun(server);
    globals.navigateTo = undefined;
    savedFiles.length = 0;

    click(action(view, "delete"));
    const dialog = one(doc.body.querySelector(".dialog"), "the delete dialog");
    expect(dialog.textContent).toContain("Delete this run?");
    click(buttonNamed(dialog, "Delete the run"));

    await waitFor("the delete", () => server.asked.includes(`DELETE /v1/runs/${DONE.id}`));
    expect(globals.navigateTo).toBe("/runs");
    expect(one(doc.getElementById("announce"), "the announcement").textContent).toContain("deleted");
  });
});

// ---------- the controls a poll must not rebuild ----------

describe("the controls of a live run", () => {
  test("Cancel keeps its focus and its identity across a poll", async () => {
    const server = new FakeServer(LIVE);
    const view = await openRun(server);
    const cancel = action(view, "cancel");
    cancel.focus();
    expect(doc.activeElement).toBe(cancel);

    const polls = server.polls;
    await waitFor("a poll", () => server.polls > polls);

    expect(action(view, "cancel")).toBe(cancel);
    expect(doc.activeElement).toBe(cancel);
  });

  test("the attempt picker is the same buttons every poll, and picking one reads its bytes", async () => {
    const retrying = runFixture([step("render", "running")], "running");
    retrying.steps["render"]!.attempts = [attempt(1, "failed"), attempt(2, "running")];
    retrying.steps["render"]!.attempts_used = 2;
    const server = new FakeServer(retrying);
    server.logs = { "render/1": "the first try\n", "render/2": "the second try\n" };
    const view = await openRun(server);
    await waitFor("the newest attempt", () => drawnLines(view).join() === "the second try");
    const first = attemptButton(view, 0);
    const second = attemptButton(view, 1);
    expect(attemptButtons(view).map((node) => node.textContent)).toEqual(["1", "2"]);
    expect(second.getAttribute("aria-checked")).toBe("true");
    first.focus();

    const polls = server.polls;
    await waitFor("a poll", () => server.polls > polls);
    expect(attemptButton(view, 0)).toBe(first);
    expect(attemptButton(view, 1)).toBe(second);
    expect(doc.activeElement).toBe(first);

    click(attemptButton(view, 0));
    await waitFor("attempt 1's log", () => drawnLines(view).join() === "the first try");
    expect(attemptButton(view, 0).getAttribute("aria-checked")).toBe("true");
    expect(bytesLine(view)).toBe(`${byteLength("the first try\n")} B read`);
  });
});

// ---------- the log ----------

describe("a log longer than one read", () => {
  const FINISHED = runFixture([step("render", "succeeded")], "succeeded");

  test("reads on until the server stops truncating, with line numbers, and ends on the last line", async () => {
    const server = new FakeServer(FINISHED);
    const log = `${Array.from({ length: 600 }, (_, n) => `line ${n}`).join("\n")}\nEND\n`;
    server.logs = { render: log };
    server.chunkBytes = 1000;
    const view = await openRun(server);
    await waitFor("the whole log", () => statusLine(view) === "Read to the end.");

    expect(drawnLines(view).at(-1)).toBe("END");
    expect(drawnLines(view).length).toBe(601);
    expect(view.querySelectorAll(".log__number").at(-1)?.textContent).toBe("601");
    expect(bytesLine(view)).toBe(`${formatBytes(byteLength(log))} read`);
  });

  test("a line cut by a chunk boundary is whole once the rest arrives", async () => {
    const server = new FakeServer(FINISHED);
    server.logs = { render: `${"x".repeat(2500)}\nEND\n` };
    server.chunkBytes = 1000;
    const view = await openRun(server);
    await waitFor("the whole log", () => drawnLines(view).length === 2);
    expect(drawnLines(view).map((line) => line.length)).toEqual([2500, 3]);
  });

  test("past the drawing cap it keeps the end and says how much it left out", async () => {
    const total = MAX_DRAWN_LINES + 700;
    const server = new FakeServer(FINISHED);
    server.logs = { render: `${Array.from({ length: total }, (_, n) => `line ${n}`).join("\n")}\nEND\n` };
    server.chunkBytes = 4000;
    const view = await openRun(server);
    await waitFor("the whole log", () => statusLine(view) === "Read to the end.");

    expect(drawnLines(view).length).toBe(MAX_DRAWN_LINES);
    expect(drawnLines(view).at(-1)).toBe("END");
    const note = one(view.querySelector(".log-note"), "the cap note");
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain(`The first ${total + 1 - MAX_DRAWN_LINES} lines`);
  });

  test("a single enormous line is clipped, with a plain statement of how much is not drawn", async () => {
    const server = new FakeServer(FINISHED);
    server.logs = { render: `${"y".repeat(MAX_LINE_CHARS + 20)}\n` };
    const view = await openRun(server);
    await waitFor("the whole log", () => drawnLines(view).length === 1);
    expect(drawnLines(view)[0]).toContain("more characters not drawn");
  });

  test("the bytes read move with the cursor, and switching steps starts again", async () => {
    const server = new FakeServer(DONE);
    server.logs = { fetch: "fetched three bytes\n", render: "rendered over more than one chunk\n" };
    server.chunkBytes = 8;
    server.logDelayMs = 40;
    const view = await openRun(server);
    await waitFor("the first chunk", () => bytesLine(view) !== "0 B read");
    expect(statusLine(view)).toBe("More of the log is waiting.");
    await waitFor("the whole log", () => bytesLine(view) === `${byteLength("rendered over more than one chunk\n")} B read`);

    click(timelineButton(view, "fetch"));
    expect(bytesLine(view)).toBe("0 B read");
    await waitFor("fetch's log", () => bytesLine(view) === `${byteLength("fetched three bytes\n")} B read`);
    expect(drawnLines(view)).toEqual(["fetched three bytes"]);
  });

  test("an attempt that wrote nothing says so", async () => {
    const view = await openRun(new FakeServer(DONE));
    await settle();
    expect(text(one(view.querySelector(".log__empty"), "the empty log"))).toBe("This attempt wrote nothing.");
  });
});

describe("following a log", () => {
  test("a finished run does not offer to follow, a live one does", async () => {
    const done = await openRun(new FakeServer(DONE));
    await settle();
    expect(buttonNamed(done, "Follow").disabled).toBe(true);

    const live = await openRun(new FakeServer(LIVE));
    await settle();
    expect(buttonNamed(live, "Follow").disabled).toBe(false);
  });

  test("scrolling up to read drops Follow", async () => {
    const server = new FakeServer(LIVE);
    server.logs = { render: "hello\n" };
    const view = await openRun(server);
    await settle();
    const box = one(view.querySelector(".log"), "the log pane") as unknown as { scrollHeight: number; clientHeight: number; scrollTop: number };
    box.scrollHeight = 1000;
    box.clientHeight = 100;
    box.scrollTop = 900;
    box.scrollTop = 0;
    one(view.querySelector(".log"), "the log pane").fire("scroll");
    expect(buttonNamed(view, "Follow").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("a server that stops answering", () => {
  test("the log says it lost the server, and stops saying it when the server comes back", async () => {
    const server = new FakeServer(LIVE);
    server.logs = { render: "hello\n" };
    const view = await openRun(server);
    await waitFor("the log", () => bytesLine(view) !== "0 B read");

    server.stop();
    await waitFor("the page to notice", () => statusLine(view).includes("Lost the server, still trying."));
    expect(statusLine(view)).toContain("api_unreachable");

    server.live();
    await waitFor("a good read", () => !statusLine(view).includes("Lost the server"));
  });

  test("a lost poll is said in the header, and the last good state stays", async () => {
    const server = new FakeServer(LIVE);
    const clock = new FakeClock();
    const view = await openRun(server, clock);
    const stale = one(view.querySelector(".run-page__stale"), "the stale line");
    expect(stale.hidden).toBe(true);

    server.refusePoll();
    await clock.advance(POLL_MS);
    expect(stale.hidden).toBe(false);
    expect(stale.getAttribute("title")).toContain("the api is down");
    expect(runStamp(view)).toBe("running");

    server.answerPollAgain();
    await clock.advance(POLL_MS);
    expect(stale.hidden).toBe(true);
  });
});

// ---------- the alarm ----------

describe("the alarm over the timeline", () => {
  test("it names every failed step, each one a way to its log", async () => {
    const view = await openRun(new FakeServer(SIX_FAILED));
    const alarm = alarmOf(view);
    expect(alarm.hidden).toBe(false);
    expect(alarm.textContent).toContain("6 steps failed");
    expect(alarm.querySelectorAll("[data-log-step]").map((node) => node.textContent)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(alarm.textContent).toContain("exit_nonzero: the script exited 1");
  });

  test("the retry says how much it will set back to pending", async () => {
    const view = await openRun(new FakeServer(SIX_FAILED));
    const retry = one(alarmOf(view).querySelector('[data-action="retry-all"]'), "the alarm's retry");
    expect(retry.textContent).toBe("Retry 7 steps");
    expect(retry.getAttribute("title")).toContain("6 failed steps, 1 skipped step");
  });

  test("one failed step is named, not counted", async () => {
    const view = await openRun(new FakeServer(FAILED_RUN));
    expect(alarmOf(view).textContent).toContain("render failed");
    expect(alarmOf(view).querySelectorAll("[data-log-step]").map((node) => node.textContent)).toEqual(["render failed"]);
  });

  test("the alarm is not rebuilt under you while the run polls", async () => {
    const limping = runFixture([step("render", "failed"), step("report", "running", ["render"])], "running");
    const server = new FakeServer(limping);
    const view = await openRun(server);
    const retry = one(alarmOf(view).querySelector('[data-action="retry-all"]'), "the retry");
    retry.focus();

    const polls = server.polls;
    await waitFor("a poll", () => server.polls > polls);
    expect(one(alarmOf(view).querySelector('[data-action="retry-all"]'), "the retry")).toBe(retry);
    expect(doc.activeElement).toBe(retry);
  });

  test("Show log selects the failed step, opens Logs and puts the focus on its row", async () => {
    const view = await openRun(new FakeServer(SIX_FAILED));
    openTab(view, "Steps");
    expect(selectedTab(view)).toBe("Steps");

    click(one(alarmOf(view).querySelector('[data-log-step="c"]'), "the link to c's log"));
    await waitFor("Logs", () => selectedTab(view) === "Logs");
    expect(timelineButton(view, "c").getAttribute("aria-selected")).toBe("true");
    expect(doc.activeElement).toBe(timelineButton(view, "c"));
  });
});

// ---------- a live view keeps up with the run ----------

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

  test("reads nothing while the tab is hidden, and reads at once when it is shown", async () => {
    const server = new FakeServer(LIVE);
    const clock = new FakeClock();
    await openRun(server, clock);
    const polls = server.polls;

    showTab(true);
    await clock.advance(POLL_MS * 5);
    expect(server.polls).toBe(polls);
    expect(clock.waking).toBe(0);

    showTab(false);
    await waitFor("a read on return", () => server.polls > polls);
  });

  test("follow stays on a step that failed an attempt and is due another one", async () => {
    const server = new FakeServer(runFixture([step("build", "running"), step("report", "pending", ["build"])], "running"));
    const clock = new FakeClock();
    const view = await openRun(server, clock);
    expect(timelineButton(view, "build").getAttribute("aria-selected")).toBe("true");

    server.run = runFixture([step("build", "waiting_retry"), step("report", "running", ["build"])], "running");
    await clock.advance(POLL_MS);
    expect(timelineButton(view, "build").getAttribute("aria-selected")).toBe("true");
    expect(timelineButton(view, "build").getAttribute("aria-label")).toBe("build, waiting_retry");
  });

  test("follow moves the pane to the step that is running now; Follow off pins it", async () => {
    const server = new FakeServer(runFixture([step("fetch", "running")], "running"));
    const clock = new FakeClock();
    const view = await openRun(server, clock);
    click(buttonNamed(view, "Follow"));
    expect(buttonNamed(view, "Follow").getAttribute("aria-pressed")).toBe("false");

    server.run = runFixture([step("fetch", "succeeded"), step("render", "running", ["fetch"])], "running");
    await clock.advance(POLL_MS);
    expect(timelineButton(view, "fetch").getAttribute("aria-selected")).toBe("true");

    click(buttonNamed(view, "Follow"));
    await clock.advance(POLL_MS);
    expect(timelineButton(view, "render").getAttribute("aria-selected")).toBe("true");
  });

  test("a retry that is already due is not counted backwards", async () => {
    const clock = new FakeClock();
    clock.set(T0);
    const server = new FakeServer(runFixture([step("build", "waiting_retry"), step("report", "pending", ["build"])], "running"));
    const view = await openRun(server, clock);
    expect(timelineButton(view, "build").getAttribute("aria-label")).toBe("build, waiting_retry");
    await clock.advance(42_000);
    expect(timelineButton(view, "build").getAttribute("aria-label")).toBe("build, waiting_retry");
  });
});

// ---------- the tabs ----------

describe("the steps tab", () => {
  test("it names the block, the attempts, the start, the duration and the outputs, and a row opens Logs", async () => {
    const run = runFixture([step("build", "succeeded")], "succeeded");
    run.steps["build"]!.outputs = { report: "out/report.html" };
    const view = await openRun(new FakeServer(run));
    openTab(view, "Steps");

    const row = stepTableRow(view, "build");
    expect(row.textContent).toContain("build@1");
    expect(row.textContent).toContain("1");
    expect(row.textContent).toContain("report");
    click(one(row.querySelector("a"), "the row's link"));
    await waitFor("Logs", () => selectedTab(view) === "Logs");
    expect(timelineButton(view, "build").getAttribute("aria-selected")).toBe("true");
  });
});

describe("the inputs and outputs tab", () => {
  test("it shows the run's inputs, and says outputs are not here yet before it succeeds", async () => {
    const view = await openRun(new FakeServer(FAILED_RUN));
    openTab(view, "Inputs & outputs");
    expect(view.textContent).toContain("lines");
    expect(view.textContent).toContain("200");
    expect(view.textContent).toContain("Outputs appear when the run succeeds.");
  });

  test("a file output is a download link, and json is compact", async () => {
    const run = runFixture([step("report", "succeeded")], "succeeded");
    run.outputs = { report: "steps/report/attempts/1/outputs/report.html", counts: { a: 1 } };
    const server = new FakeServer(run);
    server.downloads = { "steps/report/attempts/1/outputs/report.html": "<html></html>" };
    const view = await openRun(server);
    openTab(view, "Inputs & outputs");
    savedFiles.length = 0;

    expect(view.textContent).toContain('{"a":1}');
    click(downloadFor(view, "steps/report/attempts/1/outputs/report.html"));
    await waitFor("the file", () => savedFiles.length > 0);
    expect(savedFiles[0]?.name).toBe("report.html");
  });
});

describe("the files tab", () => {
  test("it lists every file with its size, and each one downloads through the API", async () => {
    const view = await openRun(filesServer());
    openTab(view, "Files");
    await waitFor("the files", () => view.textContent.includes(REPORT));

    expect(view.textContent).toContain(REPORT);
    expect(view.textContent).toContain(CHUNKS);
    expect(view.textContent).toContain(LOGFILE);
    expect(view.textContent).toContain("1.5 KB");
    expect(view.textContent).toContain("24 B");

    savedFiles.length = 0;
    click(downloadFor(view, REPORT));
    await waitFor("the file", () => savedFiles.length > 0);
    expect(savedFiles).toEqual([{ name: "report.html", url: "blob:13" }]);
  });

  test("the archive links name the run, the step and the attempt", async () => {
    const view = await openRun(filesServer());
    openTab(view, "Files");
    await waitFor("the files", () => view.textContent.includes(REPORT));

    const whole = fileLink(view, "Download the whole run");
    expect(whole.getAttribute("href")).toBe(`http://runs.test/v1/runs/${FILES_RUN.id}/archive`);
    const archiveLink = fileLink(view, "Everything in ingest attempt 1 as one archive");
    expect(archiveLink.getAttribute("href")).toBe(
      `http://runs.test/v1/runs/${FILES_RUN.id}/archive?step=ingest&attempt=1`,
    );
    expect(fileLink(view, "Download the manifest").getAttribute("href")).toBe(
      `http://runs.test/v1/runs/${FILES_RUN.id}/files`,
    );
  });

  test("the attempt's log is offered above the bytes it wrote", async () => {
    const view = await openRun(filesServer());
    await waitFor("the log download", () => view.querySelectorAll(".file").some((node) => node.getAttribute("data-download") === "Download log"));
    const log = fileLink(view, "Download log");
    expect(log.getAttribute("href")).toBe(
      `http://runs.test/v1/runs/${FILES_RUN.id}/file?path=${encodeURIComponent(LOGFILE)}`,
    );
    expect(log.textContent).toContain("118 B");
  });

  test("a running attempt offers its log without the manifest's lagging size", async () => {
    const run = runFixture([step("ingest", "running")], "running");
    const server = new FakeServer(run);
    server.files = {
      ...FILES_MANIFEST,
      run: run.id,
      status: "running",
      steps: {
        ingest: {
          attempts: [
            {
              ...FILES_MANIFEST.steps.ingest.attempts[0]!,
              status: "running",
              log: { path: LOGFILE, size: 201 },
            },
          ],
        },
      },
    };
    const view = await openRun(server);
    await waitFor("the live log download", () => view.querySelectorAll(".file").some((node) => node.getAttribute("data-download") === "Download log"));
    const log = fileLink(view, "Download log");
    expect(log.textContent).toBe("Download log");
    expect(log.querySelector(".file__size")).toBeNull();
  });

  test("a run whose files cannot be listed still shows the run", async () => {
    const view = await openRun(new FakeServer(FILES_RUN));
    openTab(view, "Files");
    await settle();
    expect(view.textContent).toContain("No files for this run.");
    expect(runStamp(view)).toBe("succeeded");
  });
});

// ---------- the graph ----------

describe("the graph tab", () => {
  test("it draws the run's snapshot, gives every node its sign and state, and a node opens its log", async () => {
    const server = graphServer(FAILED_RUN, GRAPH_YAML, { "fetch@1": blockSource("fetch"), "render@1": blockSource("render") });
    const view = await openRun(server, undefined, { tab: "graph" });
    await waitFor("the graph", () => view.querySelectorAll(".node").length === 2);

    const nodes = view.querySelectorAll(".node");
    const fetch = one(nodes.find((node) => node.getAttribute("data-step") === "fetch") ?? null, "the fetch node");
    const render = one(nodes.find((node) => node.getAttribute("data-step") === "render") ?? null, "the render node");
    expect(one(fetch.querySelector(".node__status"), "fetch's status").textContent).toContain("succeeded");
    expect(one(render.querySelector(".node__status"), "render's status").textContent).toContain("failed");
    expect(one(fetch.querySelector(".node__status"), "fetch's sign").querySelector("svg path")).not.toBe(null);

    click(render);
    await waitFor("Logs", () => selectedTab(view) === "Logs");
    expect(timelineButton(view, "render").getAttribute("aria-selected")).toBe("true");
  });

  test("a snapshot the server staged as JSON still finds the library contract for ./name@1", async () => {
    const yaml = JSON.stringify({ name: "staged", steps: { build: { uses: "./build@1", with: { lines: 1, corpus: "x" } } } });
    const server = graphServer(DONE, yaml, { "build@1": blockSource("build") });
    const view = await openRun(server, undefined, { tab: "graph" });
    await waitFor("the graph", () => view.querySelectorAll(".node").length === 1);

    const node = one(view.querySelector('.node[data-step="build"]'), "the build node");
    expect(node.textContent).toContain("build@1");
    expect(node.querySelectorAll(".port").length).toBeGreaterThan(0);
    expect(node.querySelector(".node__problem")).toBe(null);
  });

  test("a ./file.sh reference draws its step without ports rather than failing", async () => {
    const yaml = `name: local\nsteps:\n  build:\n    uses: ./build.sh\n`;
    const server = graphServer(DONE, yaml);
    const view = await openRun(server, undefined, { tab: "graph" });
    await waitFor("the graph", () => view.querySelectorAll(".node").length === 1);

    const node = one(view.querySelector('.node[data-step="build"]'), "the build node");
    expect(node.querySelectorAll(".port").length).toBe(0);
    expect(node.textContent).toContain("./build.sh");
    expect(node.querySelector(".node__problem")).not.toBe(null);
  });
});

// ---------- the words on the page, and the box they have to fit in ----------

const sheet = new TextDecoder().decode(buildAssets().files.get("assets/style.css")!.data);
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(sheet);
  if (found === null) throw new Error(`style.css has no rule whose selector is exactly ${selector}`);
  return found[1]!;
}
const styled = (view: FakeElement): string[] =>
  [...view.descendants()].filter((node) => node.attrs.has("style")).map((node) => `${node.tagName.toLowerCase()}[${node.getAttribute("style")}]`);

describe("the app's own content security policy", () => {
  test("no module the browser runs puts a style attribute on an element", () => {
    const offenders: string[] = [];
    for (const [name, asset] of buildAssets().files) {
      if (!name.startsWith("assets/") || !name.endsWith(".js")) continue;
      if (/\bstyle:\s*["']/.test(new TextDecoder().decode(asset.data))) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  test("the run page leaves no style attribute on the page", async () => {
    const view = await openRun(new FakeServer(FAILED_RUN));
    expect(styled(view)).toEqual([]);
  });

  test("the graph gives a port name the whole width of its step", () => {
    expect(sheet).not.toMatch(/\.node__ports\s*\{[^}]*grid-template-columns/);
    expect(ruleBody(".stage--flow .port--out")).toContain("text-align: right");
  });
});

describe("one clock on the screen", () => {
  test("a time is the reader's own clock, and does not name a zone", () => {
    const stamp = when("2026-11-04T10:15:00Z");
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(Date.parse(stamp)).toBe(Date.parse("2026-11-04T10:15:00Z"));
  });

  test("a time that is not there is nothing, not a date invented", () => {
    expect(when(null)).toBe("");
    expect(isoInstant(null)).toBe("");
  });
});
