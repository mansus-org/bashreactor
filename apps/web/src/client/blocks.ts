// The block library: the list, one block's contract and source, and the writer. A block's contract is
// read out of its own header, so what these screens say a block declares is what its file declares.
//
// The list asks the API for every name and then reads each latest version at four at a time. The
// block page reads one version at a time, because the address says which one is on screen. The writer
// is the only place in the library that changes anything.

import { api, ApiError, canWrite } from "./api.js";
import type { BlockList, BlockVersion, LibraryName } from "./api.js";
import { announce, el, errorBox, fill, insertNode, stateLine } from "./dom.js";
import { parseBlock } from "./model.js";
import type { Contract, Decl, Problem } from "./model.js";
import type { Route } from "./app.js";
import { navigate } from "./app.js";
import {
  alarm,
  button,
  codeView,
  emptyState,
  exactTime,
  formatBytes,
  formatCount,
  linkButton,
  pageHeader,
  readTab,
  relativeTime,
  statusStamp,
  table,
  tabs,
  typeStamp,
  writeTab,
} from "./ui.js";
import type { TableColumn, TabItem } from "./ui.js";

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

/** What a version segment in an address has to look like to be a version at all. */
const VERSION = /^[1-9][0-9]*$/;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function errorObject(caught: unknown): { code: string; message: string; path?: string; file?: string } {
  if (caught instanceof ApiError) return caught;
  return { code: "internal_error", message: caught instanceof Error ? caught.message : String(caught) };
}

function unauthorized(caught: unknown): boolean {
  return caught instanceof ApiError && caught.status === 401;
}

/** Read one version, treating a missing or broken file as the version's own news. */
async function contentOrNull(name: string, version: number): Promise<string | null> {
  try {
    return (await api.blockContent(name, version)).text;
  } catch (caught) {
    if (unauthorized(caught)) throw caught;
    return null;
  }
}

/**
 * One block per row, with the cells the row reads once its latest content lands. The table component
 * keeps the row structure; this only fills the two cells that need a read.
 */
interface BlockRow {
  entry: LibraryName;
  nameLink: HTMLAnchorElement;
  description: HTMLSpanElement;
  runtime: HTMLSpanElement;
}

/** Work through `items` with at most `limit` promises in flight, so a big library is not a burst. */
async function eachAtMost<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await work(items[index]!);
    }
  });
  await Promise.all(workers);
}

// ---------- the list ----------

async function renderList(view: HTMLElement, signal?: AbortSignal): Promise<void> {
  view.replaceChildren(stateLine("Loading the blocks."));

  let names: LibraryName[];
  try {
    names = (await api.allBlocks()).blocks;
  } catch (caught) {
    if (unauthorized(caught)) throw caught;
    if (signal?.aborted) return;
    view.replaceChildren(
      pageHeader({
        title: "Blocks",
        actions: canWrite() ? [linkButton("New block", "/app/blocks-new", { primary: true })] : [],
      }),
      errorBox(errorObject(caught), linkButton("All blocks", "/app/blocks")),
    );
    return;
  }
  if (signal?.aborted) return;

  const rows: BlockRow[] = names.map((entry) => ({
    entry,
    nameLink: el(
      "a",
      { class: "table__link", href: `/app/blocks/${encodeURIComponent(entry.name)}`, "data-link": "" },
      entry.name,
    ),
    description: el("span", {}, "—"),
    runtime: el("span", {}, "—"),
  }));

  const columns: TableColumn<BlockRow>[] = [
    { header: "Name", cell: (row) => row.nameLink },
    { header: "Description", cell: (row) => row.description },
    { header: "Runtime", cell: (row) => row.runtime },
    { header: "Latest", cell: (row) => el("span", { class: "mono" }, `v${row.entry.latest}`) },
    { header: "Versions", cell: (row) => formatCount(row.entry.versions), align: "right" },
  ];

  const list = table(columns, rows, {
    rowHref: (row) => `/app/blocks/${encodeURIComponent(row.entry.name)}`,
    empty: "No blocks in the library yet.",
    emptyAction: canWrite() ? linkButton("New block", "/app/blocks-new", { primary: true }) : undefined,
  });
  list.classList.add("blocks-list");

  view.replaceChildren(
    pageHeader({
      title: "Blocks",
      actions: canWrite() ? [linkButton("New block", "/app/blocks-new", { primary: true })] : [],
    }),
    list,
  );

  // Each row fills in when its own answer arrives, so a slow block does not hold up the others.
  await eachAtMost(rows, 4, async (row) => {
    try {
      const content = await api.blockContent(row.entry.name, row.entry.latest);
      if (signal?.aborted) return;
      const parsed = parseBlock(content.text);
      row.description.replaceChildren(parsed.description === "" ? "—" : parsed.description);
      row.runtime.replaceChildren(typeStamp(parsed.runtime));
    } catch (caught) {
      if (unauthorized(caught)) throw caught;
      if (signal?.aborted) return;
      const error = errorObject(caught);
      row.description.replaceChildren(
        `v${row.entry.latest} could not be read: `,
        el("code", {}, error.code),
        " ",
        error.message,
      );
    }
  });
}

