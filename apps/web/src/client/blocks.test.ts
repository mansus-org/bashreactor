// The Blocks screen puts one pane on screen at a time below 980 px, and which one it puts there is
// decided in style.css by one class on `.lib`: without it the detail is `display: none`, so at phone
// width the screen was a list of names and nothing else — no contract, no source, no writer. The
// class has to come from the route the screen was asked to render, because the screen re-renders on
// every navigation and a class added by a click would be gone by the next one.
//
// Two halves, so two kinds of assertion. The class itself is checked against the real `renderBlocks`,
// run the way the router runs it over the bytes the server serves, in the DOM stand-in from
// client.testkit.ts. The width is not: this DOM runs no CSS and no media queries, so the other half
// reads the stylesheet the server serves and checks that the rule hiding the detail reads the very
// class name the code just set. If either half is renamed, the two stop matching and this fails.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { buildAssets } from "../assets.ts";
import { blockSource, decls, installDom, serveModules, uninstallDom, type FakeElement } from "./client.testkit.ts";
import type { Route } from "./app.ts";

const dom = installDom({ href: "http://x/app/blocks" });
const served = serveModules(["app", "api", "dom", "model", "blocks", "editor", "graph", "yaml", "runs", "logs"]);
const { session } = (await import(join(served, "api.js"))) as typeof import("./api.ts");
const { renderBlocks } = (await import(join(served, "blocks.js"))) as typeof import("./blocks.ts");

const realFetch = globalThis.fetch;

afterAll(() => {
  uninstallDom(dom);
  rmSync(served, { recursive: true, force: true });
  (globalThis as unknown as Record<string, unknown>).fetch = realFetch;
});

// ---------- what the API has ----------

const COUNT_WORDS = blockSource(
  "count-words",
  decls("inputs", [["text", "string"]]),
  decls("outputs", [["words", "integer"]]),
);

const meta = (name: string, version: number) => ({
  name,
  version,
  sha256: `${name}-${version}`,
  size: COUNT_WORDS.length,
  created_at: `2026-11-0${version}T09:00:00Z`,
});

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** The three routes this screen asks about; everything else is a 404 the way apps/api answers it. */
async function answer(href: string): Promise<Response> {
  const parts = new URL(href).pathname.split("/").filter((part) => part !== "");
  if (parts[0] !== "v1" || parts[1] !== "blocks" || parts[2] !== "count-words") {
    return json({ code: "block_not_found", message: `block "${parts[2] ?? ""}" has no versions` }, 404);
  }
  if (parts.length === 3) return json({ name: "count-words", latest: 1, versions: [meta("count-words", 1)] });
  if (parts[3] === "1" && parts[4] === "content") {
    return new Response(COUNT_WORDS, { headers: { "content-type": "text/plain; charset=utf-8", "x-block-sha256": "x" } });
  }
  return json({ code: "block_not_found", message: `no version ${parts[3]}` }, 404);
}

(globalThis as unknown as Record<string, unknown>).fetch = (href: string | URL) => answer(href.toString());

// ---------- opening a path ----------

/** The route the address bar would hold, which is the only state this screen reads. */
function route(path: string): Route {
  const parts = path.split("/").filter((part) => part !== "");
  return { path, parts, query: new URLSearchParams() };
}

/** What the router does between two screens: the next one is painted into the same `#view`. */
async function open(path: string): Promise<FakeElement> {
  session.identity = { name: "test", scope: "admin", admin: true };
  const view = dom.document.createElement("div");
  await renderBlocks(view as unknown as HTMLElement, route(path));
  return view;
}

const lib = (view: FakeElement): FakeElement => {
  const node = view.querySelector(".lib");
  if (node === null) throw new Error("the blocks screen drew no .lib");
  return node;
};

