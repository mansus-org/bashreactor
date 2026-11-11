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

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { buildAssets } from "../assets.ts";
import { blockSource, decls, installDom, serveModules, uninstallDom, type FakeElement } from "./client.testkit.ts";
import type { Route } from "./app.ts";

const dom = installDom({ href: "http://x/app/blocks" });
const served = serveModules(["app", "api", "dom", "model", "blocks", "editor", "graph", "yaml", "runs-list", "run-page", "logs"]);
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

/** A block whose name is the word the router used to mean "new", which is the whole of BASHR-36. */
const CALLED_NEW = blockSource("new", decls("inputs", [["text", "string"]]), decls("outputs", [["words", "integer"]]));

/** A block with a character in it that is not one byte, so bytes and characters are two numbers. */
const ACCENTED = `${blockSource("accent", decls("inputs", [["text", "string"]]), "")}\n# café\n`;
const ACCENTED_BYTES = new TextEncoder().encode(ACCENTED).length;

/** The half-published block: the list names v2, and its bytes are not there to read. */
const HALF_GONE = blockSource("half-gone", decls("inputs", [["text", "string"]]), "");

/** Versions the list names and the store cannot open, which is what BASHR-36 asks the screen to survive. */
const LOST: Record<string, number[]> = { "half-gone": [2] };

/** A block whose v2 fails for a reason that is not "gone", which is the other half of the same ask. */
const SULK = blockSource("sulk", decls("inputs", [["text", "string"]]), "");
const BROKEN: Record<string, number[]> = { sulk: [2] };

const meta = (name: string, version: number, size: number) => ({
  name,
  version,
  sha256: `${name}-${version}`,
  size,
  created_at: `2026-11-0${version}T09:00:00Z`,
});

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const asText = (body: string): Response =>
  new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "x-block-sha256": "x" } });

const bytes = (value: string): number => new TextEncoder().encode(value).length;

/** The library this fake serves, one route per block, answered the way apps/api answers it. */
const LIBRARY: Record<string, Record<number, string>> = {
  "count-words": { 1: COUNT_WORDS },
  new: { 1: CALLED_NEW },
  accent: { 1: ACCENTED },
  "half-gone": { 1: HALF_GONE },
  sulk: { 1: SULK },
};

/** What the screen has posted, which is how "nothing was published" gets proved. */
const posted: string[] = [];

/** The versions the library lists for a block, including the ones whose bytes cannot be read. */
const versionsOf = (name: string): number[] =>
  [...new Set([...Object.keys(LIBRARY[name] ?? {}).map(Number), ...(LOST[name] ?? []), ...(BROKEN[name] ?? [])])].toSorted(
    (a, b) => a - b,
  );

/** The three routes this screen asks about; everything else is a 404 the way apps/api answers it. */
async function answer(href: string, init?: RequestInit): Promise<Response> {
  const parts = new URL(href).pathname.split("/").filter((part) => part !== "");
  if (init?.method === "POST" && parts.join("/") === "v1/blocks") {
    posted.push(String(init.body ?? ""));
    return json(meta("posted", 2, 1), 201);
  }
  // `GET /v1/blocks`: one entry per name, newest version and how many there are, names sorted.
  if (parts.join("/") === "v1/blocks") {
    return json({
      blocks: Object.keys(LIBRARY)
        .toSorted()
        .map((name) => {
          const versions = versionsOf(name);
          return { name, latest: versions[versions.length - 1], versions: versions.length };
        }),
    });
  }
  const name = parts[2] ?? "";
  const block = LIBRARY[name];
  if (parts[0] !== "v1" || parts[1] !== "blocks" || block === undefined) {
    return json({ code: "block_not_found", message: `block "${name}" has no versions` }, 404);
  }
  // The store lists a block's versions oldest first, and the client's `latest()` is the last of them.
  const versions = versionsOf(name);
  if (parts.length === 3) {
    return json({
      name,
      latest: versions[versions.length - 1],
      versions: versions.map((version) => meta(name, version, bytes(block[version] ?? ""))),
    });
  }
  const wanted = Number(parts[3]);
  if (parts[4] === "content" && (BROKEN[name] ?? []).includes(wanted)) {
    return json({ code: "internal", message: "the store is having a moment" }, 500);
  }
  if (parts[4] === "content" && block[wanted] !== undefined) return asText(block[wanted]!);
  return json({ code: "block_version_not_found", message: `block "${name}" has no version ${parts[3]}` }, 404);
}

(globalThis as unknown as Record<string, unknown>).fetch = (href: string | URL, init?: RequestInit) =>
  answer(href.toString(), init);

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

/** A link by the words on it, which is how a person finds one on a screen. */
const linkLabeled = (view: FakeElement, label: string): FakeElement | undefined =>
  view.querySelectorAll("a").find((link) => link.textContent === label);

/** One turn of the event loop, which is how long a promise the screen is waiting on takes to land. */
const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/** The size column of the version rows, in the order the screen lists them (newest first). */
/** Which blocks the list on screen names. */
const listed = (view: FakeElement): string[] =>
  view.querySelectorAll(".blockrow__name").map((row) => row.textContent);

