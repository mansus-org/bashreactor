// The block library. A block's contract is read out of its own header — `GET /v1/blocks/:name` for
// the versions and `.../content` for the bytes — so what this screen says a block declares is what
// the file declares. Ported from mockup/blocks.js.
//
// Two things the mockup had are not here, because the API cannot answer them: there is no list of
// every block (BASHR-5's own open item), so the library is opened by name and the list on the left
// is this device's history, and a version has no note, because the store keeps no note.

import { api, ApiError, canWrite } from "./api.js";
import { announce, el, errorBox, fill, sign, stateLine } from "./dom.js";
import { latest, parseBlock } from "./model.js";
import type { Contract, LibraryEntry, LibraryVersion } from "./model.js";
import type { Route } from "./app.js";
import { navigate } from "./app.js";

const HISTORY = "bashreactor.blocks.opened";

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

function history(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY);
    const names = raw === null ? [] : (JSON.parse(raw) as unknown);
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

function remember(name: string): void {
  const names = [name, ...history().filter((known) => known !== name)].slice(0, 20);
  try {
    localStorage.setItem(HISTORY, JSON.stringify(names));
  } catch {
    // A browser that refuses storage keeps its own history out of the way; nothing else changes.
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

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
    el("a", { class: "btn btn--ink", href: "/app/blocks/new", "data-link": "" }, "Write a block"),
  ),
];

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
        "The API has no route that lists every block, so a block is opened by name. The list below is what this device has opened.",
      ),
    ),
    count,
    list,
  );
  const detail = el("section", { class: "detail", "aria-labelledby": "detail-title", tabindex: "-1" });
  view.replaceChildren(...heading(), el("div", { class: "lib" }, listPane, detail));

  function renderHistory(current: string | null): void {
    const names = history();
    list.replaceChildren(
      ...names.map((name) =>
        el(
          "li",
          {},
          el(
            "a",
            { class: "blockrow", href: `/app/blocks/${name}`, "data-link": "", "aria-current": name === current ? "true" : null },
            el("span", { class: "blockrow__name" }, name),
          ),
        ),
      ),
    );
    count.textContent = names.length === 0 ? "" : `${plural(names.length, "block")} opened on this device.`;
    count.hidden = names.length === 0;
  }

  const target = route.parts[1];
  if (target === undefined) {
    renderHistory(null);
    detail.replaceChildren(
      el("h2", { class: "h2", id: "detail-title", tabindex: "-1" }, "No block open"),
      el("p", { class: "help" }, "Type a name above, or write a block of your own."),
    );
    return;
  }

  if (target === "new") {
    renderHistory(null);
    renderWriter(detail, null);
    return;
  }

  const edit = route.parts[2] === "edit";
  const wanted = route.parts[2];
  const name = target;
  remember(name);
  renderHistory(name);
  detail.replaceChildren(stateLine(`Loading ${name}.`));
  try {
    const record = await api.blocks(name);
    const versions: LibraryVersion[] = [];
    for (const version of record.versions) {
      const content = await api.blockContent(name, version.version);
      versions.push({ version: version.version, source: content.text });
    }
    const entry: LibraryEntry = { name, versions };
    if (edit) {
      renderWriter(detail, entry);
      return;
    }
    const chosen = wanted !== undefined ? versions.find((version) => version.version === Number(wanted)) : undefined;
    renderBlock(detail, entry, chosen ?? latest(entry));
  } catch (error) {
    if (error instanceof ApiError && error.code === "block_not_found") {
      detail.replaceChildren(
        el("h2", { class: "h2", id: "detail-title", tabindex: "-1" }, "No such block"),
        el("p", {}, `The library has nothing called ${name}.`),
        el("a", { class: "btn", href: "/app/blocks/new", "data-link": "" }, "Write it here"),
      );
      return;
    }
    detail.replaceChildren(errorBox(error instanceof ApiError ? error : { code: "internal_error", message: String(error) }));
  }
}

// ---------- one block ----------

const names = (contract: Contract, kind: "inputs" | "outputs") => contract[kind].map((decl) => decl.name);
const added = (a: string[], b: string[]) => a.filter((name) => !b.includes(name));

function contractDiff(versions: LibraryVersion[], index: number): string | null {
  if (index === 0) return null;
  const now = parseBlock(versions[index]!.source);
  const before = parseBlock(versions[index - 1]!.source);
  const parts: string[] = [];
  for (const name of added(names(now, "inputs"), names(before, "inputs"))) parts.push(`adds input ${name}`);
  for (const name of added(names(before, "inputs"), names(now, "inputs"))) parts.push(`removes input ${name}`);
  for (const name of added(names(now, "outputs"), names(before, "outputs"))) parts.push(`adds output ${name}`);
  for (const name of added(names(before, "outputs"), names(now, "outputs"))) parts.push(`removes output ${name}`);
  return parts.length > 0 ? `Contract: ${parts.join(", ")}.` : "Contract unchanged.";
}

function renderBlock(detail: HTMLElement, entry: LibraryEntry, version: LibraryVersion): void {
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
    el(
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
              el("span", {}, known.source.length > 0 ? `${new Intl.NumberFormat().format(known.source.length)} bytes` : ""),
              el("span", { class: "version__note" }, change !== null ? el("span", { class: "version__change" }, change) : null),
            ),
          );
        }),
      ),
    ),
    el(
      "section",
      { "aria-labelledby": "h-source" },
      el("h3", { class: "h3", id: "h-source" }, `Source of v${version.version}`),
      el("pre", { class: "code", tabindex: "0", "aria-labelledby": "h-source" }, el("code", {}, version.source)),
    ),
  ]);
}

// ---------- writing ----------

function renderWriter(detail: HTMLElement, base: LibraryEntry | null): void {
  const startText = base !== null ? latest(base).source : FRONT + STARTERS.bash!;
  const source = el("textarea", {
    id: "writer-source",
    wrap: "off",
    spellcheck: "false",
    autocapitalize: "off",
    value: startText,
    "aria-describedby": "writer-help",
  });
  const declared = el("div", { class: "writer__side" });
  const error = el("p", { class: "form-error", role: "alert", hidden: true });
  const publish = el("button", { class: "btn btn--ink", type: "submit" }, base !== null ? `Publish v${latest(base).version + 1}` : "Publish v1");
  const starters = base === null
    ? el(
        "div",
        { class: "row", role: "group", "aria-label": "Start from a template" },
        el("span", { class: "label", style: "margin:0" }, "Start from"),
        ...Object.keys(STARTERS).map((runtime) =>
          el(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: () => {
                source.value = FRONT + STARTERS[runtime]!;
                update();
              },
            },
            runtime,
          ),
        ),
      )
    : null;

  function update(): void {
    const parsed = parseBlock(source.value);
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

  source.addEventListener("input", update);

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
          api
            .addBlockVersion(name, source.value)
            .then((record) => {
              announce(`${name} published as version ${record.version}.`);
              navigate(`/blocks/${name}/${record.version}`);
            })
            .catch((caught: unknown) => {
              publish.disabled = false;
              // The store keeps the exact bytes it is given, so a refusal is about the file: show the
              // server's own code, message and path rather than a paraphrase of them.
              fail(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
            });
        },
      },
      el("h2", { class: "h2", id: "detail-title", tabindex: "-1" }, base !== null ? `New version of ${base.name}` : "New block"),
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
        el("a", { class: "btn", href: base !== null ? `/app/blocks/${base.name}` : "/app/blocks", "data-link": "" }, "Discard"),
      ),
    ),
    ],
  );
  update();
}
