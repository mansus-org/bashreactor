// The block library. A block's contract is read out of its own header — `GET /v1/blocks/:name` for
// the versions and `.../content` for the bytes — so what this screen says a block declares is what
// the file declares. Ported from mockup/blocks.js.
//
// The list on the left is the library's own, out of `GET /v1/blocks`: names and version counts, no
// source. That is one small request, and it is made beside the block the address asked for rather
// than before it, because the block is the reason the page was opened. A version has no note,
// because the store keeps no note.

import { api, ApiError, canWrite } from "./api.js";
import { announce, el, errorBox, fill, sign, stateLine } from "./dom.js";
import { latest, parseBlock } from "./model.js";
import type { Contract, LibraryEntry, LibraryVersion } from "./model.js";
import type { LibraryName } from "./api.js";
import type { Route } from "./app.js";
import { navigate } from "./app.js";

const STARTERS: Record<string, string> = {
  bash: `\nout="$(printf '%s' "$INPUT_EXAMPLE" | tr a-z A-Z)"\nprintf '%s' "$out" > "$OUTPUT_RESULT"\n`,
  uv: `\nuv run --quiet --no-project --script - <<'PY'\nimport os\n\nwith open(os.environ["OUTPUT_RESULT"], "w", encoding="utf-8") as output:\n    output.write(os.environ["INPUT_EXAMPLE"].upper())\nPY\n`,
  bun: `\nbun run - <<'TS'\nawait Bun.write(process.env.OUTPUT_RESULT!, process.env.INPUT_EXAMPLE!.toUpperCase());\nTS\n`,
};

const FRONT = `#!/usr/bin/env bash
# ---
# name: new-block
# description: Say in one line what this block does.
# inputs:
#   example:
#     type: string
#     description: Replace this with what the block reads.
#     default: hello
# outputs:
#   result:
#     type: string
#     description: Replace this with what the block produces.
# ---
`;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** What a version segment of an address has to look like to be a version at all. */
const VERSION = /^[1-9][0-9]*$/;

const heading = () => [
  el(
    "div",
    { class: "head" },
    el(
      "div",
      { class: "head__text" },
      el("h1", { class: "title" }, "Blocks"),
      el(
        "p",
        { class: "lead" },
        "What a pipeline can run. A block is one bash file, and its front matter says what goes in and what comes out.",
      ),
    ),
    el("a", { class: "btn btn--ink", href: "/app/blocks-new", "data-link": "" }, "Write a block"),
  ),
];

/**
 * The size of a version as the server counted it. The store keeps the byte count of the file it
 * wrote, so this is the file's real size; counting the characters of the text here would be wrong
 * by however many of them are not ASCII, and say so in the same breath as the word "bytes".
 */
function sizeLabel(bytes: number | undefined): string {
  return bytes === undefined ? "no stored file" : `${new Intl.NumberFormat().format(bytes)} bytes`;
}

/** The name in the box is the block to look at. */
function openNamed(name: string): void {
  if (name !== "") navigate(`/blocks/${name}`);
}

