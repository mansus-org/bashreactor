// The graph is drawn against a browser and Bun does not have one, so this file brings its own:
// enough of a DOM for graph.ts to lay a real document out and be measured while it does. It is a
// stand-in and not a browser — geometry is derived from the inline styles graph.ts sets, plus a fixed
// box for anything it does not — which is enough to answer the only question asked here: does the
// layout run to the end, and does it put nodes and wires on the stage.
//
// The modules come from the bytes the server serves, as in client/logs.test.ts, and they are written
// to a directory of their own so their `./dom.js` and `./model.js` specifiers resolve.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAssets } from "../assets.ts";
import type { Library } from "./model.ts";

// ---------- the stand-in DOM ----------

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const px = (value: string | undefined): number => {
  const n = Number.parseFloat(value ?? "");
  return Number.isNaN(n) ? 0 : n;
};

/** How `dataset.foo` maps to the attribute a selector matches, which is all graph.ts asks for. */
const dataAttribute = (key: string): string => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

interface Compound {
  tag: string | null;
  classes: string[];
  attrs: { name: string; value: string | null }[];
}

/** The selectors graph.ts uses: tags, `.class`, `[attr="value"]`, and descendant spaces. Nothing else. */
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

class FakeElement {
  readonly tagName: string;
  readonly style: Record<string, string> = {};
  readonly attrs = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  clientWidth = 0;
  value = "";
  tabIndex = 0;
  private text = "";
  private classes = new Set<string>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
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

  /** The same map seen through `dataset`: reads and writes go to the `data-*` attribute. */
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

  addEventListener(): void {
    // The handlers are wired but never fired here: this test lays the graph out, it does not click it.
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

  contains(node: FakeElement | null): boolean {
    let at: FakeElement | null = node;
    while (at !== null) {
      if (at === this) return true;
      at = at.parent;
    }
    return false;
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

  focus(): void {}

  // The measured box, from the inline styles the layout just set. A node is absolutely positioned
  // inside the canvas; anything else sits at a fixed offset inside its parent, which is enough for
  // every port mark to land on its own finite coordinates.
  getBoundingClientRect(): Box {
    const parent = this.parent !== null ? this.parent.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    const index = this.parent !== null ? this.parent.children.indexOf(this) : 0;
    const placed = this.style.left !== undefined || this.style.top !== undefined;
    return {
      left: parent.left + (placed ? px(this.style.left) : (index + 1) * 3),
      top: parent.top + (placed ? px(this.style.top) : (index + 1) * 2),
      width: this.offsetWidth,
      height: this.offsetHeight,
    };
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
    // A step is as tall as its rows: the port count is what makes columns differ in height.
    return px(this.style.height) || (this.classList.contains("node") ? 72 + 18 * this.querySelectorAll(".port").length : 8);
  }
}

const fakeDocument = {
  body: new FakeElement("body"),
  activeElement: null,
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_namespace: string, tag: string) => new FakeElement(tag),
  getElementById(id: string) {
    return this.body.querySelector(`[id="${id}"]`);
  },
};

const globals = globalThis as unknown as Record<string, unknown>;
const installed = {
  document: globals.document,
  CSS: globals.CSS,
  ResizeObserver: globals.ResizeObserver,
};
globals.document = fakeDocument;
globals.CSS = { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) };
globals.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

afterAll(() => {
  for (const [name, value] of Object.entries(installed)) {
    if (value === undefined) delete globals[name];
    else globals[name] = value;
  }
  rmSync(served, { recursive: true, force: true });
});

// ---------- the modules the browser actually runs ----------

const assets = buildAssets().files;
const served = mkdtempSync(join(tmpdir(), "bashreactor-graph-"));
for (const name of ["dom", "yaml", "model", "graph"]) {
  writeFileSync(join(served, `${name}.js`), assets.get(`assets/${name}.js`)!.data);
}
const { analyze } = (await import(join(served, "model.js"))) as typeof import("./model.ts");
const { createGraph } = (await import(join(served, "graph.js"))) as typeof import("./graph.ts");

// ---------- a document, and the library that arrives later ----------

const YAML = `name: word-report
description: Count the words of a corpus and render a report.

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

/** A block's contract is its own header, so the library is headers. */
function block(name: string, inputs: string, outputs: string): string {
  return `#!/usr/bin/env bash