// ---------- one block ----------

interface BlockHeaderInput {
  view: HTMLElement;
  name: string;
  version: BlockVersion;
  record: BlockList;
  route: Route;
}

function openVersion(view: HTMLElement, route: Route, name: string, version: string): void {
  const query = new URLSearchParams(route.query);
  query.set("version", version);
  const path = `/blocks/${encodeURIComponent(name)}`;
  history.replaceState({}, "", `/app${path}?${query.toString()}`);
  void renderBlocks(view, { path, parts: ["blocks", name], query }).then(() => {
    const select = document.getElementById("block-version");
    select?.focus();
  });
}

function versionSelect(input: BlockHeaderInput): HTMLSelectElement {
  const select = el("select", {
    id: "block-version",
    class: "block-version",
    "aria-label": "Version",
    onchange: (event) => openVersion(input.view, input.route, input.name, (event.target as HTMLSelectElement).value),
  });
  for (const version of input.record.versions.toReversed()) {
    select.append(
      el(
        "option",
        { value: String(version.version) },
        version.version === input.record.latest ? `v${version.version} (latest)` : `v${version.version}`,
      ),
    );
  }
  select.value = String(input.version.version);
  return select;
}

/**
 * The block's runtime belongs immediately after its name, which is the one part of a page header the
 * shared component does not take. Grouping the title and its stamp keeps them together while the
 * actions stay on the right.
 */
// BASHR-62: candidate for ui.ts
function titleWithStamp(header: HTMLElement, node: HTMLElement): void {
  const title = header.querySelector<HTMLElement>("h1.title");
  if (title === null) return;
  const parent = title.parentElement ?? (title as unknown as { parent?: HTMLElement | null }).parent ?? null;
  if (parent === null) return;
  const group = el("div", { class: "block-title" });
  insertNode(parent, group, title);
  group.append(title, node);
}

function problemAlarm(problems: Problem[]): HTMLElement {
  return alarm({
    status: "failed",
    lead: plural(problems.length, "header problem"),
    text: el(
      "span",
      {},
      ...problems.flatMap((problem, index) => [
        index === 0 ? null : " · ",
        `Line ${problem.line}: ${problem.message} `,
        el("code", {}, problem.code),
      ]),
    ),
  });
}

function unreadableAlarm(caught: unknown, version: number): HTMLElement {
  const error = errorObject(caught);
  return alarm({
    status: "failed",
    lead: `v${version} could not be read.`,
    text: el("span", {}, el("code", {}, error.code), " ", error.message),
  });
}