export async function renderBlocks(view: HTMLElement, route: Route): Promise<void> {
  const list = el("ul", { class: "blocklist" });
  const nameInput = el("input", {
    id: "block-name",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "count-words",
    "aria-describedby": "block-name-help",
  });
  const openButton = el("button", { class: "btn", type: "button", onclick: () => openNamed(nameInput.value.trim()) }, "Open");
  const count = el("p", { class: "help", role: "status" });
  const listPane = el(
    "section",
    { class: "lib__list", "aria-label": "Blocks" },
    el(
      "div",
      { class: "field" },
      el("label", { class: "label", for: "block-name" }, "Open a block by name"),
      el("div", { class: "row" }, nameInput, openButton),
      el(
        "p",
        { class: "help", id: "block-name-help" },
        "Type the name of a block to open it, or pick one out of the library below.",
      ),
    ),
    count,
    list,
  );
  const detail = el("section", { class: "detail", "aria-labelledby": "detail-title", tabindex: "-1" });
  const lib = el("div", { class: "lib" }, listPane, detail);
  view.replaceChildren(...heading(), lib);

  /** Every block the library holds, once `loadList` has had an answer. */
  let shelf: LibraryName[] = [];
  /** Why the list is empty when it should not be, which is the list's own news to tell. */
  let shelfProblem: string | null = null;

  function renderList(current: string | null): void {
    list.replaceChildren(
      ...shelf.map((block) =>
        el(
          "li",
          {},
          el(
            "a",
            {
              class: "blockrow",
              href: `/app/blocks/${block.name}`,
              "data-link": "",
              "aria-current": block.name === current ? "true" : null,
            },
            el("span", { class: "blockrow__name" }, block.name),
            el("span", { class: "blockrow__meta" }, plural(block.versions, "version")),
          ),
        ),
      ),
    );
    count.textContent =
      shelfProblem ??
      (shelf.length === 0 ? "Nothing has been published yet. Write a block of your own." : `${plural(shelf.length, "block")} in the library.`);
    count.hidden = shelfProblem === null && shelf.length === 0;
  }

  /**
   * The library's own list of names, asked for once per visit and painted when it lands. The block
   * the address named is the reason for the page, so it does not wait behind a list of the others;
   * and a list that will not answer is the list's own news, told in the list, not a wall over the
   * block on the right.
   */
  async function loadList(): Promise<void> {
    try {
      shelf = (await api.allBlocks()).blocks;
      shelfProblem = null;
    } catch (error) {
      shelfProblem = error instanceof ApiError ? `${error.code}: ${error.message}` : String(error);
    }
    renderList(target ?? null);
  }

  const target = route.parts[1];
  // The writer for a block that does not exist yet lives at `/blocks-new` of its own. It cannot live
  // at `/blocks/new`, because `new` is a legal block name and the block called `new` has to be able
  // to open at its own address.
  const writing = route.parts[0] === "blocks-new";

  // At 980 px and below the two panes take turns instead of sitting side by side, and whose turn it
  // is is the route's business, not a click's: `/blocks` is the list, anything under it is the block
  // or the writer that path opened. Read off the route, the class is put back by every render — after
  // a publish, a version, a sign-in — where a click handler would be gone by the next one.
  lib.classList.toggle("lib--open", target !== undefined || writing);

  void loadList();

  if (writing) {
    renderList(null);
    renderWriter(detail, null);
    return;
  }

  if (target === undefined) {
    renderList(null);
    detail.replaceChildren(
      el("h2", { class: "h2", id: "detail-title", tabindex: "-1" }, "No block open"),
      el("p", { class: "help" }, "Pick a block from the list, or write one of your own."),
    );
    return;
  }

  const edit = route.parts[2] === "edit";
  const wanted = route.parts[2];
  const name = target;
  if (route.parts.length > 3) {
    // Nothing under a version is an address this screen has. The tail used to be ignored, so the page
    // showed a version under a URL that promised something else.
    detail.replaceChildren(
      el("h2", { class: "h2", id: "detail-title", tabindex: "-1" }, "Nothing at this address"),
      el("p", {}, `A block is ${route.path.split("/").slice(0, 2).join("/")}, and a version is that with a number after it.`),
      el(
        "div",
        { class: "row" },
        el("a", { class: "btn back", href: `/app/blocks/${name}`, "data-link": "" }, `Open ${name}`),
        el("a", { class: "btn", href: "/app/blocks", "data-link": "" }, "All blocks"),
      ),
    );
    return;
  }
  renderList(name);
  detail.replaceChildren(stateLine(`Loading ${name}.`));
  try {
    const record = await api.blocks(name);
    const versions: LibraryVersion[] = [];
    // One label per version, from the size the store kept beside the file: `size` is a byte count,
    // where `source.length` counts UTF-16 code units and is not one.
    const sizes = new Map<number, string>();
    for (const version of record.versions) {
      try {
        versions.push({ version: version.version, source: (await api.blockContent(name, version.version)).text });
      } catch (error) {
        // A 401 is the token's news, and the gate has already been drawn over this render.
        if (error instanceof ApiError && error.status === 401) throw error;
        // Everything else about one version is that version's own news. The store answers
        // `block_not_found` when it has the row but not the file, and a 500 or a lost socket is the
        // same shape from here: the version keeps its place in the list with the reason beside it,
        // and the versions that did read stay on the screen instead of going down with it.
        versions.push({
          version: version.version,
          source: null,
          unreadable: error instanceof ApiError ? `${error.code}: ${error.message}` : String(error),
        });
        sizes.set(version.version, sizeLabel(undefined));
        continue;
      }
      sizes.set(version.version, sizeLabel(version.size));
    }
    const entry: LibraryEntry = { name, versions };
    if (edit) {
      renderWriter(detail, entry);
      return;
    }
    // Only a plain decimal is a version. `1.0`, `0x1`, `+1` and `1e0` all satisfy `Number(wanted) === 1`
    // and used to open v1 under an address that said something else; they are now the same kind of
    // nothing `abc` is.
    const chosen =
      wanted !== undefined && VERSION.test(wanted)
        ? versions.find((version) => version.version === Number(wanted))
        : undefined;
    if (wanted !== undefined && chosen === undefined) {
      // Asking for v99 used to fall through to whatever was newest, so the screen said "Source of v1"
      // under an address that said 99. A version the library does not have is called what it is.
      detail.replaceChildren(
        el("h2", { class: "h2", id: "detail-title", tabindex: "-1" }, `No version ${wanted} of ${name}`),
        el("p", {}, `The library has ${versions.map((version) => `v${version.version}`).join(", ")}.`),
        el(
          "div",
          { class: "row" },
          el("a", { class: "btn back", href: `/app/blocks/${name}`, "data-link": "" }, `Latest of ${name}`),
          el("a", { class: "btn", href: "/app/blocks", "data-link": "" }, "All blocks"),
        ),
      );
      return;
    }
    renderBlock(detail, entry, chosen ?? latest(entry), sizes);
  } catch (error) {
    if (error instanceof ApiError && error.code === "block_not_found") {
      detail.replaceChildren(
        el("h2", { class: "h2", id: "detail-title", tabindex: "-1" }, "No such block"),
        el("p", {}, `The library has nothing called ${name}.`),
        el(
          "div",
          { class: "row" },
          el("a", { class: "btn back", href: "/app/blocks", "data-link": "" }, "All blocks"),
          el("a", { class: "btn", href: "/app/blocks-new", "data-link": "" }, "Write it here"),
        ),
      );
      return;
    }
    // A refusal is shown in the detail pane, so at phone width it has to be able to get back to the
    // list the same way an open block can; the error card carries the API's own words untouched.
    detail.replaceChildren(
      errorBox(
        error instanceof ApiError ? error : { code: "internal_error", message: String(error) },
        el("a", { class: "btn back", href: "/app/blocks", "data-link": "" }, "All blocks"),
      ),
    );
  }
}