const versionRows = (view: FakeElement): string[][] =>
  view.querySelectorAll(".versions .version").map((row) => row.children.map((cell) => cell.textContent));

const publishLabel = (view: FakeElement): string => view.querySelector("button[type='submit']")!.textContent;

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
    const view = await open("/blocks-new");

    expect(classes(view)).toContain("lib--open");
    expect(view.querySelector("[id='writer-source']")).not.toBeNull();
    expect(view.querySelector(".back")?.getAttribute("href")).toBe("/app/blocks");
  });

  test("a block actually called `new` opens as itself, and not as the writer", async () => {
    // `/blocks/new` used to mean "the writer", which made the name unusable: the block called `new`
    // could never be read, edited or versioned, and the writer was published as if it were a block.
    const view = await open("/blocks/new");

    expect(classes(view)).toContain("lib--open");
    expect(view.querySelector(".detail .h2")?.textContent).toBe("new");
    expect(view.querySelector("[id='writer-source']")).toBeNull();
    expect(view.querySelector(".code code")?.textContent).toBe(CALLED_NEW);
  });

  test("the way to the writer is the address that cannot be a block", async () => {
    const view = await open("/blocks");
    expect(view.querySelector(".head .btn")?.getAttribute("href")).toBe("/app/blocks-new");
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

  test("the list is the library's own names, not what this device happens to have opened", async () => {
    // There was no route to ask before `GET /v1/blocks`, so the list on the left was a list of names
    // typed into this browser, and a fresh one was told the library was empty when it was not.
    const view = await open("/blocks");
    await tick();

    expect(listed(view)).toEqual(["accent", "count-words", "half-gone", "new", "sulk"]);
    expect(text(view)).toContain("5 blocks in the library.");
    // Each row says how many versions it has, which is the other half of what the route returns.
    expect(lib(view).querySelector(".blockrow__meta")?.textContent).toBe("1 version");
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
  // A draft lives in this tab's sessionStorage, which outlives a render. Each test starts with an
  // empty one so the writer opens where it is supposed to.
  beforeEach(() => {
    sessionStorage.clear();
    posted.length = 0;
  });

  test("nothing on the writer carries a style attribute", async () => {
    // The CSP the server sends is `style-src 'self'`, so an inline style is dropped and the label
    // sits out of line with the buttons it names.
    expect(styled(await open("/blocks-new"))).toEqual([]);
  });

  test("the label beside the template buttons is the class that zeroes its margin", async () => {
    const view = await open("/blocks-new");
    const label = view.querySelector(".row .label");
    expect(label?.textContent).toBe("Start from");
    expect(label?.classList.contains("label--inline")).toBe(true);
    expect(ruleBody(".label--inline")).toMatch(/margin:\s*0/);
  });

  test("bytes that are already the newest version are not offered as a new one", async () => {
    // SPEC 3.4: a new version exists only if the SHA-256 differs from the latest one, and the store
    // hands back v1 when the bytes match. The button used to say "Publish v2" the whole time.
    const view = await open("/blocks/count-words/edit");
    expect(publishLabel(view)).toBe("Unchanged, still v1");

    const source = view.querySelector("[id='writer-source']")!;
    source.value = `${COUNT_WORDS}\n# one line more\n`;
    source.fire("input");
    expect(publishLabel(view)).toBe("Publish v2");
  });

  test("and pressing it says nothing changed, instead of landing on v1 with no message", async () => {
    const view = await open("/blocks/count-words/edit");
    view.querySelector("form")!.fire("submit");
    // The writer asks the library what these bytes would become before it lets itself post, so the
    // answer is a microtask away rather than synchronous with the click.
    await tick();
    expect(text(view)).toContain("Nothing has changed: v1 is already these exact bytes.");
    expect(posted).toEqual([]);
  });

  test("a new block whose name the library already has is not offered as version 1", async () => {
    // The whole of it: /blocks-new never asked whether the name in the header was taken, so a file
    // declaring count-words was labelled "Publish v1" while the store was going to answer v2.
    const view = await open("/blocks-new");
    const area = view.querySelector("textarea")!;
    area.value = COUNT_WORDS;
    area.fire("input");
    await tick();

    expect(text(view)).toContain("New version of count-words");
    expect(publishLabel(view)).toBe("Unchanged, still v1");

    view.querySelector("form")!.fire("submit");
    await tick();
    expect(text(view)).toContain("Nothing has changed: v1 is already these exact bytes.");
    expect(posted).toEqual([]);
  });

  test("a name the library has never had is still version one", async () => {
    const view = await open("/blocks-new");
    const area = view.querySelector("textarea")!;
    area.value = COUNT_WORDS.replace(/count-words/g, "count-syllables");
    area.fire("input");
    await tick();

    expect(text(view)).toContain("New block");
    expect(publishLabel(view)).toBe("Publish v1");
  });

  test("text typed into the writer is still there when the screen is rebuilt", async () => {
    // A reload, or a walk to the Runs screen and back, used to open the writer at the template again
    // with the half-written block gone and no message about it.
    const view = await open("/blocks-new");
    const area = view.querySelector("textarea")!;
    area.value = "#!/bin/bash\n# name: unfinished\n# still thinking about the rest of this\n";
    area.fire("input");

    const away = await open("/blocks");
    await tick(); // the library's own list arrives after the screen does
    expect(text(away)).toContain("count-words");
    const back = await open("/blocks-new");
    expect(back.querySelector("textarea")!.value).toBe(
      "#!/bin/bash\n# name: unfinished\n# still thinking about the rest of this\n",
    );
    expect(text(back)).toContain("This is what you had written here, not what the library has.");
  });

  test("a block whose newest version cannot be read starts from the one that can, and says so", async () => {
    const view = await open("/blocks/half-gone/edit");

    expect(text(view)).toContain("v2 is listed and its bytes could not be read, so this starts from v1.");
    expect(view.querySelector("textarea")!.value).toBe(HALF_GONE);
    // The store's newest is still v2, so the next one is v3 whatever the writer started from.
    expect(publishLabel(view)).toBe("Publish v3");
  });
});

// ---------- what a version may be said to be ----------
//
// Three claims the screen used to make that were not true: that a version's size was its character
// count, that an address naming a version the library does not keep was that version, and that a
// name it had been asked for was a block. Each one is a thing the reader would act on.

describe("what a version is allowed to be said", () => {
  test("its size is the server's byte count, not a count of characters", async () => {
    // The fixture is one character and two bytes apart, which is the whole of the bug.
    expect(ACCENTED_BYTES).toBe(ACCENTED.length + 1);
    const count = new Intl.NumberFormat().format(ACCENTED_BYTES);
    expect(versionRows(await open("/blocks/accent"))[0]![1]).toBe(`${count} bytes`);
  });

  test("a version the store cannot open keeps its row, and says the bytes are gone", async () => {
    const view = await open("/blocks/half-gone");

    const rows = versionRows(view);
    expect(rows.map((row) => row[0])).toEqual(["v2", "v1"]);
    expect(rows[0]![1]).toBe("no stored file");
    expect(rows[1]![1]).toBe(`${new Intl.NumberFormat().format(bytes(HALF_GONE))} bytes`);
    // The card for the unreadable version says it cannot speak for the file, and does not draw a
    // contract or an empty source in its place.
    expect(text(view)).toContain("unreadable");
    expect(text(view)).toContain("does not have its bytes");
    // The section is there and says the file is missing; nothing is drawn in its place that could be
    // mistaken for the block, which is what an empty `<pre>` would have been.
    expect(view.querySelectorAll("pre").length).toBe(0);
    // The version that can be read is one click away, and the list is not on fire.
    expect(linkLabeled(view, "Read v1 instead")).toBeDefined();

    const v1 = await open("/blocks/half-gone/1");
    expect(text(v1)).toContain("Source of v1");
    expect(text(v1)).toContain("half-gone");
  });

  test("one version failing for a reason that is not 'gone' does not take the block down", async () => {
    // It used to be: only one code was caught, and everything else was rethrown to the whole screen.
    const view = await open("/blocks/sulk/2");

    expect(versionRows(view).map((row) => row[0])).toEqual(["v2", "v1"]);
    expect(text(view)).toContain("unreadable");
    expect(text(view)).toContain("the store is having a moment");
    expect(linkLabeled(view, "Read v1 instead")).toBeDefined();
  });

  test("a version address that is not a number is not the newest version wearing a hat", async () => {
    // `Number("1.0")` is 1, so /blocks/count-words/1.0 used to open v1 under an address that said
    // something else. Only a plain decimal is a version.
    for (const address of ["1.0", "0x1", "+1", "1e0"]) {
      const view = await open(`/blocks/count-words/${address}`);
      expect(text(view)).toContain(`No version ${address} of count-words`);
      expect(text(view)).not.toContain("Source of");
    }
  });

  test("an address with more in it than a version says so", async () => {
    const view = await open("/blocks/count-words/1/anything");

    expect(text(view)).toContain("Nothing at this address");
    expect(text(view)).not.toContain("Source of");
  });

  test("an address for version 99 is not quietly the newest version instead", async () => {
    const view = await open("/blocks/count-words/99");

    expect(text(view)).toContain("No version 99 of count-words");
    // It used to fall through and title the source of v1 "Source of v1" under an address saying 99.
    expect(text(view)).not.toContain("Source of");
    expect(view.querySelector(".back")?.getAttribute("href")).toBe("/app/blocks/count-words");
  });

  test("a name the library has never heard of does not join the list of blocks", async () => {
    const start = await open("/blocks");
    await tick(); // the list is the library's answer, and it arrives after the screen does
    const before = listed(start);

    const view = await open("/blocks/ghost-block");
    expect(text(view)).toContain("No such block");
    // The list is the library, asked for by name: a typo is not in it, and opening one does not add it.
    expect(listed(view)).toEqual(before);

    // and a block that is there is on the list before anyone opens it
    expect(before).toContain("accent");
    expect(listed(await open("/blocks/accent"))).toContain("accent");
  });
});