function declarationTable(kind: "inputs" | "outputs", declarations: Decl[]): HTMLElement {
  if (kind === "inputs") {
    const columns: TableColumn<Decl>[] = [
      { header: "Name", cell: (decl) => el("span", { class: "mono" }, decl.name) },
      { header: "Type", cell: (decl) => typeStamp(decl.type) },
      {
        header: "Default",
        cell: (decl) => (decl.required ? "required" : el("code", {}, String(decl.default))),
      },
      { header: "Description", cell: (decl) => decl.description === "" ? "—" : decl.description },
    ];
    return table(columns, declarations, { empty: "This block takes no inputs." });
  }
  const columns: TableColumn<Decl>[] = [
    { header: "Name", cell: (decl) => el("span", { class: "mono" }, decl.name) },
    { header: "Type", cell: (decl) => typeStamp(decl.type) },
    { header: "Description", cell: (decl) => decl.description === "" ? "—" : decl.description },
  ];
  return table(columns, declarations, { empty: "This block declares no outputs." });
}

function contractPanel(parsed: Contract | null): HTMLElement {
  if (parsed === null) return emptyState("This version's file could not be read.");
  return el(
    "div",
    { class: "block-contract" },
    el("h2", { class: "h2" }, "Inputs"),
    declarationTable("inputs", parsed.inputs),
    el("h2", { class: "h2" }, "Outputs"),
    declarationTable("outputs", parsed.outputs),
  );
}

function sourcePanel(source: string | null): HTMLElement {
  return source === null ? emptyState("This version's file could not be read.") : codeView(source, { lineNumbers: true });
}

function versionsPanel(name: string, record: BlockList): HTMLElement {
  const columns: TableColumn<BlockVersion>[] = [
    { header: "Version", cell: (version) => el("span", { class: "mono" }, `v${version.version}`) },
    {
      header: "Stored",
      cell: (version) => {
        const time = el("time", { datetime: version.created_at }, relativeTime(version.created_at));
        const exact = exactTime(version.created_at);
        if (exact !== "") time.setAttribute("title", exact);
        return time;
      },
    },
    { header: "sha256", cell: (version) => el("span", { class: "mono" }, version.sha256.slice(0, 12)) },
    { header: "Size", cell: (version) => formatBytes(version.size), align: "right" },
  ];
  const node = table(columns, record.versions.toReversed());
  node.setAttribute("aria-label", `Versions of ${name}`);
  return node;
}

function renderMissingBlock(view: HTMLElement, name: string): void {
  view.replaceChildren(
    pageHeader({ crumbs: [{ label: "Blocks", href: "/app/blocks" }], title: "No block" }),
    emptyState(`There is no block called ${name}.`, linkButton("All blocks", "/app/blocks")),
  );
}

function renderNoVersion(view: HTMLElement, name: string, wanted: string, record: BlockList): void {
  view.replaceChildren(
    pageHeader({ crumbs: [{ label: "Blocks", href: "/app/blocks" }, { label: name }], title: name }),
    emptyState(
      `No version ${wanted} of ${name}. This block has ${record.versions.map((version) => `v${version.version}`).join(", ")}.`,
      linkButton(`Open v${record.latest}`, `/app/blocks/${encodeURIComponent(name)}`),
    ),
  );
}

function renderNoVersions(view: HTMLElement, name: string): void {
  view.replaceChildren(
    pageHeader({ crumbs: [{ label: "Blocks", href: "/app/blocks" }, { label: name }], title: name }),
    emptyState("This block has no versions.", linkButton("All blocks", "/app/blocks")),
  );
}

function renderAddress(view: HTMLElement, name: string): void {
  view.replaceChildren(
    pageHeader({ crumbs: [{ label: "Blocks", href: "/app/blocks" }, { label: name }], title: name }),
    emptyState("There is nothing at this address.", linkButton(`Open ${name}`, `/app/blocks/${encodeURIComponent(name)}`)),
  );
}

