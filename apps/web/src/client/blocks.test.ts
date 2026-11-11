// The block library's three screens: the list, one block, and the writer. Each is tested through the
// text it serves, the way the rest of the client tests work, over a fake library that answers the
// same routes apps/api does. The list's four-at-a-time reads and the writer's publish decisions are
// the two things a screenshot cannot prove.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { buildAssets } from "../assets.ts";
import { blockSource, decls, installDom, serveModules, uninstallDom, type FakeElement } from "./client.testkit.ts";
import type { Route } from "./app.ts";

const dom = installDom({ href: "http://x/app/blocks" });
const served = serveModules(["blocks"]);
const { session } = (await import(join(served, "api.js"))) as typeof import("./api.ts");
const { renderBlocks } = (await import(join(served, "blocks.js"))) as typeof import("./blocks.ts");
const { formatBytes } = (await import(join(served, "ui.js"))) as typeof import("./ui.ts");
const sheet = new TextDecoder().decode(buildAssets().files.get("assets/style.css")!.data);

/** The body of one rule, written out with this exact selector. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(sheet);
  if (found === null) throw new Error(`style.css has no rule whose selector is exactly ${selector}`);
  return found[1]!;
}

const realFetch = globalThis.fetch;

afterAll(() => {
  uninstallDom(dom);
  rmSync(served, { recursive: true, force: true });
  (globalThis as unknown as Record<string, unknown>).fetch = realFetch;
});

// ---------- the fake library ----------

const COUNT_WORDS = blockSource(
  "count-words",
  decls("inputs", [["text", "string"]]),
  decls("outputs", [["words", "integer"]]),
);

/** A block whose name is the word the router used to mean "new", which is the whole of BASHR-36. */
const CALLED_NEW = blockSource("new", decls("inputs", [["text", "string"]]), decls("outputs", [["words", "integer"]]));

/** A block with a character in it that is not one byte, so bytes and characters are two numbers. */
const ACCENTED = `${blockSource("accent", decls("inputs", [["text", "string"]]), decls("outputs", [["result", "string"]]))}\n# café\n`;
const ACCENTED_BYTES = new TextEncoder().encode(ACCENTED).length;

/** A block large enough that its size is formatted in kilobytes. */
const LARGE = `${blockSource("large", decls("inputs", [["text", "string"]]), decls("outputs", [["result", "string"]]))}\n# ${"x".repeat(2000)}\n`;

/** The half-published block: the list names v2, and its bytes are not there to read. */
const HALF_GONE = blockSource("half-gone", decls("inputs", [["text", "string"]]), decls("outputs", [["result", "string"]]));

/** A block whose v2 fails for a reason that is not "gone". */
const SULK = blockSource("sulk", decls("inputs", [["text", "string"]]), decls("outputs", [["result", "string"]]));

const BAD_HEADER = `#!/usr/bin/env bash
# ---
# name: bad-header
# description: A block whose header never closes.
# inputs:
#   text:
#     type: string
echo hi
`;

const VERSIONED_V1 = `${blockSource("versioned", decls("inputs", [["text", "string"]]), decls("outputs", [["words", "integer"]]))}# v1\n`;
const VERSIONED_V2 = `${blockSource(
  "versioned",
  decls("inputs", [["text", "string"], ["limit", "integer"]]),
  decls("outputs", [["words", "integer"], ["lines", "integer"]]),
).replace("The versioned block.", "The newest versioned block.")}# v2\n`;

const LIBRARY: Record<string, Record<number, string>> = {
  accent: { 1: ACCENTED },
  "bad-header": { 1: BAD_HEADER },
  "count-words": { 1: COUNT_WORDS },
  "half-gone": { 1: HALF_GONE },
  large: { 1: LARGE },
  new: { 1: CALLED_NEW },
  sulk: { 1: SULK },
  versioned: { 1: VERSIONED_V1, 2: VERSIONED_V2 },
};

for (const name of ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota"]) {
  LIBRARY[name] = { 1: blockSource(name, decls("inputs", [["text", "string"]]), decls("outputs", [["result", "string"]])) };
}

/** Versions the list names and the store cannot open. */
const LOST: Record<string, number[]> = { "half-gone": [2] };
const BROKEN: Record<string, number[]> = { sulk: [2] };

const shaFor = (name: string, version: number): string => `${name}${version}`.padEnd(64, "0");

