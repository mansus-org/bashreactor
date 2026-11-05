// The pipeline editor. The one piece of state that matters is `text`, the YAML. Typing changes it
// directly; every control on the graph side computes a new text through model.ts. Everything on
// screen is drawn from analysing that text, so there is no second copy to keep in step.
//
// On top of the mockup's editor this adds the API: the block contracts come from the library, the
// document is opened and stored as versions, `Validate` is the server's own report, and `Start a run`
// is a POST. Ported from mockup/editor.js.

import { api, ApiError, canWrite } from "./api.js";
import type { ValidationIssue } from "./api.js";
import { announce, el, errorBox, sign } from "./dom.js";
import { createGraph } from "./graph.js";
import type { Graph } from "./graph.js";
import {
  addStep,
  analyze,
  editStep,
  latest,
  libraryRef,
  pinToLibrary,
  removeStep,
  rewrites,
  sourcesFor,
  wouldCycle,
} from "./model.js";
import type { Analysis, Library, Problem, Read, Step, StepInput } from "./model.js";
import type { Route } from "./app.js";
import { navigate } from "./app.js";

const BLANK = `name: new-pipeline
description: What this pipeline does.

steps:
`;

/** The token in the box is a read-only token, so nothing here may be clicked. */
const readOnly = () => !canWrite();