# ---
# name: ${name}
# description: The ${name} block.
${inputs}
${outputs}
# ---
echo done
`;
}

const LIBRARY: Library = {
  "generate-corpus": {
    name: "generate-corpus",
    versions: [
      {
        version: 1,
        source: block(
          "generate-corpus",
          "# inputs:\n#   lines:\n#     type: integer\n#     description: How many lines.",
          "# outputs:\n#   corpus:\n#     type: string\n#     description: The corpus file.",
        ),
      },
    ],
  },
  "check-corpus": {
    name: "check-corpus",
    versions: [
      {
        version: 1,
        source: block(
          "check-corpus",
          "# inputs:\n#   corpus:\n#     type: string\n#     description: The corpus file.",
          "# outputs:\n#   ok:\n#     type: boolean\n#     description: Whether it is long enough.",
        ),
      },
    ],
  },
};

/** One paint, the way `setText(..., { source: "load" })` does it: analyse, then hand it to the graph. */
function paint(text: string, library: Library, width: number) {
  const analysis = analyze(text, library);
  if (!analysis.ok) throw new Error(`the test document does not parse: ${JSON.stringify(analysis.problems)}`);
  const stage = new FakeElement("div");
  stage.className = "stage";
  stage.clientWidth = width;
  const graph = createGraph(stage as unknown as HTMLElement, { onSelect: () => {} });
  graph.update({ analysis, selected: analysis.order[0] ?? null, stale: false });
  return { analysis, stage, graph };
}

/** Every wire the layout drew, with the numbers it drew them at. */
function wires(stage: FakeElement): { from: string; to: string; d: string }[] {
  return stage.querySelectorAll(".wire").map((wire) => ({
    from: wire.getAttribute("data-from") ?? "",
    to: wire.getAttribute("data-to") ?? "",
    d: wire.getAttribute("d") ?? "",
  }));
}

/** A wire that was drawn: a move and a run of horizontal and vertical legs, all whole pixels. */
const DRAWN = /^M-?\d+ -?\d+(?:[HV]-?\d+)+$/;

describe("drawing a graph", () => {
  test("lays out every step and every wire in the wide flow layout", () => {
    const { analysis, stage } = paint(YAML, LIBRARY, 960);
    expect(stage.classList.contains("stage--flow")).toBe(true);
    expect(analysis.edges.length).toBeGreaterThan(0);
    expect(stage.querySelectorAll(".node").length).toBe(analysis.steps.length);
    expect(wires(stage).length).toBe(analysis.edges.length);
    for (const wire of wires(stage)) expect(wire.d).toMatch(DRAWN);
  });

  test("lays out every step and every wire in the narrow lane layout", () => {
    const { analysis, stage } = paint(YAML, LIBRARY, 200);
    expect(stage.classList.contains("stage--lanes")).toBe(true);
    expect(stage.querySelectorAll(".node").length).toBe(analysis.steps.length);
    expect(wires(stage).length).toBe(analysis.edges.length);
    for (const wire of wires(stage)) expect(wire.d).toMatch(DRAWN);
  });

  // The load path, which is what threw: opening a stored pipeline hands the whole document over at
  // once, and the block contracts come from the API afterwards. So the first paint has a wire whose
  // far end is an output port nothing has named yet, because the step has no contract and therefore
  // no ports at all. Typing the same YAML never showed it, because `uses:` is typed before `with:`
  // and the block is in the library by the time the wire exists.
  test("draws the graph of a stored pipeline before the library has answered", () => {
    const { analysis, stage } = paint(YAML, {}, 960);
    expect(analysis.steps.every((step) => step.contract === null)).toBe(true);
    expect(analysis.edges.length).toBeGreaterThan(0);
    expect(stage.querySelectorAll(".node").length).toBe(analysis.steps.length);
    expect(wires(stage).length).toBe(analysis.edges.length);
    for (const wire of wires(stage)) expect(wire.d).toMatch(DRAWN);
  });

  test("draws it in the lane layout too, before the library has answered", () => {
    const { analysis, stage } = paint(YAML, {}, 200);
    expect(stage.classList.contains("stage--lanes")).toBe(true);
    expect(stage.querySelectorAll(".node").length).toBe(analysis.steps.length);
    expect(wires(stage).length).toBe(analysis.edges.length);
    for (const wire of wires(stage)) expect(wire.d).toMatch(DRAWN);
  });

  // The other half of the load path: the contracts arrive, the graph repaints, and the wires that
  // had to leave from a step's edge now leave from the port they were always meant to.
  test("moves a wire onto its port once the contract names it", () => {
    const before = wires(paint(YAML, {}, 960).stage);
    const after = wires(paint(YAML, LIBRARY, 960).stage);
    expect(before.length).toBe(after.length);
    expect(before.map((wire) => `${wire.from}>${wire.to}`)).toEqual(after.map((wire) => `${wire.from}>${wire.to}`));
    expect(before.map((wire) => wire.d)).not.toEqual(after.map((wire) => wire.d));
  });
});