const meta = (name: string, version: number, size: number) => ({
  name,
  version,
  sha256: shaFor(name, version),
  size,
  created_at: `2026-11-0${version}T09:00:00Z`,
});

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const asText = (body: string): Response =>
  new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "x-block-sha256": "x" } });

const bytes = (value: string): number => new TextEncoder().encode(value).length;

/** What the screen has posted, which is how "nothing was published" gets proved. */
const posted: { name: string; content: string }[] = [];

/** The list's reads run at most four at a time; the fake slows them enough for the overlap to show. */
let contentDelay = 0;
let activeContent = 0;
let maxContent = 0;
/** The list's empty state needs a library with nothing in it. */
let noBlocks = false;

const versionsOf = (name: string): number[] =>
  [...new Set([...Object.keys(LIBRARY[name] ?? {}).map(Number), ...(LOST[name] ?? []), ...(BROKEN[name] ?? [])])].toSorted(
    (a, b) => a - b,
  );

async function answer(href: string, init?: RequestInit): Promise<Response> {
  const parts = new URL(href).pathname.split("/").filter((part) => part !== "");

  if (init?.method === "POST" && parts.join("/").match(/^v1\/blocks\/[^/]+\/versions$/)) {
    const name = parts[2] ?? "";
    const body = JSON.parse(String(init.body ?? "{}")) as { content?: string };
    const content = body.content ?? "";
    posted.push({ name, content });
    const versions = versionsOf(name);
    return json(meta(name, (versions.at(-1) ?? 0) + 1, bytes(content)), 201);
  }
  if (init?.method === "POST") return json({ code: "not_found", message: "no route" }, 404);

  if (parts.join("/") === "v1/blocks") {
    return json({
      blocks: noBlocks
        ? []
        : Object.keys(LIBRARY)
            .toSorted()
            .map((name) => {
              const versions = versionsOf(name);
              return { name, latest: versions.at(-1), versions: versions.length };
            }),
    });
  }

  const name = parts[2] ?? "";
  const block = LIBRARY[name];
  if (parts[0] !== "v1" || parts[1] !== "blocks" || block === undefined) {
    return json({ code: "block_not_found", message: `block "${name}" has no versions` }, 404);
  }
  const versions = versionsOf(name);
  if (parts.length === 3) {
    return json({
      name,
      latest: versions.at(-1),
      versions: versions.map((version) => meta(name, version, bytes(block[version] ?? ""))),
    });
  }
  if (parts[4] !== "content") return json({ code: "not_found", message: "no route" }, 404);
  const wanted = Number(parts[3]);

  activeContent += 1;
  maxContent = Math.max(maxContent, activeContent);
  if (contentDelay > 0) await new Promise((done) => setTimeout(done, contentDelay));
  activeContent -= 1;

  if ((BROKEN[name] ?? []).includes(wanted)) {
    return json({ code: "internal", message: "the store is having a moment" }, 500);
  }
  if (block[wanted] !== undefined) return asText(block[wanted]!);
  return json({ code: "block_version_not_found", message: `block "${name}" has no version ${parts[3]}` }, 404);
}

(globalThis as unknown as Record<string, unknown>).fetch = (href: string | URL, init?: RequestInit) =>
  answer(href.toString(), init);

// ---------- opening a path ----------

function route(path: string): Route {
  const url = new URL(`http://x${path}`);
  const clean = url.pathname.replace(/^\/app/, "");
  return { path: clean, parts: clean.split("/").filter((part) => part !== ""), query: url.searchParams };
}

async function open(path: string, scope: "read" | "write" | "admin" = "admin"): Promise<FakeElement> {
  session.identity = { name: "test", scope, admin: scope === "admin" };
  const view = dom.document.createElement("div");
  await renderBlocks(view as unknown as HTMLElement, route(path));
  return view;
}

const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

async function settle(check: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    await tick();
    if (check()) return;
  }
}

const text = (view: FakeElement): string => view.textContent;

const linkLabeled = (view: FakeElement, label: string): FakeElement | undefined =>
  view.querySelectorAll("a").find((link) => link.textContent === label);

const listed = (view: FakeElement): string[] => view.querySelectorAll(".table__link").map((link) => link.textContent);

const rowNamed = (view: FakeElement, name: string): FakeElement | undefined =>
  view.querySelectorAll("tbody tr").find((row) => row.querySelector(".table__link")?.textContent === name);

const shownPanel = (view: FakeElement): FakeElement | undefined =>
  view.querySelectorAll(".tabpanel").find((panel) => !panel.hidden);

