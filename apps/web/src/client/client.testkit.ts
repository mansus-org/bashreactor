// A stand-in for the browser, for the client tests: enough of a DOM that graph.ts can lay a graph out
// and editor.ts can build a screen, call the API and be measured while it does. It is not a browser.
// Geometry comes from the inline styles the code sets plus a fixed box for anything it does not, which
// is enough to answer what these tests ask — did the layout run to the end, and did it put the nodes,
// the ports and the wires on the stage.
//
// It is a `.testkit.ts` file rather than a `.ts` one so the asset table test knows it is never shipped.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAssets } from "../assets.ts";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const px = (value: string | undefined): number => {
  const n = Number.parseFloat(value ?? "");
  return Number.isNaN(n) ? 0 : n;
};

/** How `dataset.foo` maps to the attribute a selector matches, which is all the client code asks for. */
const dataAttribute = (key: string): string => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

const escapeSelector = (value: string): string => value.replace(/[^\w-]/g, (c) => `\\${c}`);

interface Compound {
  tag: string | null;
  classes: string[];
  attrs: { name: string; value: string | null }[];
}

/** The selectors the client code uses: tags, `.class`, `[attr="value"]`, and descendant spaces. */
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

/** Whether one node matches a whole selector, descendant combinators included. */
function matchesSelector(node: FakeElement, selector: string): boolean {
  const parts = selector.trim().split(/\s+/).map(parseCompound);
  if (!matches(node, parts[parts.length - 1]!)) return false;
  let at: FakeElement | null = node.parent;
  let rest = parts.length - 2;
  while (rest >= 0 && at !== null) {
    if (matches(at, parts[rest]!)) rest--;
    at = at.parent;
  }
  return rest < 0;
}

/** The node and everything above it, nearest first. */
function lineageOf(node: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  let at: FakeElement | null = node;
  while (at !== null) {
    out.push(at);
    at = at.parent;
  }
  return out;
}

export class FakeElement {
  readonly tagName: string;
  readonly style: Record<string, string> = {};
  readonly attrs = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  clientWidth = 0;
  clientHeight = 0;
  scrollTop = 0;
  scrollLeft = 0;
  selectionStart = 0;
  selectionEnd = 0;
  value = "";
  hidden = false;
  disabled = false;
  checked = false;
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
    // Handlers are wired but never fired here: these tests paint a screen, they do not click it.
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

  get innerText(): string {
    return this.textContent;
  }

  contains(node: FakeElement | null): boolean {
    return node !== null && lineageOf(node).includes(this);
  }

  closest(selector: string): FakeElement | null {
    return lineageOf(this).find((node) => matchesSelector(node, selector)) ?? null;
  }

  *descendants(): Generator<FakeElement> {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  querySelectorAll(selector: string): FakeElement[] {
    return [...this.descendants()].filter((node) => matchesSelector(node, selector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  focus(): void {}

  showModal(): void {}

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

export class FakeDocument {
  title = "";
  activeElement: FakeElement | null = null;
  readonly body = new FakeElement("body");

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  createElementNS(_namespace: string, tag: string): FakeElement {
    return new FakeElement(tag);
  }

  getElementById(id: string): FakeElement | null {
    return this.body.querySelector(`[id="${escapeSelector(id)}"]`);
  }

  querySelector(selector: string): FakeElement | null {
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector);
  }

  addEventListener(): void {}
}

class FakeStorage {
  private readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }
}

export interface InstalledDom {
  document: FakeDocument;
  /** The browser globals this put in place, so a test can put them back. */
  names: string[];
}

/**
 * Puts the shell the client code expects — `#view`, the nav, the status region — onto a fresh body,
 * and installs the globals it reads. Returns the names it took over, for the test that restores them.
 */
export function installDom(options: { href?: string } = {}): InstalledDom {
  const globals = globalThis as unknown as Record<string, unknown>;
  const href = options.href ?? "http://x/app/";
  const url = new URL(href);
  const doc = new FakeDocument();

  const shell: [string, Record<string, string>][] = [
    ["div", { id: "view" }],
    ["nav", { class: "nav", hidden: "" }],
    ["span", { id: "who" }],
    ["p", { id: "foot-note" }],
    ["p", { id: "announce", role: "status" }],
  ];
  for (const [tag, attrs] of shell) {
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    doc.body.append(node);
  }

  const names: string[] = [];
  const install = (name: string, value: unknown): void => {
    names.push(name);
    globals[name] = value;
  };

  install("document", doc);
  install("location", { href, origin: url.origin, pathname: url.pathname, search: url.search, hash: url.hash });
  install("history", { pushState(): void {}, replaceState(): void {} });
  install("window", {
    addEventListener(): void {},
    removeEventListener(): void {},
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms) as unknown as number,
    clearTimeout: (handle: number) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
  });
  install("localStorage", new FakeStorage());
  install("sessionStorage", new FakeStorage());
  install("getComputedStyle", () => ({ lineHeight: "24px" }));
  install("CSS", { escape: escapeSelector });
  install("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });

  return { document: doc, names };
}

/** Puts the globals installDom() took back the way they were. */
export function uninstallDom(installed: InstalledDom): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of installed.names) delete globals[name];
}

/**
 * The modules the browser actually runs, on disk under their own names, so their `./dom.js` and
 * `./model.js` specifiers resolve. Bun caches modules by path and `src/raw.js` has already loaded the
 * TypeScript originals as text, so this is the only way a test gets functions rather than strings.
 */
export function serveModules(names: string[]): string {
  const files = buildAssets().files;
  const dir = mkdtempSync(join(tmpdir(), "bashreactor-client-"));
  for (const name of names) {
    const asset = files.get(`assets/${name}.js`);
    if (asset === undefined) throw new Error(`the asset table has no assets/${name}.js`);
    writeFileSync(join(dir, `${name}.js`), asset.data);
  }
  return dir;
}

/** A block file whose contract is its own front matter, which is what model.ts reads it from. */
export function blockSource(name: string, inputs: string, outputs: string): string {
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

/** The `inputs:` / `outputs:` front matter of blockSource, from `[[name, type], ...]` rows. */
export function decls(kind: "inputs" | "outputs", rows: [string, string][]): string {
  if (rows.length === 0) return "";
  return [`# ${kind}:`, ...rows.map(([row, type]) => `#   ${row}:\n#     type: ${type}\n#     description: The ${row}.`)].join("\n");
}