async function renderBlockPage(view: HTMLElement, route: Route, name: string, legacy: string | undefined): Promise<void> {
  view.replaceChildren(stateLine(`Loading ${name}.`));
  let record: BlockList;
  try {
    record = await api.blocks(name);
  } catch (caught) {
    if (unauthorized(caught)) throw caught;
    if (caught instanceof ApiError && caught.code === "block_not_found") {
      renderMissingBlock(view, name);
      return;
    }
    view.replaceChildren(
      pageHeader({ crumbs: [{ label: "Blocks", href: "/app/blocks" }, { label: name }], title: name }),
      errorBox(errorObject(caught), linkButton("All blocks", "/app/blocks")),
    );
    return;
  }

  const newest = record.versions.at(-1);
  if (newest === undefined) {
    renderNoVersions(view, name);
    return;
  }
  const raw = route.query.get("version") ?? legacy ?? null;
  const wanted = raw === null ? newest.version : VERSION.test(raw) ? Number(raw) : null;
  const chosen = wanted === null ? undefined : record.versions.find((version) => version.version === wanted);
  if (raw !== null && chosen === undefined) {
    renderNoVersion(view, name, raw, record);
    return;
  }
  const version = chosen ?? newest;

  let source: string | null = null;
  let readError: unknown = null;
  try {
    source = (await api.blockContent(name, version.version)).text;
  } catch (caught) {
    if (unauthorized(caught)) throw caught;
    readError = caught;
  }
  const parsed = source === null ? null : parseBlock(source);

  const header = pageHeader({
    crumbs: [{ label: "Blocks", href: "/app/blocks" }, { label: name }],
    title: name,
    actions: [
      versionSelect({ view, name, version, record, route }),
      ...(canWrite()
        ? [linkButton("New version", `/app/blocks/${encodeURIComponent(name)}/edit?version=${version.version}`)]
        : []),
    ],
  });
  if (parsed !== null) titleWithStamp(header, typeStamp(parsed.runtime));
  if (parsed !== null && parsed.description !== "") header.append(el("p", { class: "lead" }, parsed.description));

  const problems =
    parsed !== null && parsed.problems.length > 0
      ? problemAlarm(parsed.problems)
      : source === null
        ? unreadableAlarm(readError, version.version)
        : null;

  const selectedTab = route.query.get("tab") ?? readTab("contract");
  const items: TabItem[] = [
    { id: "contract", label: "Contract", panel: contractPanel(parsed) },
    { id: "source", label: "Source", panel: sourcePanel(source) },
    { id: "versions", label: "Versions", panel: versionsPanel(name, record) },
  ];

  view.replaceChildren(
    el(
      "div",
      { class: "block-page" },
      header,
      problems,
      tabs(items, selectedTab, (id) => writeTab(id)),
    ),
  );
}

// ---------- the writer ----------

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

interface WriterBase {
  name: string;
  latest: number;
  latestSource: string | null;
}

function renderReadOnlyWriter(view: HTMLElement, name: string | null): void {
  view.replaceChildren(
    pageHeader({
      crumbs: name === null ? [{ label: "Blocks", href: "/app/blocks" }] : [{ label: "Blocks", href: "/app/blocks" }, { label: name }],
      title: name ?? "New block",
    }),
    emptyState("This token can read only. Publishing a block needs a token that can write.", linkButton("All blocks", "/app/blocks")),
  );
}

function renderWriterMissing(view: HTMLElement, name: string): void {
  view.replaceChildren(
    pageHeader({ crumbs: [{ label: "Blocks", href: "/app/blocks" }, { label: name }], title: name }),
    emptyState(`There is no block called ${name}.`, linkButton("All blocks", "/app/blocks")),
  );
}

function renderWriterNoReadable(view: HTMLElement, name: string): void {
  view.replaceChildren(
    pageHeader({ crumbs: [{ label: "Blocks", href: "/app/blocks" }, { label: name }], title: name }),
    emptyState(`No version of ${name} could be read.`, linkButton(`Open ${name}`, `/app/blocks/${encodeURIComponent(name)}`)),
  );
}