const publishButton = (view: FakeElement): FakeElement => {
  const node = view.querySelector("button[type='submit']");
  if (node === null) throw new Error("the writer drew no Publish button");
  return node;
};

const publishOff = (view: FakeElement): boolean => publishButton(view).getAttribute("disabled") !== null;

const publishReason = (view: FakeElement): string | null =>
  view.querySelector(".control-off__reason")?.textContent ?? null;

beforeEach(() => {
  sessionStorage.clear();
  posted.length = 0;
  contentDelay = 0;
  activeContent = 0;
  maxContent = 0;
  noBlocks = false;
});

// ---------- the list ----------

describe("the blocks list", () => {
  test("is its own screen: one table, the library's names, and the write action", async () => {
    const view = await open("/blocks");

    expect(view.querySelector(".page-header .title")?.textContent).toBe("Blocks");
    expect(view.querySelector(".lib")).toBeNull();
    expect(view.querySelectorAll("thead th").map((head) => head.textContent)).toEqual([
      "Name",
      "Description",
      "Runtime",
      "Latest",
      "Versions",
    ]);
    expect(listed(view)).toEqual(Object.keys(LIBRARY).toSorted());
    expect(linkLabeled(view, "New block")?.getAttribute("href")).toBe("/app/blocks-new");
    expect(linkLabeled(view, "New block")?.classList.contains("btn--ink")).toBe(true);
  });

  test("each row's description and runtime are read from its latest version", async () => {
    const view = await open("/blocks");
    const row = rowNamed(view, "count-words")!;

    expect(row.querySelectorAll("td")[1]?.textContent).toBe("The count-words block.");
    expect(row.querySelectorAll("td")[2]?.textContent).toBe("bash");
    expect(row.querySelectorAll("td")[3]?.textContent).toBe("v1");
    expect(row.querySelectorAll("td")[4]?.textContent).toBe("1");
  });

  test("reads the rows four at a time", async () => {
    contentDelay = 6;
    const view = await open("/blocks");

    expect(maxContent).toBe(4);
    for (const name of Object.keys(LIBRARY)) {
      if (name === "bad-header") continue;
      expect(rowNamed(view, name)!.querySelectorAll("td")[1]?.textContent).not.toBe("—");
    }
  });

  test("a row whose latest file cannot be read says so, and the rest of the list stays", async () => {
    const view = await open("/blocks");
    const row = rowNamed(view, "half-gone")!;

    expect(row.querySelectorAll("td")[1]?.textContent).toContain("v2 could not be read");
    expect(row.querySelectorAll("td")[1]?.textContent).toContain("block_version_not_found");
    expect(rowNamed(view, "count-words")!.querySelectorAll("td")[1]?.textContent).toBe("The count-words block.");
  });

  test("an empty library says so and still offers New block", async () => {
    noBlocks = true;
    const view = await open("/blocks");

    expect(text(view)).toContain("No blocks in the library yet.");
    expect(linkLabeled(view, "New block")?.getAttribute("href")).toBe("/app/blocks-new");
  });

  test("a read-only token sees the list but is offered no New block", async () => {
    const view = await open("/blocks", "read");

    expect(listed(view)).toEqual(Object.keys(LIBRARY).toSorted());
    expect(linkLabeled(view, "New block")).toBeUndefined();
  });
});

// ---------- one block ----------