// ---------- one block ----------

const names = (contract: Contract, kind: "inputs" | "outputs") => contract[kind].map((decl) => decl.name);
const added = (a: string[], b: string[]) => a.filter((name) => !b.includes(name));

function contractDiff(versions: LibraryVersion[], index: number): string | null {
  if (index === 0) return null;
  const now = versions[index]!;
  const before = versions[index - 1]!;
  // A contract is read out of the bytes, so a version without them cannot be compared to one. The
  // row says which one is missing rather than keeping quiet or inventing a change.
  if (now.source === null) return null;
  if (before.source === null) return `Contract unknown: v${before.version} could not be read.`;
  const parsedNow = parseBlock(now.source);
  const parsedBefore = parseBlock(before.source);
  const parts: string[] = [];
  for (const name of added(names(parsedNow, "inputs"), names(parsedBefore, "inputs"))) parts.push(`adds input ${name}`);
  for (const name of added(names(parsedBefore, "inputs"), names(parsedNow, "inputs"))) parts.push(`removes input ${name}`);
  for (const name of added(names(parsedNow, "outputs"), names(parsedBefore, "outputs"))) parts.push(`adds output ${name}`);
  for (const name of added(names(parsedBefore, "outputs"), names(parsedNow, "outputs"))) parts.push(`removes output ${name}`);
  return parts.length > 0 ? `Contract: ${parts.join(", ")}.` : "Contract unchanged.";
}