async function renderWriter(view: HTMLElement, route: Route, name: string | null): Promise<void> {
  if (!canWrite()) {
    renderReadOnlyWriter(view, name);
    return;
  }
  if (name === null) {
    renderWriterShell(view, route, null, FRONT + STARTERS.bash!, null);
    return;
  }

  view.replaceChildren(stateLine(`Loading ${name}.`));
  let record: BlockList;
  try {
    record = await api.blocks(name);
  } catch (caught) {
    if (unauthorized(caught)) throw caught;
    if (caught instanceof ApiError && caught.code === "block_not_found") {
      renderWriterMissing(view, name);
      return;
    }
    view.replaceChildren(
      pageHeader({ crumbs: [{ label: "Blocks", href: "/app/blocks" }, { label: name }], title: name }),
      errorBox(errorObject(caught), linkButton("All blocks", "/app/blocks")),
    );
    return;
  }
  const newest = record.versions.at(-1);
  if (newest === undefined) {
    renderWriterMissing(view, name);
    return;
  }

  const raw = route.query.get("version") ?? null;
  const wanted = raw === null ? newest.version : VERSION.test(raw) ? Number(raw) : null;
  const chosen = wanted === null ? undefined : record.versions.find((version) => version.version === wanted);
  if (raw !== null && chosen === undefined) {
    renderNoVersion(view, name, raw, record);
    return;
  }

  // The selected version is what the writer opens. If its file is gone, start from the newest one
  // that can be read and say which one that was, rather than opening an empty file.
  const first = chosen?.version ?? newest.version;
  const order = [...new Set([first, ...record.versions.toReversed().map((version) => version.version)])];
  let startVersion: BlockVersion | null = null;
  let startText: string | null = null;
  for (const number of order) {
    const text = await contentOrNull(name, number);
    if (text !== null) {
      startVersion = record.versions.find((version) => version.version === number) ?? null;
      startText = text;
      break;
    }
  }
  if (startVersion === null || startText === null) {
    renderWriterNoReadable(view, name);
    return;
  }
  const latestSource =
    startVersion.version === newest.version ? startText : await contentOrNull(name, newest.version);
  const skipped = startVersion.version === first ? null : { wanted: first, started: startVersion.version };

  renderWriterShell(
    view,
    route,
    { name, latest: newest.version, latestSource },
    startText,
    skipped,
  );
}

function writerInputs(parsed: Contract): HTMLElement {
  if (parsed.inputs.length === 0) return el("p", { class: "help" }, "No inputs.");
  return el(
    "ul",
    { class: "block-writer__decls" },
    ...parsed.inputs.map((decl) =>
      el(
        "li",
        {},
        el("code", {}, el("strong", {}, decl.name)),
        " ",
        typeStamp(decl.type),
        " ",
        decl.required ? "required" : `defaults to ${String(decl.default)}`,
        decl.description === "" ? null : el("p", { class: "help" }, decl.description),
      ),
    ),
  );
}

function writerOutputs(parsed: Contract): HTMLElement {
  if (parsed.outputs.length === 0) return el("p", { class: "help" }, "No outputs.");
  return el(
    "ul",
    { class: "block-writer__decls" },
    ...parsed.outputs.map((decl) =>
      el(
        "li",
        {},
        el("code", {}, el("strong", {}, decl.name)),
        " ",
        typeStamp(decl.type),
        decl.description === "" ? null : el("p", { class: "help" }, decl.description),
      ),
    ),
  );
}

function currentName(parsed: Contract): string | null {
  return parsed.name === null || parsed.name === "" || parsed.name === "new-block" ? null : parsed.name;
}

/**
 * The writer's breadcrumb. `pageHeader` always draws a title with its crumbs, and the writer's title
 * is its toolbar, so this is the smallest crumb line the writer needs on its own.
 */
// BASHR-62: candidate for ui.ts
function writerCrumbs(name: string | null): HTMLElement {
  const entries =
    name === null
      ? [{ label: "Blocks", href: "/app/blocks" }, { label: "New" }]
      : [
          { label: "Blocks", href: "/app/blocks" },
          { label: name, href: `/app/blocks/${encodeURIComponent(name)}` },
          { label: "New version" },
        ];
  return el(
    "nav",
    { class: "crumbs", "aria-label": "Breadcrumb" },
    ...entries.flatMap((entry, index) => {
      const current = index === entries.length - 1;
      const node =
        current || entry.href === undefined
          ? el("span", { class: "crumbs__current" }, entry.label)
          : el("a", { href: entry.href, "data-link": "" }, entry.label);
      return index === 0 ? [node] : [" / ", node];
    }),
  );
}