describe("one block", () => {
  test("the header carries the breadcrumb, name, runtime, description and version select", async () => {
    const view = await open("/blocks/count-words");

    expect(view.querySelector(".crumbs a")?.textContent).toBe("Blocks");
    expect(view.querySelector(".crumbs .crumbs__current")?.textContent).toBe("count-words");
    expect(view.querySelector(".page-header .title")?.textContent).toBe("count-words");
    expect(view.querySelector(".page-header__title-row .stamp")?.textContent).toBe("bash");
    expect(view.querySelector(".page-header .lead")?.textContent).toBe("The count-words block.");
    expect(view.querySelector("[id='block-version']")?.getAttribute("aria-label")).toBe("Version");
    expect(view.querySelector("[id='block-version']")?.value).toBe("1");
    expect(linkLabeled(view, "New version")?.getAttribute("href")).toBe("/app/blocks/count-words/edit?version=1");
  });

  test("the contract tab shows inputs, then outputs", async () => {
    const view = await open("/blocks/count-words");
    const panel = shownPanel(view)!;

    expect(panel.querySelectorAll("h2").map((head) => head.textContent)).toEqual(["Inputs", "Outputs"]);
    expect(panel.querySelectorAll("table").length).toBe(2);
    expect(panel.querySelectorAll("tbody tr").length).toBe(2);
    expect(text(panel)).toContain("text");
    expect(text(panel)).toContain("string");
    expect(text(panel)).toContain("required");
    expect(text(panel)).toContain("words");
    expect(text(panel)).toContain("integer");
  });

  test("the source tab is the file, with line numbers", async () => {
    const view = await open("/blocks/count-words?tab=source");
    const panel = shownPanel(view)!;

    expect(panel.querySelector(".codeview__code")?.textContent).toBe(COUNT_WORDS);
    expect(panel.querySelector(".codeview__gutter")?.textContent?.split("\n")[0]).toBe("1");
    expect(panel.querySelector(".codeview__gutter")?.textContent?.split("\n").length).toBe(COUNT_WORDS.replace(/\n$/, "").split("\n").length);
  });

  test("the versions tab shows version, stored time, twelve characters of sha256 and a formatted size", async () => {
    const view = await open("/blocks/large?tab=versions");
    const panel = shownPanel(view)!;
    const cells = panel.querySelectorAll("tbody tr")[0]!.querySelectorAll("td").map((cell) => cell.textContent);

    expect(cells[0]).toBe("v1");
    expect(cells[1]).not.toBe("");
    expect(cells[2]).toBe(shaFor("large", 1).slice(0, 12));
    expect(cells[3]).toBe(formatBytes(bytes(LARGE)));
    expect(cells[3]).toContain("KB");

    // The size is the server's byte count, not the length the source has as characters.
    expect(ACCENTED_BYTES).not.toBe(ACCENTED.length);
    const accent = await open("/blocks/accent?tab=versions");
    expect(shownPanel(accent)!.querySelectorAll("tbody tr")[0]!.querySelectorAll("td")[3]?.textContent).toBe(
      formatBytes(ACCENTED_BYTES),
    );
  });

  test("the version in the address decides what is shown, and the default is the latest", async () => {
    const latest = await open("/blocks/versioned");
    expect(latest.querySelector(".page-header .lead")?.textContent).toBe("The newest versioned block.");
    expect(latest.querySelector("[id='block-version']")?.value).toBe("2");

    const older = await open("/blocks/versioned?version=1");
    expect(older.querySelector(".page-header .lead")?.textContent).toBe("The versioned block.");
    expect(older.querySelector("[id='block-version']")?.value).toBe("1");
    expect(older.querySelector("[id='block-version']")?.querySelectorAll("option").map((option) => option.textContent)).toEqual([
      "v2 (latest)",
      "v1",
    ]);
  });

  test("picking a version puts it in the address and repaints the block", async () => {
    const view = await open("/blocks/versioned");
    const writes: string[] = [];
    const history = globalThis.history as unknown as { replaceState: (state: unknown, title: string, href: string) => void };
    const previous = history.replaceState;
    history.replaceState = (_state: unknown, _title: string, href: string) => writes.push(href);

    try {
      const select = view.querySelector("[id='block-version']")!;
      select.value = "1";
      select.fire("change");
      await settle(() => view.querySelector(".page-header .lead")?.textContent === "The versioned block.");

      expect(writes.at(-1)).toBe("/app/blocks/versioned?version=1");
      expect(view.querySelector("[id='block-version']")?.value).toBe("1");
    } finally {
      history.replaceState = previous;
    }
  });

  test("header problems are listed in one alarm above the tabs", async () => {
    const view = await open("/blocks/bad-header");

    expect(view.querySelectorAll(".alarm").length).toBe(1);
    expect(view.querySelector(".alarm")?.textContent).toContain("1 header problem");
    expect(view.querySelector(".alarm")?.textContent).toContain("block_header_malformed");
    expect(view.querySelector(".tabs")).not.toBeNull();
  });

  test("a version whose file is gone keeps its row and draws no contract or source in its place", async () => {
    const view = await open("/blocks/half-gone?version=2");

    expect(view.querySelector(".alarm")?.textContent).toContain("v2 could not be read");
    expect(shownPanel(view)?.querySelectorAll("table").length).toBe(0);
    expect(text(shownPanel(view)!)).toContain("This version's file could not be read.");

    const versions = await open("/blocks/half-gone?tab=versions");
    expect(shownPanel(versions)!.querySelectorAll("tbody tr").map((row) => row.children[0]?.textContent)).toEqual(["v2", "v1"]);
  });

  test("one version failing for a reason that is not 'gone' does not take the block down", async () => {
    const view = await open("/blocks/sulk?version=2");

    expect(view.querySelector(".alarm")?.textContent).toContain("internal");
    expect(view.querySelector(".alarm")?.textContent).toContain("the store is having a moment");
    expect(view.querySelector(".tabs")).not.toBeNull();
  });

  test("a version the library does not have is not quietly the newest version", async () => {
    for (const address of ["99", "1.0", "0x1", "1e0"]) {
      const view = await open(`/blocks/count-words?version=${address}`);
      expect(text(view)).toContain(`No version ${address} of count-words`);
      expect(view.querySelector(".tabs")).toBeNull();
    }
    const plus = await open("/blocks/count-words/+1");
    expect(text(plus)).toContain("No version +1 of count-words");
    const legacy = await open("/blocks/count-words/1.0");
    expect(text(legacy)).toContain("No version 1.0 of count-words");
  });

  test("a legacy version address still opens that version", async () => {
    const view = await open("/blocks/versioned/1");
    expect(view.querySelector(".page-header .lead")?.textContent).toBe("The versioned block.");
  });

  test("an address with more in it than a version says so", async () => {
    const view = await open("/blocks/count-words/1/anything");
    expect(text(view)).toContain("There is nothing at this address.");
    expect(view.querySelector(".tabs")).toBeNull();
  });

  test("a block actually called `new` opens as itself, and not as the writer", async () => {
    const view = await open("/blocks/new");

    expect(view.querySelector(".page-header .title")?.textContent).toBe("new");
    expect(view.querySelector("[id='writer-source']")).toBeNull();
    expect(shownPanel(view)?.querySelector(".codeview__code")).toBeNull();
  });

  test("a name the library has never heard of does not join the list of blocks", async () => {
    const view = await open("/blocks/ghost-block");
    expect(text(view)).toContain("There is no block called ghost-block.");
    expect(view.querySelector(".tabs")).toBeNull();
  });

  test("a read-only token is offered no New version", async () => {
    const view = await open("/blocks/count-words", "read");
    expect(linkLabeled(view, "New version")).toBeUndefined();
    expect(view.querySelector("[id='block-version']")).not.toBeNull();
  });
});