/** The classes on `.lib`, which is the whole of the state the narrow layout reads. */
const classes = (view: FakeElement): string[] => (lib(view).getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

const text = (view: FakeElement): string => view.textContent;

/** The stylesheet the server ships, which is where the layout rules this screen depends on live. */
const sheet = new TextDecoder().decode(buildAssets().files.get("assets/style.css")!.data);

// ---------- which pane is on screen ----------

describe("which pane the blocks screen shows", () => {
  test("an open block marks the library open, and its contract and source are on screen", async () => {
    const view = await open("/blocks/count-words");

    expect(classes(view)).toContain("lib--open");
    // The half the bug report was missing: the detail, not just the name in the list.
    expect(view.querySelector(".detail .h2")?.textContent).toBe("count-words");
    expect(view.querySelectorAll(".table").length).toBe(2);
    expect(view.querySelector(".code code")?.textContent).toBe(COUNT_WORDS);
    // And the list stays reachable: the back control is the one that closes the block again.
    expect(view.querySelector(".back")?.getAttribute("href")).toBe("/app/blocks");
  });

  test("the writer marks the library open too", async () => {
    const view = await open("/blocks/new");

    expect(classes(view)).toContain("lib--open");
    expect(view.querySelector("[id='writer-source']")).not.toBeNull();
    expect(view.querySelector(".back")?.getAttribute("href")).toBe("/app/blocks");
  });

  test("a new version of a block opens the writer with a way back to that block", async () => {
    const view = await open("/blocks/count-words/edit");

    expect(classes(view)).toContain("lib--open");
    expect(text(view)).toContain("New version of count-words");
    expect(view.querySelector(".back")?.getAttribute("href")).toBe("/app/blocks/count-words");
  });

  test("a block the library has never heard of still opens, because its answer is the detail", async () => {
    const view = await open("/blocks/gone");

    expect(classes(view)).toContain("lib--open");
    expect(text(view)).toContain("No such block");
    expect(view.querySelector(".back")?.getAttribute("href")).toBe("/app/blocks");
  });

  test("the library with nothing open leaves the list as the pane", async () => {
    const view = await open("/blocks");

    expect(classes(view)).not.toContain("lib--open");
    expect(view.querySelector(".lib__list [id='block-name']")).not.toBeNull();
    expect(text(view)).toContain("No block open");
  });

  test("going back to the library drops the class, so it is the route's and not a click's", async () => {
    // The router paints each screen into the same `#view`, so a class left over from the block would
    // hide the list on the very screen whose job is to show it.
    const view = dom.document.createElement("div");
    await renderBlocks(view as unknown as HTMLElement, route("/blocks/count-words"));
    expect(classes(view)).toContain("lib--open");

    await renderBlocks(view as unknown as HTMLElement, route("/blocks"));
    expect(classes(view)).not.toContain("lib--open");
  });
});

// ---------- the two halves name the same thing ----------

test("the class renderBlocks sets is the class the 980 px rule reads", async () => {
  const rule = /\.lib:not\(\.([\w-]+)\)\s*\.detail\s*\{[^}]*display:\s*none/.exec(sheet);
  expect(rule).not.toBeNull();

  const closed = classes(await open("/blocks"));
  const opened = classes(await open("/blocks/count-words"));
  expect(opened.filter((name) => !closed.includes(name))).toEqual([rule![1]!]);
});

// ---------- the contract table, and the writer ----------
//
// A block's input and output names are the thing a person reads a contract for, and they are the
// longest words in their column: `total_words`, `corpus`. The table was squeezing them to `corpu/s`
// at desktop width, and the writer's "Start from" label carried a `style` attribute the app's own
// CSP drops. Both are rules in the stylesheet the server ships, so that is what is read here — the
// same two halves as the pane-switching test above: the code's classes, and the rule that reads them.

/** The body of one rule, written out with this exact selector. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(sheet);
  if (found === null) throw new Error(`style.css has no rule whose selector is exactly ${selector}`);
  return found[1]!;
}

/** Every element the screen put on the page that carries an inline style. */
const styled = (view: FakeElement): string[] =>
  [...view.descendants()].filter((node) => node.getAttribute("style") !== null).map((node) => `${node.tagName.toLowerCase()}[${node.getAttribute("style")}]`);

describe("the contract table", () => {
  test("a name keeps its whole word, however narrow the table gets", () => {
    // `overflow-wrap: anywhere` counts a broken word as the column's minimum width, so the table
    // took the name column down to `corpu/s`. `break-word` only breaks once the line is out of room.
    expect(ruleBody(".table tbody th")).toMatch(/overflow-wrap:\s*break-word/);
  });

  test("the names are row headers, which is the cell the rule sizes", async () => {
    const view = await open("/blocks/count-words");
    expect(view.querySelectorAll(".table tbody th").map((node) => node.textContent)).toEqual(["text", "words"]);
  });
});

describe("the block writer", () => {
  test("nothing on the writer carries a style attribute", async () => {
    // The CSP the server sends is `style-src 'self'`, so an inline style is dropped and the label
    // sits out of line with the buttons it names.
    expect(styled(await open("/blocks/new"))).toEqual([]);
  });

  test("the label beside the template buttons is the class that zeroes its margin", async () => {
    const view = await open("/blocks/new");
    const label = view.querySelector(".row .label");
    expect(label?.textContent).toBe("Start from");
    expect(label?.classList.contains("label--inline")).toBe(true);
    expect(ruleBody(".label--inline")).toMatch(/margin:\s*0/);
  });
});