/** The newest version whose bytes are actually there, which is not always the newest one listed. */
function newestReadable(entry: LibraryEntry): LibraryVersion | null {
  for (let index = entry.versions.length - 1; index >= 0; index -= 1) {
    const version = entry.versions[index]!;
    if (version.source !== null) return version;
  }
  return null;
}

/**
 * The version list, which is the same list whether or not the version being looked at can be read:
 * the reason to open an unreadable one is usually to get from it to one that can be.
 */
function versionsList(entry: LibraryEntry, version: LibraryVersion, sizes: Map<number, string>): HTMLElement {
  return el(
    "section",
    { "aria-labelledby": "h-versions" },
    el("h3", { class: "h3", id: "h-versions" }, "Versions"),
    el(
      "ol",
      { class: "versions", reversed: true },
      entry.versions.toReversed().map((known, index) => {
        const change = contractDiff(entry.versions, entry.versions.length - 1 - index);
        return el(
          "li",
          {},
          el(
            "a",
            { class: "version", href: `/app/blocks/${entry.name}/${known.version}`, "data-link": "", "aria-current": known === version ? "true" : null },
            el("span", { class: "version__num" }, `v${known.version}`),
            el("span", {}, sizes.get(known.version) ?? sizeLabel(undefined)),
            el("span", { class: "version__note" }, change !== null ? el("span", { class: "version__change" }, change) : null),
          ),
        );
      }),
    ),
  );
}

function renderBlock(
  detail: HTMLElement,
  entry: LibraryEntry,
  version: LibraryVersion,
  sizes: Map<number, string>,
): void {
  if (version.source === null) {
    // The list has this version and the store cannot produce its file. Nothing on this card may
    // pretend to know what the block declares: no contract, and no empty source standing in for one.
    const readable = newestReadable(entry);
    fill(detail, [
      el("a", { class: "btn back", href: "/app/blocks", "data-link": "" }, "All blocks"),
      el(
        "div",
        { class: "detail__head" },
        el(
          "div",
          { class: "bar" },
          el(
            "div",
            { class: "detail__title" },
            el("h2", { class: "h2", id: "detail-title", tabindex: "-1" }, `${entry.name} v${version.version}`),
            el("span", { class: "stamp" }, sign("failed"), "unreadable"),
          ),
        ),
        el(
          "p",
          {},
          `The library lists v${version.version} and does not have its bytes, so nothing here can be said about what it declares.`,
        ),
        el("p", {}, el("code", {}, version.unreadable ?? "the library would not say why")),
        el(
          "div",
          { class: "row" },
          readable !== null
            ? el(
                "a",
                { class: "btn back", href: `/app/blocks/${entry.name}/${readable.version}`, "data-link": "" },
                `Read v${readable.version} instead`,
              )
            : el("p", { class: "help" }, "None of this block's versions can be read."),
          el("a", { class: "btn", href: `/app/blocks/${entry.name}`, "data-link": "" }, `All of ${entry.name}`),
        ),
      ),
      versionsList(entry, version, sizes),
      el(
        "section",
        { "aria-labelledby": "h-source" },
        el("h3", { class: "h3", id: "h-source" }, `Source of v${version.version}`),
        el(
          "p",
          { class: "help" },
          "The file is not there to read, and nothing is drawn in its place: an empty source would look like a block that does nothing.",
        ),
      ),
    ]);
    return;
  }
  const parsed = parseBlock(version.source);
  const newest = latest(entry);

  const inputTable = parsed.inputs.length > 0
    ? el(
        "table",
        { class: "table" },
        el("caption", { class: "sr" }, `Inputs of ${entry.name}`),
        el("thead", {}, el("tr", {}, ["Name", "Type", "If not set", "What it is"].map((label) => el("th", { scope: "col" }, label)))),
        el(
          "tbody",
          {},
          parsed.inputs.map((decl) =>
            el(
              "tr",
              {},
              el("th", { scope: "row" }, decl.name),
              el("td", {}, el("span", { class: "stamp stamp--type" }, decl.type)),
              el("td", {}, decl.required ? "Required" : el("span", {}, "Defaults to ", el("code", {}, String(decl.default)))),
              el("td", {}, decl.description),
            ),
          ),
        ),
      )
    : el("p", { class: "help" }, "This block reads nothing.");

  const outputTable = parsed.outputs.length > 0
    ? el(
        "table",
        { class: "table" },
        el("caption", { class: "sr" }, `Outputs of ${entry.name}`),
        el("thead", {}, el("tr", {}, ["Name", "Type", "What it is"].map((label) => el("th", { scope: "col" }, label)))),
        el(
          "tbody",
          {},
          parsed.outputs.map((decl) =>
            el("tr", {}, el("th", { scope: "row" }, decl.name), el("td", {}, el("span", { class: "stamp stamp--type" }, decl.type)), el("td", {}, decl.description)),
          ),
        ),
      )
    : el("p", { class: "help" }, "This block declares no outputs. It passes or fails, and that is all a step can read from it.");

  fill(detail, [
    el("a", { class: "btn back", href: "/app/blocks", "data-link": "" }, "All blocks"),
    el(
      "div",
      { class: "detail__head" },
      el(
        "div",
        { class: "bar" },
        el(
          "div",
          { class: "detail__title" },
          el("h2", { class: "h2", id: "detail-title", tabindex: "-1" }, entry.name),
          el("span", { class: "stamp stamp--type" }, parsed.runtime),
        ),
        canWrite()
          ? el("a", { class: "btn", href: `/app/blocks/${entry.name}/edit`, "data-link": "" }, "Write a new version")
          : el("span", { class: "stamp stamp--type" }, "read only"),
      ),
      el("p", { class: "lead" }, parsed.description),
      parsed.problems.length > 0
        ? el(
            "ul",
            { class: "declared" },
            parsed.problems.map((problem) => el("li", {}, el("strong", {}, `Line ${problem.line}: `), problem.message, " ", el("code", {}, problem.code))),
          )
        : null,
      version !== newest ? el("p", {}, el("span", { class: "stamp" }, `viewing v${version.version}`), " Pipelines that name no version run ", el("a", { href: `/app/blocks/${entry.name}`, "data-link": "" }, `v${newest.version}`), ".") : null,
    ),
    el(
      "div",
      { class: "pair" },
      el("section", { "aria-labelledby": "h-inputs" }, el("h3", { class: "h3", id: "h-inputs" }, "Inputs"), inputTable),
      el("section", { "aria-labelledby": "h-outputs" }, el("h3", { class: "h3", id: "h-outputs" }, "Outputs"), outputTable),
    ),
    versionsList(entry, version, sizes),
    el(
      "section",
      { "aria-labelledby": "h-source" },
      el("h3", { class: "h3", id: "h-source" }, `Source of v${version.version}`),
      el("pre", { class: "code", tabindex: "0", "aria-labelledby": "h-source" }, el("code", {}, version.source)),
    ),
  ]);
}