// ---------- the writer ----------

describe("the block writer", () => {
  test("the source pane is code: the mono face, no ligatures, the code line height", () => {
    const body = ruleBody(".block-writer__source");

    expect(body).toMatch(/font-family:\s*var\(--font-code\)/);
    expect(body).toMatch(/font-variant-ligatures:\s*none/);
    expect(body).toMatch(/line-height:\s*1\.5/);
  });

  test("a new block opens with its toolbar and live declaration", async () => {
    const view = await open("/blocks-new");

    expect(view.querySelector(".block-writer__title .h2")?.textContent).toBe("New block");
    expect(publishButton(view).textContent).toBe("Publish version");
    expect(publishOff(view)).toBe(true);
    expect(publishReason(view)).toContain("Give the block its own name");
    expect(view.querySelector(".block-writer__title .stamp")?.textContent).toBe("unsaved");
    expect(view.querySelector(".block-writer__title .stamp")?.hidden).toBe(true);
    expect(view.querySelector("[id='writer-source']")?.value).toContain("name: new-block");
    expect(text(view.querySelector(".block-writer__declares")!)).toContain("What this file declares");
    expect(text(view.querySelector(".block-writer__declares")!)).toContain("example");
    expect(text(view.querySelector(".block-writer__declares")!)).toContain("result");
  });

  test("typing marks the file unsaved and updates what it declares", async () => {
    const view = await open("/blocks-new");
    const source = view.querySelector("[id='writer-source']")!;
    source.value = blockSource("fresh-block", decls("inputs", [["notes", "string"]]), decls("outputs", [["lines", "integer"]]));
    source.fire("input");

    expect(view.querySelector(".block-writer__title .stamp")?.hidden).toBe(false);
    expect(text(view.querySelector(".block-writer__declares")!)).toContain("fresh-block");
    expect(text(view.querySelector(".block-writer__declares")!)).toContain("notes");
    expect(text(view.querySelector(".block-writer__declares")!)).toContain("lines");
    expect(publishOff(view)).toBe(false);
    expect(publishReason(view)).toBeNull();
  });

  test("a draft from this tab is put back when the writer is rebuilt", async () => {
    const first = await open("/blocks-new");
    const typed = "#!/usr/bin/env bash\n# name: unfinished\n# still thinking about the rest of this\n";
    const source = first.querySelector("[id='writer-source']")!;
    source.value = typed;
    source.fire("input");

    await open("/blocks");
    const back = await open("/blocks-new");
    expect(back.querySelector("[id='writer-source']")?.value).toBe(typed);
    expect(back.querySelector(".block-writer__title .stamp")?.hidden).toBe(false);
  });

  test("the address's version is what the writer opens, and unsaved is measured against it", async () => {
    const older = await open("/blocks/versioned/edit?version=1");
    expect(older.querySelector("[id='writer-source']")?.value).toBe(VERSIONED_V1);
    expect(older.querySelector(".block-writer__title .stamp")?.hidden).toBe(true);
    expect(text(older.querySelector(".block-writer__declares")!)).toContain("The versioned block.");
    expect(publishOff(older)).toBe(false);

    const latest = await open("/blocks/versioned/edit");
    expect(latest.querySelector("[id='writer-source']")?.value).toBe(VERSIONED_V2);
    expect(publishOff(latest)).toBe(true);
    expect(publishReason(latest)).toContain("Nothing has changed: v2");
  });

  test("bytes that are already the newest version are not offered as a new one", async () => {
    const view = await open("/blocks/count-words/edit");
    expect(publishOff(view)).toBe(true);
    expect(publishReason(view)).toContain("Nothing has changed: v1");

    view.querySelector("form")!.fire("submit");
    await tick();
    expect(text(view)).toContain("Nothing has changed: v1 is already these exact bytes.");
    expect(posted).toEqual([]);
  });

  test("a new block whose name is already stored and whose bytes are identical is not published", async () => {
    const view = await open("/blocks-new");
    const source = view.querySelector("[id='writer-source']")!;
    source.value = COUNT_WORDS;
    source.fire("input");
    await settle(() => publishReason(view)?.includes("Nothing has changed: v1") === true);

    expect(publishOff(view)).toBe(true);
    view.querySelector("form")!.fire("submit");
    await tick();
    expect(posted).toEqual([]);
  });

  test("a new block whose name the library already has publishes the changed bytes as the next version", async () => {
    const view = await open("/blocks-new");
    const source = view.querySelector("[id='writer-source']")!;
    source.value = `${COUNT_WORDS}\n# changed\n`;
    source.fire("input");

    view.querySelector("form")!.fire("submit");
    await settle(() => posted.length > 0);

    expect(posted.length).toBe(1);
    expect(posted[0]!.name).toBe("count-words");
    expect(posted[0]!.content).toBe(`${COUNT_WORDS}\n# changed\n`);
    expect(document.getElementById("announce")?.textContent).toContain("count-words published as version 2.");
  });

  test("a name the library has never had publishes as version one", async () => {
    const view = await open("/blocks-new");
    const source = view.querySelector("[id='writer-source']")!;
    source.value = blockSource("brand-new", decls("inputs", [["text", "string"]]), decls("outputs", [["result", "string"]]));
    source.fire("input");

    view.querySelector("form")!.fire("submit");
    await settle(() => posted.length > 0);

    expect(posted[0]!.name).toBe("brand-new");
    expect(document.getElementById("announce")?.textContent).toContain("brand-new published as version 1.");
  });

  test("a block whose newest version cannot be read starts from the one that can, and says so", async () => {
    const view = await open("/blocks/half-gone/edit");

    expect(text(view)).toContain("v2 could not be read. This starts from v1.");
    expect(view.querySelector("[id='writer-source']")?.value).toBe(HALF_GONE);
    expect(publishOff(view)).toBe(false);
  });

  test("a header with problems is listed, and nothing is offered to publish", async () => {
    const view = await open("/blocks/bad-header/edit");

    expect(text(view.querySelector(".block-writer__declares")!)).toContain("block_header_malformed");
    expect(publishOff(view)).toBe(true);
    expect(publishReason(view)).toContain("Fix 1 problem first.");
  });

  test("a read-only token opening a writer says so, with no source and no publish", async () => {
    const view = await open("/blocks-new", "read");

    expect(text(view)).toContain("This token can read only.");
    expect(view.querySelector("[id='writer-source']")).toBeNull();
    expect(view.querySelector("button[type='submit']")).toBeNull();
  });
});
