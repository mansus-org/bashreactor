// The block library: browse, open one, read its contract, source and versions, write a new one.
// A block's inputs and outputs are always read from the source through model.js, so what the page
// says a block declares is what the file declares.

(() => {
  const { el } = BR;
  const view = document.getElementById("view");

  const heading = () => [
    el(
      "div",
      { class: "head" },
      el(
        "div",
        { class: "head__text" },
        el("h1", { class: "title" }, "Blocks"),
        el("p", { class: "lead" }, "What a pipeline can run. A block is one bash file, and its front matter says what goes in and what comes out."),
      ),
      el("a", { class: "btn btn--ink", href: "#new" }, "Write a block"),
    ),
  ];

  if (BR.demoState === "loading") {
    view.replaceChildren(...heading(), el("p", { class: "state", role: "status" }, "Loading the blocks from the store."));
    return;
  }
  if (BR.demoState === "error") {
    view.replaceChildren(
      el("h1", { class: "title" }, "Blocks"),
      BR.errorBox(
        { code: "store_unavailable", message: "The block store did not answer, so the library could not be listed. Steps that already run keep their versions. Try again in a moment." },
        el("a", { class: "btn btn--ink", href: "blocks.html" }, "Try again"),
      ),
    );
    return;
  }

  const STARTERS = {
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

  let library = BR.demoState === "empty" ? [] : BR.library();
  let query = "";
  let runtimeFilter = "all";

  const parsedLatest = (block) => BR.model.parseBlock(BR.model.latest(block).source);

  const searchInput = el("input", {
    id: "block-search",
    type: "search",
    spellcheck: "false",
    placeholder: "Name or description",
    oninput: (event) => {
      query = event.target.value.trim().toLowerCase();
      renderList();
    },
  });
  const facets = el("div", { class: "facets", role: "group", "aria-label": "Filter by what the block runs" });
  const list = el("ul", { class: "blocklist" });
  const count = el("p", { class: "help", role: "status" });
  const listPane = el(
    "section",
    { class: "lib__list", "aria-label": "All blocks" },
    el("div", { class: "field" }, el("label", { class: "label", for: "block-search" }, "Find a block"), searchInput),
    facets,
    count,
    list,
  );
  const detail = el("section", { class: "detail", "aria-labelledby": "detail-title", tabindex: "-1" });
  const lib = el("div", { class: "lib" }, listPane, detail);
  view.replaceChildren(...heading(), lib);

  function renderFacets() {
    facets.replaceChildren(
      ...["all", ...BR.model_runtimes()].map((name) =>
        el(
          "button",
          {
            class: "btn",
            type: "button",
            "aria-pressed": String(runtimeFilter === name),
            onclick: (event) => {
              runtimeFilter = name;
              renderFacets();
              renderList();
              facets.querySelector(`[data-facet="${name}"]`).focus();
              event.stopPropagation();
            },
            "data-facet": name,
          },
          name === "all" ? "All" : name,
        ),
      ),
    );
  }

  BR.model_runtimes = () => ["bash", "uv", "bun"];

  function matches(block) {
    const parsed = parsedLatest(block);
    if (runtimeFilter !== "all" && parsed.runtime !== runtimeFilter) return false;
    return !query || block.name.toLowerCase().includes(query) || parsed.description.toLowerCase().includes(query);
  }

  function currentName() {
    const match = decodeURIComponent(location.hash).match(/^#([\w-]+)(?:@\d+|\/edit)?$/);
    if (match && match[1] !== "new") return match[1];
    return null;
  }

  function renderList() {
    const shown = library.filter(matches);
    const open = currentName() || (wide() && library[0] ? library[0].name : null);
    list.replaceChildren(
      ...shown.map((block) => {
        const parsed = parsedLatest(block);
        const version = BR.model.latest(block).version;
        return el(
          "li",
          {},
          el(
            "a",
            { class: "blockrow", href: `#${block.name}`, "aria-current": block.name === open ? "true" : null },
            el("span", { class: "blockrow__head" }, el("span", { class: "blockrow__name" }, block.name), el("span", { class: "stamp stamp--type" }, parsed.runtime)),
            el("span", { class: "blockrow__text" }, parsed.description),
            el("span", { class: "blockrow__meta" }, `v${version}, ${plural(parsed.inputs.length, "input")}, ${plural(parsed.outputs.length, "output")}`),
          ),
        );
      }),
    );
    if (!library.length) {
      count.textContent = "";
    } else if (shown.length) {
      count.textContent = shown.length === library.length ? plural(library.length, "block") : `${shown.length} of ${plural(library.length, "block")}`;
    } else {
      count.replaceChildren(
        `No block matches${query ? ` "${query}"` : ""}${runtimeFilter !== "all" ? ` in ${runtimeFilter}` : ""}. `,
        el(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: () => {
              query = "";
              runtimeFilter = "all";
              searchInput.value = "";
              renderFacets();
              renderList();
              searchInput.focus();
            },
          },
          "Clear the filters",
        ),
      );
    }
    if (library.length) count.hidden = false;
    else count.hidden = true;
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  const wide = () => matchMedia("(min-width: 981px)").matches;

  // ---------- one block ----------

  function contractDiff(block, version) {
    const index = block.versions.indexOf(version);
    if (index === 0) return null;
    const now = BR.model.parseBlock(version.source);
    const before = BR.model.parseBlock(block.versions[index - 1].source);
    const names = (list_) => list_.map((d) => d.name);
    const added = (a, b) => names(a).filter((n) => !names(b).includes(n));
    const parts = [];
    for (const name of added(now.inputs, before.inputs)) parts.push(`adds input ${name}`);
    for (const name of added(before.inputs, now.inputs)) parts.push(`removes input ${name}`);
    for (const name of added(now.outputs, before.outputs)) parts.push(`adds output ${name}`);
    for (const name of added(before.outputs, now.outputs)) parts.push(`removes output ${name}`);
    return parts.length ? `Contract: ${parts.join(", ")}.` : "Contract unchanged.";
  }

  function usedBy(name) {
    const doc = BR.pipelineText();
    const analysis = BR.model.analyze(doc, library);
    if (!analysis.ok) return { pipeline: null, steps: [] };
    return { pipeline: analysis.name, steps: analysis.steps.filter((s) => s.blockName === name) };
  }

  function renderBlock(block, version) {
    const parsed = BR.model.parseBlock(version.source);
    const newest = BR.model.latest(block);
    const used = usedBy(block.name);

    const inputTable = parsed.inputs.length
      ? el(
          "table",
          { class: "table" },
          el("caption", { class: "sr" }, `Inputs of ${block.name}`),
          el("thead", {}, el("tr", {}, ["Name", "Type", "If not set", "What it is"].map((h) => el("th", { scope: "col" }, h)))),
          el(
            "tbody",
            {},
            parsed.inputs.map((d) =>
              el(
                "tr",
                {},
                el("th", { scope: "row" }, d.name),
                el("td", {}, el("span", { class: "stamp stamp--type" }, d.type)),
                el("td", {}, d.required ? "Required" : el("span", {}, "Defaults to ", el("code", {}, String(d.default)))),
                el("td", {}, d.description),
              ),
            ),
          ),
        )
      : el("p", { class: "help" }, "This block reads nothing.");

    const outputTable = parsed.outputs.length
      ? el(
          "table",
          { class: "table" },
          el("caption", { class: "sr" }, `Outputs of ${block.name}`),
          el("thead", {}, el("tr", {}, ["Name", "Type", "What it is"].map((h) => el("th", { scope: "col" }, h)))),
          el(
            "tbody",
            {},
            parsed.outputs.map((d) => el("tr", {}, el("th", { scope: "row" }, d.name), el("td", {}, el("span", { class: "stamp stamp--type" }, d.type)), el("td", {}, d.description))),
          ),
        )
      : el("p", { class: "help" }, "This block declares no outputs. It passes or fails, and that is all a step can read from it.");

    detail.replaceChildren(
      el("a", { class: "btn back", href: "#list" }, "All blocks"),
      el(
        "div",
        { class: "detail__head" },
        el(
          "div",
          { class: "bar" },
          el(
            "div",
            { class: "detail__title" },
            el("h2", { class: "h2", id: "detail-title", tabindex: "-1" }, block.name),
            el("span", { class: "stamp stamp--type" }, parsed.runtime),
          ),
          el("a", { class: "btn", href: `#${block.name}/edit` }, "Write a new version"),
        ),
        el("p", { class: "lead" }, parsed.description),
        version !== newest ? el("p", {}, el("span", { class: "stamp" }, `viewing v${version.version}`), " Pipelines run ", el("a", { href: `#${block.name}` }, `v${newest.version}`), ".") : null,
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
          [...block.versions].reverse().map((v) => {
            const change = contractDiff(block, v);
            return el(
              "li",
              {},
              el(
                "a",
                { class: "version", href: `#${block.name}@${v.version}`, "aria-current": v === version ? "true" : null },
                el("span", { class: "version__num" }, `v${v.version}`),
                el("span", {}, v.published),
                el("span", { class: "version__note" }, v.note, change ? el("span", { class: "version__change" }, change) : null),
              ),
            );
          }),
        ),
      ),
      el(
        "section",
        { "aria-labelledby": "h-used" },
        el("h3", { class: "h3", id: "h-used" }, "Used by"),
        used.steps.length
          ? el("ul", { class: "usedby" }, used.steps.map((s) => el("li", {}, el("a", { href: `pipeline.html#step=${s.id}` }, `${used.pipeline}, step ${s.id}`))))
          : el("p", { class: "help" }, "No pipeline uses this block yet. Add it with Add step in the editor."),
      ),
      el(
        "section",
        { "aria-labelledby": "h-source" },
        el("h3", { class: "h3", id: "h-source" }, `Source of v${version.version}`),
        el("pre", { class: "code", tabindex: "0", "aria-labelledby": "h-source" }, el("code", {}, version.source)),
      ),
    );
  }

  function renderNothing() {
    if (library.length) {
      detail.replaceChildren(
        el("h2", { class: "h2", id: "detail-title", tabindex: "-1" }, "No such block"),
        el("p", {}, `There is nothing called ${location.hash.slice(1)} in the library.`),
        el("a", { class: "btn", href: `#${library[0].name}` }, `Open ${library[0].name}`),
      );
    } else {
      detail.replaceChildren(
        el(
          "div",
          { class: "stage__empty" },
          BR.sign("queued", "sign sign--large"),
          el("h2", { class: "h2", id: "detail-title", tabindex: "-1" }, "No blocks yet"),
          el("p", {}, "A pipeline needs at least one. Write the first block here: a bash file with its inputs and outputs in the front matter."),
          el("a", { class: "btn btn--ink", href: "#new" }, "Write a block"),
        ),
      );
    }
  }

  // ---------- writing ----------

  function renderWriter(base) {
    const startText = base ? BR.model.latest(base).source : FRONT + STARTERS.bash;
    let pristine = !base;
    const source = el("textarea", { id: "writer-source", wrap: "off", spellcheck: "false", autocapitalize: "off", value: startText });
    const note = el("input", { id: "writer-note", type: "text", placeholder: "What changed, in one line" });
    const declared = el("div", { class: "writer__side" });
    const error = el("p", { class: "form-error", role: "alert", hidden: true });
    const publishButton = el("button", { class: "btn btn--ink", type: "submit" }, base ? `Publish v${BR.model.latest(base).version + 1}` : "Publish v1");
    const starters = base
      ? null
      : el(
          "div",
          { class: "row", role: "group", "aria-label": "Start from a template" },
          el("span", { class: "label", style: "margin:0" }, "Start from"),
          BR.model_runtimes().map((name) =>
            el(
              "button",
              {
                class: "btn",
                type: "button",
                "data-starter": name,
                onclick: () => {
                  source.value = FRONT + STARTERS[name];
                  pristine = true;
                  update();
                },
              },
              name,
            ),
          ),
        );

    function update() {
      const parsed = BR.model.parseBlock(source.value);
      if (starters) starters.querySelectorAll("button").forEach((b) => { b.disabled = !pristine; });
      declared.replaceChildren(
        el(
          "div",
          {},
          el("h3", { class: "h3" }, "What this file declares"),
          parsed.problems.length
            ? el("p", {}, el("span", { class: "stamp" }, BR.sign("failed"), plural(parsed.problems.length, "problem")))
            : el("p", {}, el("span", { class: "stamp" }, BR.sign("succeeded"), "valid"), " ", el("span", { class: "stamp stamp--type" }, parsed.runtime)),
        ),
        parsed.problems.length
          ? el("ul", { class: "declared" }, parsed.problems.map((p) => el("li", {}, el("strong", {}, `Line ${p.line}: `), p.message, " ", el("code", {}, p.code))))
          : null,
        el(
          "div",
          {},
          el("h3", { class: "h3" }, "Inputs"),
          parsed.inputs.length
            ? el("ul", { class: "declared" }, parsed.inputs.map((d) => el("li", {}, el("code", {}, el("strong", {}, d.name)), ` ${d.type}, ${d.required ? "required" : `defaults to ${d.default}`}`)))
            : el("p", { class: "help" }, "None."),
        ),
        el(
          "div",
          {},
          el("h3", { class: "h3" }, "Outputs"),
          parsed.outputs.length
            ? el("ul", { class: "declared" }, parsed.outputs.map((d) => el("li", {}, el("code", {}, el("strong", {}, d.name)), ` ${d.type}`)))
            : el("p", { class: "help" }, "None."),
        ),
      );
    }

    source.addEventListener("input", () => {
      pristine = false;
      update();
    });

    detail.replaceChildren(
      el("a", { class: "btn back", href: base ? `#${base.name}` : "#list" }, base ? `Back to ${base.name}` : "All blocks"),
      el(
        "form",
        {
          class: "detail",
          onsubmit: (event) => {
            event.preventDefault();
            const parsed = BR.model.parseBlock(source.value);
            const fail = (message) => {
              error.hidden = false;
              error.textContent = message;
              source.focus();
            };
            if (parsed.problems.length) return fail(`Fix line ${parsed.problems[0].line} first: ${parsed.problems[0].message}`);
            if (parsed.name === "new-block") return fail('Give the block its own name: "new-block" is the template\'s.');
            if (base && parsed.name !== base.name) return fail(`This is a new version of ${base.name}, so its name has to stay ${base.name}.`);
            if (!base && library.some((b) => b.name === parsed.name)) return fail(`${parsed.name} already exists. Open it and write a new version instead.`);
            BR.publish(parsed.name, source.value, note.value.trim() || (base ? "No note." : "First version."));
            library = BR.library();
            location.hash = `#${parsed.name}`;
            BR.announce(`${parsed.name} published.`);
          },
        },
        el("h2", { class: "h2", id: "detail-title", tabindex: "-1" }, base ? `New version of ${base.name}` : "New block"),
        starters,
        el(
          "div",
          { class: "writer" },
          el("div", { class: "field" }, el("label", { class: "label", for: "writer-source" }, "The block file"), source),
          declared,
        ),
        el("div", { class: "field" }, el("label", { class: "label", for: "writer-note" }, "Note"), note),
        error,
        el("div", { class: "row" }, publishButton, el("a", { class: "btn", href: base ? `#${base.name}` : "#list" }, "Discard")),
      ),
    );
    update();
  }

  // ---------- routing ----------

  function route(moveFocus) {
    const hash = decodeURIComponent(location.hash);
    const isList = hash === "#list";
    lib.classList.remove("lib--open");
    if (hash === "#new") {
      lib.classList.add("lib--open");
      renderWriter(null);
    } else {
      const edit = hash.match(/^#([\w-]+)\/edit$/);
      const open = hash.match(/^#([\w-]+)(?:@(\d+))?$/);
      const name = (edit && edit[1]) || (open && !isList && open[1]) || (library[0] ? library[0].name : null);
      const block = library.find((b) => b.name === name);
      if (block) {
        if (edit) renderWriter(block);
        else {
          const version = open && open[2] ? block.versions.find((v) => v.version === Number(open[2])) : null;
          renderBlock(block, version || BR.model.latest(block));
        }
        if (location.hash && !isList) lib.classList.add("lib--open");
      } else {
        renderNothing();
        if (!library.length || (location.hash && !isList)) lib.classList.add("lib--open");
      }
    }
    renderList();
    if (moveFocus) {
      const target = document.getElementById("detail-title");
      if (target && !isList) target.focus();
      if (isList) searchInput.focus();
    }
  }

  renderFacets();
  window.addEventListener("hashchange", () => route(true));
  route(false);
})();