// ---------- writing ----------

function readDraft(key: string): string | null {
  try {
    const saved = sessionStorage.getItem(key);
    return typeof saved === "string" ? saved : null;
  } catch {
    return null;
  }
}

function keepDraft(key: string, text: string): void {
  try {
    sessionStorage.setItem(key, text);
  } catch {
    // A browser that refuses storage keeps no draft and nothing else about the writer changes.
  }
}

function discardDraft(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // As above: the draft was the only thing in there.
  }
}

function renderWriter(detail: HTMLElement, base: LibraryEntry | null): void {
  // The newest version, and the newest one that actually has bytes to start from. When the newest
  // row's file is gone the writer starts from the one below it and says that it did, rather than
  // opening an empty file and letting a person publish it over the top of a block they cannot see.
  const newest = base !== null ? latest(base) : null;
  const start = base !== null ? newestReadable(base) : null;
  const startText = start?.source ?? FRONT + STARTERS.bash!;
  const skipped = newest !== null && start !== null && newest.version !== start.version;
  // A draft is this tab's unsaved work: one per block being revised, and one for the writer at
  // /blocks-new whatever name the file inside it ends up declaring.
  const draftKey = `bashreactor.draft.${base !== null ? `block.${base.name}` : "newblock"}`;
  const draft = readDraft(draftKey);
  const source = el("textarea", {
    id: "writer-source",
    wrap: "off",
    spellcheck: "false",
    autocapitalize: "off",
    value: draft ?? startText,
    "aria-describedby": "writer-help",
  });
  const declared = el("div", { class: "writer__side" });
  const error = el("p", { class: "form-error", role: "alert", hidden: true });
  // The version these bytes would become, and the bytes they are compared against. For a name the
  // library may not have yet, neither is knowable until the name has been looked up.
  let against: { version: number; source: string | null } | null =
    newest !== null ? { version: newest.version, source: newest.source } : null;
  let lookup: Promise<void> = Promise.resolve();
  let nameAsked: string | null = null;
  let nameUnknown = false;
  const publish = el("button", { class: "btn btn--ink", type: "submit" }, "Publish");
  const title = el("h2", { class: "h2", id: "detail-title", tabindex: "-1" }, base !== null ? `New version of ${base.name}` : "New block");
  const starters = base === null
    ? el(
        "div",
        { class: "row", role: "group", "aria-label": "Start from a template" },
        el("span", { class: "label label--inline" }, "Start from"),
        ...Object.keys(STARTERS).map((runtime) =>
          el(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: () => {
                source.value = FRONT + STARTERS[runtime]!;
                save();
                update();
              },
            },
            runtime,
          ),
        ),
      )
    : null;

  /**
   * Whether the library already has this name, and what its newest bytes are. Only the writer at
   * /blocks-new has to ask: a new version of a block was handed all of that with the block. The
   * answer decides what the button may promise, and whether there is anything to publish at all.
   */
  function askAbout(name: string): Promise<void> {
    if (base !== null || name === "" || name === "new-block" || name === nameAsked) return lookup;
    nameAsked = name;
    nameUnknown = false;
    against = null;
    lookup = (async () => {
      try {
        const record = await api.blocks(name);
        against = { version: record.latest, source: null };
        try {
          against = { version: record.latest, source: (await api.blockContent(name, record.latest)).text };
        } catch {
          // The name is taken and the newest file is not there to compare against: the writer can
          // still say which version this would be, only not whether it would change anything.
        }
      } catch (caught: unknown) {
        // A name the library does not have is the answer "this one is v1". Anything else is a
        // question the writer cannot answer, and it stops naming a version it does not know.
        if (!(caught instanceof ApiError) || caught.status !== 404) nameUnknown = true;
      }
    })().then(() => {
      if (nameAsked === name) update();
    });
    return lookup;
  }

  /** Whether these are already the bytes of the version this file is measured against. */
  function unchanged(): boolean {
    return against !== null && against.source !== null && source.value === against.source;
  }

  /** What the button may say right now, which is never a version number it has not confirmed. */
  function label(): string {
    if (against === null) return nameUnknown ? "Publish" : "Publish v1";
    return unchanged() ? `Unchanged, still v${against.version}` : `Publish v${against.version + 1}`;
  }

  function save(): void {
    if (source.value === startText) discardDraft(draftKey);
    else keepDraft(draftKey, source.value);
  }

  function update(): void {
    const parsed = parseBlock(source.value);
    // Words about a publish that has already been answered are not news the moment the text moves.
    error.hidden = true;
    error.textContent = "";
    // SPEC 3.4: a new version exists only if the SHA-256 differs from the latest one, and the store
    // answers identical bytes by handing back the version it already has. A button that still said
    // "Publish v2" at that moment promised a thing that cannot happen, and the person found out by
    // pressing it and landing on v1.
    if (base === null) {
      void askAbout(parsed.name ?? "");
      title.textContent = against !== null && parsed.name !== null ? `New version of ${parsed.name}` : "New block";
    }
    publish.textContent = label();
    fill(declared, [
      el(
        "div",
        {},
        el("h3", { class: "h3" }, "What this file declares"),
        parsed.problems.length > 0
          ? el("p", {}, el("span", { class: "stamp" }, sign("failed"), plural(parsed.problems.length, "problem")))
          : el("p", {}, el("span", { class: "stamp" }, sign("succeeded"), "valid"), " ", el("span", { class: "stamp stamp--type" }, parsed.runtime)),
      ),
      parsed.problems.length > 0
        ? el("ul", { class: "declared" }, parsed.problems.map((problem) => el("li", {}, el("strong", {}, `Line ${problem.line}: `), problem.message, " ", el("code", {}, problem.code))))
        : null,
      el(
        "div",
        {},
        el("h3", { class: "h3" }, "Inputs"),
        parsed.inputs.length > 0
          ? el("ul", { class: "declared" }, parsed.inputs.map((decl) => el("li", {}, el("code", {}, el("strong", {}, decl.name)), ` ${decl.type}, ${decl.required ? "required" : `defaults to ${decl.default}`}`)))
          : el("p", { class: "help" }, "None."),
      ),
      el(
        "div",
        {},
        el("h3", { class: "h3" }, "Outputs"),
        parsed.outputs.length > 0
          ? el("ul", { class: "declared" }, parsed.outputs.map((decl) => el("li", {}, el("code", {}, el("strong", {}, decl.name)), ` ${decl.type}`)))
          : el("p", { class: "help" }, "None."),
      ),
    ]);
  }

  source.addEventListener("input", () => {
    save();
    update();
  });

  if (!canWrite()) {
    detail.replaceChildren(
      el("h2", { class: "h2", id: "detail-title", tabindex: "-1" }, "This token can read only"),
      el("p", { class: "help" }, "Publishing a block is a write. Sign in with a write token, or use the API directly."),
      el("a", { class: "btn", href: "/app/blocks", "data-link": "" }, "Back to the library"),
    );
    return;
  }

  fill(
    detail,
    [
    el("a", { class: "btn back", href: base !== null ? `/app/blocks/${base.name}` : "/app/blocks", "data-link": "" }, base !== null ? `Back to ${base.name}` : "All blocks"),
    el(
      "form",
      {
        class: "detail",
        onsubmit: (event) => {
          event.preventDefault();
          const parsed = parseBlock(source.value);
          const fail = (message: string) => {
            error.hidden = false;
            error.textContent = message;
            source.focus();
          };
          if (parsed.problems.length > 0) return fail(`Fix line ${parsed.problems[0]!.line} first: ${parsed.problems[0]!.message}`);
          if (parsed.name === "new-block") return fail('Give the block its own name: "new-block" is the template\u2019s.');
          if (base !== null && parsed.name !== base.name) return fail(`This is a new version of ${base.name}, so its name has to stay ${base.name}.`);
          const name = parsed.name ?? "";
          publish.disabled = true;
          // At /blocks-new the name may already belong to a block, and what this file becomes is not
          // known until that has been asked. Asking before posting is the difference between
          // "published as version 3" and a promise of a v1 that was never going to happen.
          void askAbout(name)
            .then(() => {
              if (unchanged()) {
                publish.disabled = false;
                return fail(`Nothing has changed: v${against!.version} is already these exact bytes.`);
              }
              return api.addBlockVersion(name, source.value).then((record) => {
                discardDraft(draftKey);
                announce(`${name} published as version ${record.version}.`);
                navigate(`/blocks/${name}/${record.version}`);
              });
            })
            .catch((caught: unknown) => {
              publish.disabled = false;
              // The store keeps the exact bytes it is given, so a refusal is about the file: show the
              // server's own code, message and path rather than a paraphrase of them.
              fail(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
            });
        },
      },
      title,
      skipped
        ? el("p", { class: "help" }, `v${newest!.version} is listed and its bytes could not be read, so this starts from v${start!.version}.`)
        : null,
      draft !== null ? el("p", { class: "help" }, "This is what you had written here, not what the library has.") : null,
      starters,
      el(
        "div",
        { class: "writer" },
        el(
          "div",
          { class: "field" },
          el("label", { class: "label", for: "writer-source" }, "The block file"),
          source,
          el(
            "p",
            { class: "help", id: "writer-help" },
            "These exact bytes are what the store keeps, and what a run of a step that names this version will execute.",
          ),
        ),
        declared,
      ),
      error,
      el(
        "div",
        { class: "row" },
        publish,
        el("a", { class: "btn", href: base !== null ? `/app/blocks/${base.name}` : "/app/blocks", "data-link": "", onclick: () => discardDraft(draftKey) }, "Discard"),
      ),
    ),
    ],
  );
  update();
}