function renderWriterShell(
  view: HTMLElement,
  _route: Route,
  base: WriterBase | null,
  startText: string,
  skipped: { wanted: number; started: number } | null,
): void {
  const draftKey = base !== null ? `bashreactor.draft.block.${base.name}` : "bashreactor.draft.newblock";
  const draft = readDraft(draftKey);
  const source = el("textarea", {
    id: "writer-source",
    class: "block-writer__source",
    wrap: "off",
    spellcheck: "false",
    autocapitalize: "off",
    "aria-label": "Block source",
  });
  source.value = draft ?? startText;

  const unsaved = statusStamp("unsaved");
  unsaved.hidden = true;
  const declared = el("section", { class: "block-writer__declares", "aria-labelledby": "declares-title" });
  const errorSlot = el("div", { class: "block-writer__error" });
  const publishSlot = el("span", { class: "block-writer__publish" });
  const title = el("span", { class: "h2" }, base !== null ? base.name : "New block");
  const startNote = skipped === null
    ? null
    : el("p", { class: "help" }, `v${skipped.wanted} could not be read. This starts from v${skipped.started}.`);

  // What these bytes would become if published: the newest version's bytes, so identical bytes are
  // not offered as a new version and the API's own idempotence is not presented as a publish.
  let against: { version: number; source: string | null } | null =
    base !== null ? { version: base.latest, source: base.latestSource } : null;
  let askedName: string | null = null;
  const known = new Map<string, { version: number; source: string | null }>();
  const unknown = new Set<string>();

  async function askAbout(name: string): Promise<{ version: number; source: string | null } | null> {
    if (known.has(name)) return known.get(name)!;
    if (unknown.has(name)) return null;
    try {
      const record = await api.blocks(name);
      const content = await contentOrNull(name, record.latest);
      const entry = { version: record.latest, source: content };
      known.set(name, entry);
      return entry;
    } catch (caught) {
      if (unauthorized(caught)) throw caught;
      if (caught instanceof ApiError && caught.status === 404) {
        unknown.add(name);
        return null;
      }
      throw caught;
    }
  }

  /** The one reason the Publish button is off right now, or null when it can work. */
  function blocker(parsed: Contract): string | null {
    if (parsed.problems.length > 0) return `Fix ${plural(parsed.problems.length, "problem")} first.`;
    if (parsed.name === null || parsed.name === "") return "The file needs a name.";
    if (parsed.name === "new-block") return 'Give the block its own name: "new-block" is the template\u2019s.';
    if (base !== null && parsed.name !== base.name) return `This is a new version of ${base.name}, so its name has to stay ${base.name}.`;
    if (against !== null && against.source !== null && source.value === against.source) {
      return `Nothing has changed: v${against.version} is already these exact bytes.`;
    }
    return null;
  }

  let paintedReason: string | null | undefined;
  function paintPublish(reason: string | null): void {
    if (reason === paintedReason) return;
    paintedReason = reason;
    publishSlot.replaceChildren(
      reason === null
        ? button("Publish version", { primary: true, type: "submit" })
        : button("Publish version", { primary: true, type: "submit", disabledReason: reason }),
    );
  }

  function renderDeclared(parsed: Contract): void {
    fill(declared, [
      el("h2", { class: "h2", id: "declares-title" }, "What this file declares"),
      parsed.description === "" ? null : el("p", { class: "lead" }, parsed.description),
      parsed.problems.length > 0
        ? el(
            "ul",
            { class: "block-writer__problems" },
            ...parsed.problems.map((problem) =>
              el(
                "li",
                {},
                el("strong", {}, `Line ${problem.line}: `),
                problem.message,
                " ",
                el("code", {}, problem.code),
              ),
            ),
          )
        : null,
      el("h3", { class: "h3" }, "Inputs"),
      writerInputs(parsed),
      el("h3", { class: "h3" }, "Outputs"),
      writerOutputs(parsed),
    ]);
  }

  function update(): void {
    const parsed = parseBlock(source.value);
    unsaved.hidden = source.value === startText;
    renderDeclared(parsed);
    paintPublish(blocker(parsed));

    if (base === null) {
      const name = currentName(parsed);
      if (name === null || name !== askedName) askedName = name;
      if (name === null) {
        against = null;
      } else if (known.has(name)) {
        against = known.get(name)!;
      } else if (!unknown.has(name)) {
        against = null;
        void askAbout(name)
          .then((entry) => {
            if (askedName !== name) return;
            against = entry;
            update();
          })
          .catch((caught) => {
            if (unauthorized(caught)) return;
            if (askedName !== name) return;
            // A name that could not be checked is not a reason to forbid publishing: the API still
            // answers with the version it stored, and this screen does not invent one.
            against = null;
            update();
          });
      } else {
        against = null;
      }
    } else {
      against = { version: base.latest, source: base.latestSource };
    }
    paintPublish(blocker(parsed));
  }

  function saveDraft(): void {
    if (source.value === startText) discardDraft(draftKey);
    else keepDraft(draftKey, source.value);
  }

  function failLocal(message: string): void {
    errorSlot.replaceChildren(el("p", { class: "form-error", role: "alert" }, message));
    source.focus();
  }

  function failApi(caught: unknown): void {
    errorSlot.replaceChildren(errorBox(errorObject(caught)));
    source.focus();
  }

  async function publish(): Promise<void> {
    const parsed = parseBlock(source.value);
    const reason = blocker(parsed);
    if (reason !== null) {
      failLocal(reason);
      return;
    }
    const name = parsed.name!;

    if (base === null) {
      try {
        against = await askAbout(name);
      } catch (caught) {
        if (unauthorized(caught)) throw caught;
        // The POST is the next answer; a failed lookup does not create a version by itself.
        against = null;
      }
      const now = blocker(parseBlock(source.value));
      if (now !== null) {
        update();
        failLocal(now);
        return;
      }
    }

    try {
      const record = await api.addBlockVersion(name, source.value);
      discardDraft(draftKey);
      announce(`${name} published as version ${record.version}.`);
      navigate(`/blocks/${encodeURIComponent(name)}?version=${record.version}`);
    } catch (caught) {
      if (unauthorized(caught)) throw caught;
      failApi(caught);
    }
  }

  const form = el(
    "form",
    {
      class: "block-writer",
      onsubmit: (event) => {
        event.preventDefault();
        void publish();
      },
    },
    writerCrumbs(base !== null ? base.name : null),
    el(
      "div",
      { class: "block-writer__toolbar" },
      el("span", { class: "block-writer__title" }, title, unsaved),
      publishSlot,
    ),
    startNote,
    el(
      "div",
      { class: "block-writer__panes" },
      el("div", { class: "block-writer__source-pane" }, source),
      declared,
    ),
    errorSlot,
  );

  source.addEventListener("input", () => {
    errorSlot.replaceChildren();
    saveDraft();
    update();
  });

  view.replaceChildren(form);
  update();
}

// ---------- the routes ----------

export async function renderBlocks(view: HTMLElement, route: Route, signal?: AbortSignal): Promise<void> {
  const first = route.parts[0];
  if (first === "blocks-new") {
    await renderWriter(view, route, null);
    return;
  }
  if (first !== "blocks") {
    await renderList(view, signal);
    return;
  }
  const name = route.parts[1];
  if (name === undefined) {
    await renderList(view, signal);
    return;
  }
  if (route.parts[2] === "edit") {
    if (route.parts.length > 3) {
      renderAddress(view, name);
      return;
    }
    await renderWriter(view, route, name);
    return;
  }
  if (route.parts.length > 3) {
    renderAddress(view, name);
    return;
  }
  const legacy = route.parts.length === 3 ? route.parts[2] : undefined;
  await renderBlockPage(view, route, name, legacy);
}