/** One YAML line, with keys, `${{ refs }}` and comments picked out. */
function paintLine(raw: string): HTMLElement {
  const line = el("span", { class: "yaml__line" });
  const commentAt = raw.search(/(^|\s)#/);
  const code = commentAt === -1 ? raw : raw.slice(0, commentAt);
  const comment = commentAt === -1 ? "" : raw.slice(commentAt);
  const key = /^(\s*(?:-\s+)?)([\w.-]+)(:)(.*)$/.exec(code);
  const rest = key !== null ? key[4]! : code;
  if (key !== null) line.append(key[1]!, el("span", { class: "yaml__key" }, key[2]!), key[3]!);
  let at = 0;
  for (const match of rest.matchAll(/\$\{\{.*?\}\}/g)) {
    line.append(rest.slice(at, match.index), el("span", { class: "yaml__ref" }, match[0]));
    at = (match.index ?? 0) + match[0].length;
  }
  line.append(rest.slice(at));
  if (comment !== "") line.append(el("span", { class: "yaml__comment" }, comment));
  if (raw === "") line.append(" ");
  return line;
}

function textField(options: {
  id: string;
  label: string;
  value: string | number | null;
  type?: string;
  placeholder?: string;
  onInput: (value: string) => void;
}): HTMLElement {
  return el(
    "div",
    { class: "field" },
    el("label", { class: "label", for: options.id }, options.label),
    el("input", {
      id: options.id,
      type: options.type ?? "text",
      value: options.value === null || options.value === undefined ? "" : String(options.value),
      placeholder: options.placeholder,
      disabled: readOnly(),
      spellcheck: "false",
      oninput: (event) => options.onInput((event.target as HTMLInputElement).value.trim()),
    }),
  );
}

/** A field that looks like a number is sent as one, because that is what the contract asks for. */
function coerce(raw: string): string | number {
  return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
}

export function renderPipeline(view: HTMLElement, route: Route): void {
  let text = BLANK;
  let analysis: Read = analyze(BLANK, {});
  let lastGood: Analysis | null = null;
  let selected: string | null = null;
  let library: Library = {};
  const fetched = new Set<string>();
  let openName: string | null = null;
  let openVersion: number | "latest" = "latest";
  let versions: { version: number; created_at: string }[] = [];
  let issues: { issue: ValidationIssue; line: number | null }[] = [];
  let validated = false;
  let saved = true;
  let undoStack: string[] = [];
  let undoKey: string | null = null;
  let flashed: Record<string, string> = {};
  let flashTimer: number | undefined;
  let busy = false;


  // ---------- skeleton ----------

  const title = el("h1", { class: "title" });
  const lead = el("p", { class: "lead" });
  const status = el("p", { class: "help", role: "status" });
  const openNameInput = el("input", {
    id: "open-name",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "word-report",
    "aria-describedby": "open-name-help",
  });
  const openButton = el("button", { class: "btn", type: "button", onclick: () => void openPipeline(openNameInput.value.trim(), "latest") }, "Open");
  const versionSelect = el("select", {
    id: "open-version",
    "aria-label": "Version of this pipeline",
    hidden: true,
    onchange: (event) => {
      const value = (event.target as HTMLSelectElement).value;
      void openPipeline(openName ?? "", value === "latest" ? "latest" : Number(value));
    },
  });
  const newButton = el("button", {
    class: "btn",
    type: "button",
    onclick: () => {
      openName = null;
      versions = [];
      issues = [];
      validated = false;
      saved = false;
      setText(BLANK, { source: "new" });
    },
  }, "New pipeline");
  const validateButton = el("button", { class: "btn", type: "button", onclick: () => void validate() }, "Validate");
  const saveButton = el("button", { class: "btn", type: "button", onclick: () => void save() }, "Save version");
  const runButton = el("button", { class: "btn btn--ink", type: "button", onclick: openStartDialog }, "Start a run");
  const runHint = el("p", { class: "help" });
  const stageNote = el("p", { class: "stale-note", role: "status", hidden: true });
  const stage = el("div", {
    class: "stage",
    id: "stage",
    role: "group",
    "aria-label": "Pipeline graph. Up and Down walk the steps, Right goes to a step this one feeds, Left to a step it waits for.",
  });
  const undoButton = el("button", { class: "btn", type: "button", disabled: true, onclick: undo }, "Undo");
  const addButton = el("button", { class: "btn", type: "button", onclick: openAddDialog }, "Add step");
  const pinButton = el("button", { class: "btn", type: "button", hidden: true, onclick: pinAll }, "Use library versions");
  const inspector = el("section", { class: "inspector", id: "inspector", "aria-labelledby": "inspector-title" });
  const statusStamp = el("a", { class: "stamp", href: "#problems" });

  const gutter = el("div", { class: "yaml__gutter", "aria-hidden": "true" });
  const paintInner = el("div", { class: "yaml__inner" });
  const paint = el("pre", { class: "yaml__paint", "aria-hidden": "true" }, paintInner);
  const textarea = el("textarea", {
    id: "doc",
    wrap: "off",
    spellcheck: "false",
    autocapitalize: "off",
    autocomplete: "off",
    "aria-describedby": "yaml-help",
  });
  const problemsList = el("ol", { class: "problems__list" });
  const problemsNote = el("p", { class: "help" });
  const startDialog = el("dialog", { class: "dialog", "aria-labelledby": "start-title" });
  const addDialog = el("dialog", { class: "dialog", "aria-labelledby": "add-title" });

  const graph: Graph = createGraph(stage, { onSelect: (id) => select(id, "graph") });

  view.replaceChildren(
    el(
      "div",
      { class: "head" },
      el("div", { class: "head__text" }, title, lead, status),
      el(
        "div",
        { class: "row" },
        el(
          "div",
          { class: "field" },
          el("label", { class: "label", for: "open-name" }, "Stored pipeline"),
          el("div", { class: "row" }, openNameInput, openButton, versionSelect),
          el(
            "p",
            { class: "help", id: "open-name-help" },
            "The API has no route that lists every pipeline, so a document is opened by name.",
          ),
        ),
        newButton,
      ),
      el(
        "div",
        { class: "row" },
        validateButton,
        saveButton,
        runButton,
      ),
      runHint,
    ),
    el(
      "div",
      { class: "ed" },
      el(
        "div",
        { class: "ed__graph" },
        el(
          "section",
          { "aria-labelledby": "graph-title" },
          el("div", { class: "bar" }, el("h2", { class: "h2", id: "graph-title" }, "Graph"), el("div", { class: "row" }, undoButton, pinButton, addButton)),
          stageNote,
          stage,
          el(
            "p",
            { class: "legend" },
            el("span", {}, el("span", { class: "sw sw--wired" }), "fed by a reference"),
            el("span", {}, el("span", { class: "sw sw--value" }), "set to a value"),
            el("span", {}, el("span", { class: "sw sw--data" }), "output feeds input"),
            el("span", {}, el("span", { class: "sw sw--needs" }), "order only, no data"),
          ),
        ),
        inspector,
      ),
      el(
        "section",
        { class: "ed__yaml", "aria-labelledby": "yaml-title" },
        el("div", { class: "bar" }, el("h2", { class: "h2", id: "yaml-title" }, "YAML"), statusStamp),
        el("label", { class: "sr", for: "doc" }, "Pipeline YAML"),
        el(
          "p",
          { class: "sr", id: "yaml-help" },
          "Edits redraw the graph. Moving the caret into a step selects it in the graph. Tab leaves this field.",
        ),
        el("div", { class: "yaml" }, gutter, el("div", { class: "yaml__code" }, paint, textarea)),
        el(
          "section",
          { class: "problems", id: "problems", "aria-labelledby": "problems-title", tabindex: "-1" },
          el("h3", { class: "h3", id: "problems-title" }, "Problems"),
          problemsNote,
          problemsList,
        ),
      ),
    ),
    startDialog,
    addDialog,
  );

  // ---------- text is the state ----------

  function setText(next: string, options: { source?: string; select?: string | null } = {}): void {
    const { source = "yaml", select: nextSelect } = options;
    text = next;
    if (source !== "yaml") textarea.value = text;
    if (source !== "yaml" && source !== "load" && source !== "new" && source !== "save") saved = false;
    analysis = analyze(text, library);
    if (analysis.ok) lastGood = analysis;

    if (analysis.ok) {
      if (nextSelect !== undefined) selected = nextSelect;
      if (selected !== null && analysis.byId[selected] === undefined) selected = null;
      if (selected === null && analysis.order.length > 0) selected = analysis.order[0]!;
    }
    render(source);
    void ensureLibrary();
    scheduleFlash();
  }

  function render(source: string): void {
    const shown = analysis.ok ? analysis : lastGood;
    const stale = !analysis.ok;

    if (shown !== null) {
      title.textContent = shown.name === "" ? "Untitled pipeline" : shown.name;
      lead.textContent = shown.description;
      document.title = `${shown.name === "" ? "Untitled" : shown.name} — Bashreactor`;
    }
    status.textContent = saved
      ? openName === null
        ? "Not stored yet."
        : `Stored as v${versions.find((v) => v.version === (openVersion === "latest" ? versions[0]?.version : openVersion))?.version ?? ""}, unchanged.`
      : "Unsaved changes.";

    stageNote.hidden = !stale;
    if (!analysis.ok) {
      stageNote.textContent = `Line ${analysis.error.line} does not parse. The graph shows the last version that did, as a ghost, until it does.`;
    }
    if (shown !== null) graph.update({ analysis: shown, selected, stale });

    const local = analysis.problems.length;
    const remote = issues.length;
    statusStamp.replaceChildren(
      sign(local + remote > 0 ? "failed" : "succeeded"),
      stale ? "does not parse" : local + remote > 0 ? `${local + remote} ${local + remote === 1 ? "problem" : "problems"}` : "valid",
    );

    const blocked = stale || local > 0 || remote > 0 || (shown?.steps.length ?? 0) === 0;
    runButton.disabled = blocked || readOnly();
    saveButton.disabled = blocked || readOnly();
    validateButton.disabled = busy;
    addButton.disabled = readOnly() || !analysis.ok;
    runHint.textContent = readOnly()
      ? "This token can read only, so nothing here can be stored or run."
      : stale || local > 0 || remote > 0
        ? `Fix ${local + remote === 1 ? "the problem" : `the ${local + remote} problems`} under the YAML to store or run this.`
        : (shown?.steps.length ?? 0) === 0
          ? "Add a step to store or run this."
          : "";
    runHint.hidden = runHint.textContent === "";

    const fixable = analysis.ok ? rewrites(text, analysis, library).length : 0;
    pinButton.hidden = fixable === 0;
    pinButton.disabled = readOnly();
    pinButton.textContent = fixable === 1 ? "Use the library version" : `Use library versions (${fixable})`;

    renderYaml();
    renderProblems();
    if (source !== "inspector-text") renderInspector();
  }

  function scheduleFlash(): void {
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      if (!analysis.ok) return;
      const now: Record<string, string> = Object.fromEntries(analysis.steps.map((step) => [step.id, JSON.stringify(step.raw)]));
      const changed = Object.keys(now).filter((id) => flashed[id] !== undefined && flashed[id] !== now[id]);
      const added = Object.keys(now).filter((id) => flashed[id] === undefined && Object.keys(flashed).length > 0);
      graph.flash([...changed, ...added]);
      flashed = now;
    }, 300);
  }

  // ---------- the library, which is the API's ----------

  /** Every block this document names, fetched once, so a step's contract is its own file's header. */
  async function ensureLibrary(): Promise<void> {
    if (!analysis.ok) return;
    const wanted = new Set<string>();
    for (const step of analysis.steps) {
      if (step.blockName === null || step.version === null) continue;
      const key = `${step.blockName}@${step.version}`;
      if (!fetched.has(key)) wanted.add(key);
    }
    if (wanted.size === 0) return;
    for (const key of wanted) {
      fetched.add(key);
      const [name, versionText] = key.split("@") as [string, string];
      const version = Number(versionText);
      try {
        const list = await api.blocks(name);
        const entry = library[name] ?? { name, versions: [] };
        if (!entry.versions.some((known) => known.version === version)) {
          const content = await api.blockContent(name, version);
          entry.versions = [...entry.versions, { version, source: content.text }].toSorted((a, b) => a.version - b.version);
        }
        library = { ...library, [name]: entry };
        void list;
      } catch (error) {
        // A block the library does not have stays unfetched: the analysis already says so, and a
        // retry on the next keystroke would be the same answer.
        if (error instanceof ApiError && error.status === 404) continue;
        fetched.delete(key);
        status.textContent = error instanceof ApiError ? `${error.code}: ${error.message}` : String(error);
        return;
      }
      if (analysis.ok) {
        analysis = analyze(text, library);
        if (analysis.ok) lastGood = analysis;
      }
    }
    render("library");
  }

  // ---------- the YAML pane ----------

  function badLines(): Set<number> {
    const bad = new Set<number>();
    for (const problem of analysis.problems) bad.add(problem.line);
    for (const entry of issues) if (entry.line !== null) bad.add(entry.line);
    return bad;
  }

  function renderYaml(): void {
    const lines = text.split("\n");
    const bad = badLines();
    const range = analysis.ok && selected !== null ? (analysis.byId[selected]?.range ?? null) : null;
    const hit = (n: number) => range !== null && n >= range.start && n <= range.end;
    paintInner.replaceChildren(
      ...lines.map((raw, index) => {
        const line = paintLine(raw);
        if (hit(index + 1)) line.classList.add("is-hit");
        return line;
      }),
    );
    gutter.replaceChildren(
      ...lines.map((_, index) =>
        el("span", { class: `yaml__num${hit(index + 1) ? " is-hit" : ""}${bad.has(index + 1) ? " is-bad" : ""}` }, String(index + 1)),
      ),
    );
    syncScroll();
  }

  function syncScroll(): void {
    paint.scrollTop = textarea.scrollTop;
    paint.scrollLeft = textarea.scrollLeft;
    gutter.scrollTop = textarea.scrollTop;
  }

  function lineHeight(): number {
    return Number.parseFloat(getComputedStyle(textarea).lineHeight) || 24;
  }

  function scrollToLine(line: number): void {
    textarea.scrollTop = Math.max(0, (line - 2) * lineHeight());
    syncScroll();
  }

  function caretLine(): number {
    return text.slice(0, textarea.selectionStart).split("\n").length;
  }

  function placeCaret(line: number): void {
    const lines = text.split("\n");
    const offset = lines.slice(0, line - 1).reduce((total, current) => total + current.length + 1, 0);
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(offset, offset);
    scrollToLine(line);
    if (analysis.ok) select(stepAtLineSafe(line) ?? selected, "yaml");
  }

  function stepAtLineSafe(line: number): string | null {
    if (!analysis.ok) return null;
    const hit = analysis.steps.find((step) => line >= step.range.start && line <= step.range.end);
    return hit !== undefined ? hit.id : null;
  }

  function followCaret(): void {
    if (!analysis.ok) return;
    const id = stepAtLineSafe(caretLine());
    if (id !== null && id !== selected) select(id, "yaml");
  }

  textarea.addEventListener("input", () => {
    setText(textarea.value, { source: "yaml" });
    followCaret();
  });
  textarea.addEventListener("scroll", syncScroll);
  textarea.addEventListener("keyup", followCaret);
  textarea.addEventListener("click", followCaret);

  // ---------- selection ----------

  function select(id: string | null, from: "graph" | "yaml" | "other"): void {
    if (!analysis.ok || id === null || analysis.byId[id] === undefined) return;
    selected = id;
    graph.select(id);
    renderYaml();
    renderInspector();
    if (from === "graph") {
      scrollToLine(analysis.byId[id]!.range.start);
      announce(`Step ${id} selected, YAML lines ${analysis.byId[id]!.range.start} to ${analysis.byId[id]!.range.end}.`);
    }
  }

  // ---------- the inspector: the graph side of editing ----------

  let focusAfter: string | null = null;
  function restoreFocus(): void {
    if (focusAfter === null) return;
    const target = document.getElementById(focusAfter);
    focusAfter = null;
    if (target !== null && target !== document.activeElement) target.focus();
  }

  function edit(next: string, key: string | null, nextSelect?: string | null): void {
    if (key !== undoKey || key === null) undoStack.push(text);
    undoKey = key;
    undoButton.disabled = false;
    setText(next, { source: key !== null && key.startsWith("text:") ? "inspector-text" : "inspector", select: nextSelect });
    restoreFocus();
  }

  function undo(): void {
    const previous = undoStack.pop();
    if (previous === undefined) return;
    undoKey = null;
    undoButton.disabled = undoStack.length === 0;
    setText(previous, { source: "graph" });
    announce("Last graph edit undone.");
    addButton.focus();
  }

  function inputRow(step: Step, input: StepInput): HTMLElement {
    const fieldId = `f-in-${input.name}`;
    const source = input.source;
    const isRef = source.kind === "input" || source.kind === "output";
    const typed = source.kind === "literal" || source.kind === "template";
    const options = analysis.ok ? sourcesFor(analysis, step.id) : [];
    const current = isRef ? String(source.value) : typed ? "__typed" : "__unset";
    const known = !isRef || options.some((option) => option.value === source.value);
    const choice = el(
      "select",
      {
        id: fieldId,
        "aria-label": `Where ${input.name} comes from`,
        disabled: readOnly(),
        onchange: (event) => {
          const value = (event.target as HTMLSelectElement).value;
          focusAfter = value === "__typed" ? `${fieldId}-value` : fieldId;
          if (value === "__unset") edit(editStep(text, step.id, `with.${input.name}`, undefined), null);
          else if (value === "__typed") {
            edit(editStep(text, step.id, `with.${input.name}`, typed ? source.value : input.default === null ? "" : input.default), null);
          } else edit(editStep(text, step.id, `with.${input.name}`, value), null);
        },
      },
      el("option", { value: "__unset" }, input.default !== null ? `Block default (${input.default})` : "Not set"),
      el("option", { value: "__typed" }, "Typed value"),
      options.map((option) => el("option", { value: option.value }, option.label)),
      known ? null : el("option", { value: String(source.value) }, String(source.value)),
    );
    choice.value = current;
    return el(
      "div",
      { class: "wire-row" },
      el("div", { class: "wire-row__name" }, input.name, el("small", {}, `${input.type}${input.required ? ", required" : ""}`)),
      el("div", { class: typed ? "" : "wide" }, choice),
      typed
        ? el(
            "div",
            {},
            el("label", { class: "sr", for: `${fieldId}-value` }, `Value of ${input.name}`),
            el("input", {
              id: `${fieldId}-value`,
              type: "text",
              spellcheck: "false",
              disabled: readOnly(),
              value: source.value === null ? "" : String(source.value),
              oninput: (event) => edit(editStep(text, step.id, `with.${input.name}`, coerce((event.target as HTMLInputElement).value)), `text:${fieldId}`),
            }),
          )
        : null,
    );
  }

  function renderInspector(): void {
    if (!analysis.ok) {
      inspector.replaceChildren(
        el("h2", { class: "h2", id: "inspector-title" }, "Step"),
        el("p", { class: "help" }, `Fix line ${analysis.error.line} in the YAML to edit steps here again.`),
      );
      return;
    }
    const step = selected !== null ? (analysis.byId[selected] ?? null) : null;
    if (step === null) {
      inspector.replaceChildren(
        el("h2", { class: "h2", id: "inspector-title" }, "Step"),
        el("p", { class: "help" }, "Add a step and its block, timeout, retries and wiring can be edited here."),
      );
      return;
    }

    const active = inspector.contains(document.activeElement) ? document.activeElement?.id ?? null : null;
    const usesOptions = Object.keys(library)
      .toSorted()
      .map((name) => libraryRef(name, latest(library[name]!).version));
    const usesSelect = el(
      "select",
      {
        id: "f-uses",
        disabled: readOnly(),
        onchange: (event) => {
          focusAfter = "f-uses";
          edit(editStep(text, step.id, "uses", (event.target as HTMLSelectElement).value), null);
        },
      },
      usesOptions.map((uses) => el("option", { value: uses }, uses)),
      step.uses !== null && !usesOptions.includes(step.uses) ? el("option", { value: step.uses }, step.uses) : null,
      step.uses === null ? el("option", { value: "" }, "Pick a block") : null,
    );
    usesSelect.value = step.uses ?? "";

    const others = analysis.steps.filter((other) => other.id !== step.id);
    const fedBy = new Set(analysis.edges.filter((edge) => edge.to === step.id && edge.kind === "data").map((edge) => edge.from));

    inspector.replaceChildren(
      el(
        "div",
        { class: "bar" },
        el("h2", { class: "h2", id: "inspector-title" }, step.id),
        el(
          "div",
          { class: "row" },
          el("button", { class: "btn", type: "button", onclick: () => placeCaret(step.range.start) }, "Edit in YAML"),
          step.blockName !== null ? el("a", { class: "btn", href: `/app/blocks/${step.blockName}`, "data-link": "" }, "Open block") : null,
          el(
            "button",
            {
              class: "btn",
              type: "button",
              disabled: readOnly(),
              onclick: () => {
                edit(removeStep(text, analysis as Analysis, step.id), null, null);
                announce(`Step ${step.id} removed. Undo brings it back.`);
                addButton.focus();
              },
            },
            "Remove step",
          ),
        ),
      ),
      el(
        "div",
        { class: "inspector__body" },
        el(
          "div",
          { class: "grid2" },
          textField({
            id: "f-name",
            label: "Name",
            value: step.title,
            onInput: (value) => edit(editStep(text, step.id, "name", value === "" ? undefined : value), "text:name"),
          }),
          el("div", { class: "field" }, el("label", { class: "label", for: "f-uses" }, "Block"), usesSelect),
          textField({
            id: "f-timeout",
            label: "Timeout",
            value: step.timeout,
            placeholder: "6h",
            onInput: (value) => edit(editStep(text, step.id, "timeout", value === "" ? undefined : coerce(value)), "text:timeout"),
          }),
          textField({
            id: "f-attempts",
            label: "Max attempts",
            value: step.maxAttempts === null ? null : String(step.maxAttempts),
            type: "number",
            placeholder: "1",
            onInput: (value) => edit(editStep(text, step.id, "retry.max_attempts", value === "" ? undefined : coerce(value)), "text:attempts"),
          }),
          textField({
            id: "f-delay",
            label: "Delay between attempts",
            value: step.delay === null ? null : String(step.delay),
            placeholder: "1s",
            onInput: (value) => edit(editStep(text, step.id, "retry.delay", value === "" ? undefined : coerce(value)), "text:delay"),
          }),
        ),
        step.inputs.length > 0
          ? el("div", {}, el("h3", { class: "h3" }, "Inputs"), step.inputs.map((input) => inputRow(step, input)))
          : step.contract !== null
            ? el("p", { class: "help" }, `${step.uses} declares no inputs.`)
            : null,
        others.length > 0
          ? el(
              "fieldset",
              { class: "fieldset" },
              el("legend", { class: "h3" }, "Waits for"),
              el(
                "p",
                { class: "help" },
                "A reference to an output already waits for that step. Tick a step here to wait for it without reading anything from it.",
              ),
              el(
                "div",
                { class: "checks" },
                others.map((other) => {
                  const implied = fedBy.has(other.id);
                  const explicit = step.needs.includes(other.id);
                  const cycles = !explicit && !implied && wouldCycle(analysis as Analysis, step.id, other.id);
                  return el(
                    "label",
                    { class: "check" },
                    el("input", {
                      id: `f-need-${other.id}`,
                      type: "checkbox",
                      checked: explicit || implied,
                      disabled: readOnly() || implied || cycles,
                      onchange: (event) => {
                        focusAfter = `f-need-${other.id}`;
                        const next = (event.target as HTMLInputElement).checked ? [...step.needs, other.id] : step.needs.filter((need) => need !== other.id);
                        edit(editStep(text, step.id, "needs", next.length > 0 ? next : undefined), null);
                      },
                    }),
                    el(
                      "span",
                      {},
                      other.id,
                      implied ? el("span", { class: "help" }, "Already implied by a reference.") : cycles ? el("span", { class: "help" }, "Would make a cycle.") : null,
                    ),
                  );
                }),
              ),
            )
          : null,
      ),
    );
    if (active !== null) document.getElementById(active)?.focus();
  }

  // ---------- problems: the editor's own, and the API's ----------

  /** The API names a path, never a line; the parse keeps every key's range, so the path finds its line. */
  function lineOfPath(path: string): number | null {
    if (!analysis.ok) return null;
    const parts = path.split(".");
    for (let end = parts.length; end > 0; end--) {
      const loc = analysis.locs[parts.slice(0, end).join(".")];
      if (loc !== undefined) return loc.start;
    }
    return null;
  }

  function renderProblems(): void {
    const local: Problem[] = analysis.problems;
    const remote = issues.map((entry) => ({
      code: entry.issue.code,
      line: entry.line ?? 1,
      message: entry.issue.message,
      step: null,
      path: entry.issue.path,
    }));
    const all = [...local.map((problem) => ({ ...problem, path: undefined as string | undefined })), ...remote].toSorted(
      (a, b) => a.line - b.line,
    );
    problemsNote.textContent = validated
      ? all.length === 0
        ? "None. The document is valid, and the API agreed."
        : "Live checks as you type, and the API's own report from the last Validate."
      : all.length === 0
        ? "None so far. The editor's own checks are these; Validate asks the API."
        : "These are the editor's own checks. Validate asks the API, which is the one that will refuse to store it.";
    problemsList.replaceChildren(
      ...all.map((entry) =>
        el(
          "li",
          {},
          el(
            "button",
            { class: "problem", type: "button", onclick: () => placeCaret(entry.line) },
            el("span", { class: "problem__at" }, `Line ${entry.line}`),
            el("span", { class: "problem__msg" }, entry.message),
            el("span", { class: "problem__code" }, entry.path !== undefined ? `${entry.code} · ${entry.path}` : entry.code),
          ),
        ),
      ),
    );
  }

  // ---------- the API ----------

  async function openPipeline(name: string, version: number | "latest"): Promise<void> {
    if (name === "") return;
    busy = true;
    status.textContent = `Opening ${name}.`;
    try {
      const list = await api.pipelines(name);
      const wanted = version === "latest" ? list.latest : version;
      const record = await api.pipelineVersion(name, wanted);
      openName = name;
      openVersion = wanted;
      versions = list.versions.map((entry) => ({ version: entry.version, created_at: entry.created_at }));
      issues = [];
      validated = false;
      saved = true;
      openNameInput.value = name;
      versionSelect.hidden = false;
      versionSelect.replaceChildren(
        ...versions.toReversed().map((entry) => el("option", { value: String(entry.version) }, `v${entry.version}, ${entry.created_at.slice(0, 16)}`)),
      );
      versionSelect.value = String(wanted);
      setText(record.yaml, { source: "load" });
      announce(`${name} version ${wanted} opened.`);
    } catch (error) {
      versionSelect.hidden = true;
      view.prepend(
        errorBox(error instanceof ApiError ? error : { code: "internal_error", message: String(error) }, el("a", { class: "btn", href: "/app/", "data-link": "" }, "The entry page")),
      );
      status.textContent = "";
    } finally {
      busy = false;
    }
  }

  async function validate(): Promise<void> {
    busy = true;
    validateButton.disabled = true;
    status.textContent = "Asking the API.";
    try {
      const report = await api.validate(text);
      issues = report.issues.map((issue) => ({ issue, line: lineOfPath(issue.path ?? "") }));
      validated = true;
      render("validate");
      status.textContent = report.valid ? "The API says this document is valid." : `The API found ${report.issues.length} ${report.issues.length === 1 ? "issue" : "issues"}.`;
      announce(report.valid ? "Valid." : `The API found ${report.issues.length} problems.`);
    } catch (error) {
      status.textContent = error instanceof ApiError ? `${error.code}: ${error.message}` : String(error);
    } finally {
      busy = false;
      render("validate");
    }
  }

  async function save(): Promise<void> {
    if (!analysis.ok) return;
    const name = analysis.name;
    if (name === "") return;
    busy = true;
    saveButton.disabled = true;
    status.textContent = `Storing ${name}.`;
    try {
      const record = await api.savePipeline(name, text);
      openName = name;
      openVersion = record.version;
      saved = true;
      const list = await api.pipelines(name);
      versions = list.versions.map((entry) => ({ version: entry.version, created_at: entry.created_at }));
      versionSelect.hidden = false;
      versionSelect.replaceChildren(
        ...versions.toReversed().map((entry) => el("option", { value: String(entry.version) }, `v${entry.version}, ${entry.created_at.slice(0, 16)}`)),
      );
      versionSelect.value = String(record.version);
      openNameInput.value = name;
      status.textContent = `Stored as v${record.version}.`;
      announce(`${name} stored as version ${record.version}.`);
      navigate(`/pipeline/${name}/${record.version}`, { replace: true });
    } catch (error) {
      // A pipeline that does not validate is a 422 with its first issue, which is the same object the
      // problems pane lists: show it where it belongs rather than in a banner that says "failed".
      if (error instanceof ApiError && error.status === 422) {
        issues = [{ issue: { code: error.code, message: error.message, path: error.path }, line: lineOfPath(error.path ?? "") }];
        render("save");
        status.textContent = "The API refused to store this. Its issue is in the list.";
      } else {
        status.textContent = error instanceof ApiError ? `${error.code}: ${error.message}` : String(error);
      }
    } finally {
      busy = false;
      render("save");
    }
  }

  function pinAll(): void {
    if (!analysis.ok) return;
    edit(pinToLibrary(text, analysis, library), null);
    announce("Every step that pointed at a file now points at the library version.");
  }

  // ---------- dialogs ----------

  function openAddDialog(): void {
    const names = Object.keys(library).toSorted();
    if (names.length === 0) {
      announce("There is no block in the library yet. Publish one on the Blocks screen first.");
      status.textContent = "Add a step by typing it in the YAML, or publish a block on the Blocks screen.";
      return;
    }
    const usesSelect = el(
      "select",
      { id: "add-uses" },
      names.map((name) => el("option", { value: name }, libraryRef(name, latest(library[name]!).version))),
    );
    const idInput = el("input", { id: "add-id", type: "text", spellcheck: "false", autocomplete: "off" });
    const error = el("p", { class: "form-error", role: "alert", hidden: true });
    const suggest = (): void => {
      if (!analysis.ok) return;
      const base = usesSelect.value;
      let candidate = base;
      for (let n = 2; analysis.ok && analysis.byId[candidate] !== undefined; n++) candidate = `${base}-${n}`;
      idInput.value = candidate;
    };
    usesSelect.addEventListener("change", suggest);
    suggest();

    addDialog.replaceChildren(
      el(
        "form",
        {
          class: "dialog__body",
          method: "dialog",
          onsubmit: (event) => {
            event.preventDefault();
            const model = analysis;
            if (!model.ok) return;
            const id = idInput.value.trim();
            if (!/^[a-z][\w-]*$/.test(id)) {
              error.hidden = false;
              error.textContent = "A step id starts with a lowercase letter and has only letters, numbers, - and _.";
              idInput.focus();
              return;
            }
            if (model.byId[id] !== undefined) {
              error.hidden = false;
              error.textContent = `There is already a step called ${id}.`;
              idInput.focus();
              return;
            }
            const next = addStep(text, model, id, { uses: libraryRef(usesSelect.value, latest(library[usesSelect.value]!).version) });
            addDialog.close();
            edit(next, null, id);
            // The edit re-analysed the text, so the new step's lines are in the current analysis.
            const added = analysis.ok ? analysis.byId[id] : undefined;
            scrollToLine(added?.range.start ?? 1);
            graph.focus(id);
            announce(`Step ${id} added.`);
          },
        },
        el("h2", { class: "dialog__title", id: "add-title" }, "Add a step"),
        el("div", { class: "field" }, el("label", { class: "label", for: "add-uses" }, "Block"), usesSelect),
        el("div", { class: "field" }, el("label", { class: "label", for: "add-id" }, "Step id"), idInput),
        error,
        el(
          "div",
          { class: "row" },
          el("button", { class: "btn btn--ink", type: "submit" }, "Add step"),
          el("button", { class: "btn", type: "button", onclick: () => addDialog.close() }, "Cancel"),
        ),
      ),
    );
    addDialog.showModal();
  }

  function openStartDialog(): void {
    if (!analysis.ok) return;
    const error = el("p", { class: "form-error", role: "alert", hidden: true });
    const fields = analysis.inputs.map((input) => {
      const field = el("input", {
        id: `start-${input.name}`,
        type: input.type === "integer" ? "number" : "text",
        value: input.default === null ? "" : String(input.default),
        spellcheck: "false",
        "aria-describedby": input.description !== "" ? `start-${input.name}-help` : null,
      });
      return el(
        "div",
        { class: "field" },
        el("label", { class: "label", for: `start-${input.name}` }, input.name),
        field,
        input.description !== "" ? el("p", { class: "help", id: `start-${input.name}-help` }, input.description) : null,
      );
    });
    startDialog.replaceChildren(
      el(
        "form",
        {
          class: "dialog__body",
          onsubmit: (event) => {
            event.preventDefault();
            if (!analysis.ok) return;
            const inputs: Record<string, unknown> = {};
            for (const input of analysis.inputs) {
              const field = document.getElementById(`start-${input.name}`) as HTMLInputElement | null;
              const raw = (field?.value ?? "").trim();
              if (raw === "" && input.required) {
                error.hidden = false;
                error.textContent = `${input.name} has no default, so this run needs a value for it.`;
                field?.focus();
                return;
              }
              if (raw !== "") inputs[input.name] = coerce(raw);
            }
            startRun(inputs);
          },
        },
        el("h2", { class: "dialog__title", id: "start-title" }, `Start ${analysis.name}`),
        fields.length > 0 ? fields : el("p", {}, "This pipeline takes no inputs."),
        el(
          "p",
          { class: "help" },
          saved
            ? "This starts the stored version you have open, so what runs is what is on the record."
            : "These are unsaved changes: the run takes the YAML as it stands here, and nothing is stored.",
        ),
        error,
        el(
          "div",
          { class: "row" },
          el("button", { class: "btn btn--ink", type: "submit" }, "Start the run"),
          el("button", { class: "btn", type: "button", onclick: () => startDialog.close() }, "Cancel"),
        ),
      ),
    );
    startDialog.showModal();
  }

  async function startRun(inputs: Record<string, unknown>): Promise<void> {
    startDialog.close();
    busy = true;
    status.textContent = "Starting the run.";
    try {
      const body = saved && openName !== null ? { pipeline: openName, version: openVersion === "latest" ? undefined : openVersion, inputs } : { yaml: text, inputs };
      const run = await api.startRun(body);
      announce(`Run ${run.id} started.`);
      navigate(`/runs/${run.id}`);
    } catch (error) {
      busy = false;
      status.textContent = "";
      startDialog.replaceChildren(
        errorBox(error instanceof ApiError ? error : { code: "internal_error", message: String(error) }, el("button", { class: "btn", type: "button", onclick: () => startDialog.close() }, "Close")),
      );
      startDialog.showModal();
    }
  }

  // ---------- start ----------

  textarea.value = text;
  const name = route.parts[1];
  const version = route.parts[2];
  if (name !== undefined) {
    void openPipeline(name, version === undefined ? "latest" : Number(version));
  } else {
    setText(BLANK, { source: "init" });
  }
  flashed = analysis.ok ? Object.fromEntries(analysis.steps.map((step) => [step.id, JSON.stringify(step.raw)])) : {};
}
