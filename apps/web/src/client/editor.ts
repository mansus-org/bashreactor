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
  readUses,
  removeStep,
  rewrites,
  sourcesFor,
  wouldCycle,
} from "./model.js";
import type { Analysis, Library, Problem, Read, Step, StepInput } from "./model.js";
import type { Json } from "./yaml.js";
import type { Route } from "./app.js";
import { navigate } from "./app.js";

const BLANK = `name: new-pipeline
description: What this pipeline does.

steps:
`;

/** SPEC 1.1: a step id starts with a lowercase letter and takes only lowercase letters, digits and `_`. */
const STEP_ID = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The version a route asks for. `undefined` is the newest one; anything that is not a whole number
 * from 1 up is no version at all, and asking the API for `NaN` is not how to say that.
 */
function routeVersion(raw: string | undefined): number | "latest" | null {
  if (raw === undefined || raw === "") return "latest";
  return /^[1-9][0-9]*$/.test(raw) ? Number(raw) : null;
}

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

type PipelineInput = Analysis["inputs"][number];
type Reading = { ok: true; value: Json | undefined } | { ok: false; message: string };

// SPEC 1.2, text form. A value is sent in the type its input declares, and the text only has to be
// something that type can be read from: how it looks decides nothing.
const INTEGER = /^-?(0|[1-9][0-9]*)$/;
const NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

/** What a number or json field's text means, or the sentence that says why it means nothing. */
function parseTyped(type: string, name: string, text: string): Reading {
  const raw = text.trim();
  if (type === "integer") {
    return INTEGER.test(raw) && Number.isSafeInteger(Number(raw))
      ? { ok: true, value: Number(raw) }
      : { ok: false, message: `${name} is an integer: type a whole number such as 42.` };
  }
  if (type === "number") {
    return NUMBER.test(raw) && Number.isFinite(Number(raw))
      ? { ok: true, value: Number(raw) }
      : { ok: false, message: `${name} is a number: type a figure such as 3.5.` };
  }
  if (type === "json") {
    try {
      return { ok: true, value: JSON.parse(raw) as Json };
    } catch (error) {
      return { ok: false, message: `${name} is JSON, and this is not: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ok: true, value: text };
}

/** The empty value of a type, for a typed field that has no default to start from. */
function blankOf(type: string): Json {
  return type === "integer" || type === "number" ? 0 : type === "boolean" ? false : type === "json" ? null : "";
}

/**
 * Whether `editStep` writes this value into the YAML faithfully. It prints an object as
 * `[object Object]` and does not quote a comma inside a list item, so only a scalar, or a list of
 * plain ones, goes through it.
 */
function writable(value: Json): boolean {
  if (Array.isArray(value)) {
    return value.every((item) => item === null || typeof item === "number" || typeof item === "boolean" || (typeof item === "string" && /^[\w .-]*$/.test(item)));
  }
  return value === null || typeof value !== "object";
}

const HINTS: Record<string, string> = {
  integer: "A whole number.",
  number: "A number.",
  json: "JSON. It is sent as JSON, so text that is not JSON is not sent.",
  file: "An absolute path to a file on the server this runs on. The engine copies it into the run.",
};

/**
 * One field of the Start dialog. It remembers what it was drawn with, and `read` answers `undefined`
 * for a field that still holds that, so a default nobody touched is not sent and runs as declared.
 */
function startField(input: PipelineInput): { node: HTMLElement; control: HTMLElement; read: () => Reading } {
  // Not `start-<name>`: an input called `title` would take the id of the dialog's own heading.
  const id = `start-in-${input.name}`;
  const helpText = [input.description, HINTS[input.type] ?? ""].filter((part) => part !== "").join(" ");
  const help = helpText !== "" ? el("p", { class: "help", id: `${id}-help` }, helpText) : null;
  const describedBy = help !== null ? `${id}-help` : null;
  const needsValue: Reading = { ok: false, message: `${input.name} has no default, so this run needs a value for it.` };
  const untouched: Reading = { ok: true, value: undefined };

  if (input.type === "boolean") {
    const declared = input.default === true;
    const box = el("input", { id, type: "checkbox", "aria-describedby": describedBy });
    box.checked = declared;
    return {
      node: el("div", { class: "field" }, el("label", { class: "check" }, box, el("span", {}, input.name)), help),
      control: box,
      // A checkbox always has an answer, so one with no default has to send it.
      read: () => (!input.required && box.checked === declared ? untouched : { ok: true, value: box.checked }),
    };
  }

  const initial = input.type === "json" ? (input.required ? "" : JSON.stringify(input.default, null, 2)) : input.default === null ? "" : String(input.default);
  const control: HTMLInputElement | HTMLTextAreaElement =
    input.type === "json"
      ? el("textarea", { id, class: "code", rows: 6, spellcheck: "false", autocomplete: "off", "aria-describedby": describedBy })
      : el("input", {
          id,
          type: "text",
          inputmode: input.type === "integer" ? "numeric" : input.type === "number" ? "decimal" : null,
          placeholder: input.type === "file" ? "/absolute/path/on/the/server" : null,
          spellcheck: "false",
          autocomplete: "off",
          "aria-describedby": describedBy,
        });
  control.value = initial;
  return {
    node: el("div", { class: "field" }, el("label", { class: "label", for: id }, input.name), control, help),
    control,
    read: () => {
      const raw = control.value;
      const text = input.type === "string" || input.type === "file" ? raw : raw.trim();
      if (text === "" && input.required) return needsValue;
      if (raw === initial) return untouched;
      if (input.type === "file") {
        return raw.startsWith("/") ? { ok: true, value: raw } : { ok: false, message: `${input.name} is a file: give the absolute path to it on the server, starting with /.` };
      }
      return parseTyped(input.type, input.name, raw);
    },
  };
}

export function renderPipeline(view: HTMLElement, route: Route, signal: AbortSignal): void {
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
  // The bytes the record holds, or the blank template for a document that was never stored.
  // "Unchanged" is a comparison against it, not a flag, so typing, undoing and retyping the
  // original all read true.
  let baseline = BLANK;
  // Whether what is on screen came out of this tab's own draft rather than off the record.
  let restored = false;
  let undoStack: string[] = [];
  let undoKey: string | null = null;
  let flashed: Record<string, string> = {};
  let flashTimer: number | undefined;
  let busy = false;

  // The router aborts this signal the moment the reader moves on, and everything that comes back
  // afterwards has to be dropped: this screen writes the document title, and `view` belongs to
  // whoever is on screen now.
  const gone = (): boolean => signal.aborted;
  const unchanged = (): boolean => text === baseline;
  /** Only then may a run name the stored version: anything else has to carry the YAML on screen. */
  const runsStored = (): boolean => openName !== null && unchanged();

  /**
   * Work in progress lives in this tab until it is stored (#24): moving to another screen used to
   * take it with the page. It is keyed by what is open, so one document's edits never land on
   * another when the reader comes back.
   */
  const draftKey = (): string => `bashreactor.draft.${openName ?? "new"}.${openVersion}`;
  function keepDraft(): void {
    if (unchanged() || text === BLANK) sessionStorage.removeItem(draftKey());
    else sessionStorage.setItem(draftKey(), text);
  }

  /** The edits this tab had for what is open now, put back on screen and said out loud. */
  function restoreDraft(): void {
    const saved = sessionStorage.getItem(draftKey());
    if (saved === null || saved === text) return;
    setText(saved, { source: "load" });
    restored = true;
    announce("The unsaved edits this tab had are back on screen.");
  }

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
  const openButton = el("button", { class: "btn", type: "button", onclick: () => void openChosen() }, "Open");
  const openError = el("p", { class: "form-error", id: "open-error", role: "alert", hidden: true });
  const versionSelect = el("select", {
    id: "open-version",
    "aria-label": "Version of this pipeline",
    hidden: true,
    onchange: (event) => {
      const value = (event.target as HTMLSelectElement).value;
      if (openName === null) return;
      if (!confirmLeave()) {
        versionSelect.value = String(openVersion);
        return;
      }
      // The address bar says which version is open, so a reload or a bookmark comes back here.
      navigate(`/pipeline/${openName}/${value}`, { replace: true });
    },
  });
  const newButton = el("button", {
    class: "btn",
    type: "button",
    onclick: () => {
      if (!confirmLeave()) return;
      openName = null;
      openVersion = "latest";
      versions = [];
      issues = [];
      validated = false;
      versionSelect.hidden = true;
      baseline = BLANK;
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
  const discardButton = el("button", { class: "btn", type: "button", hidden: true, onclick: discardChanges }, "Discard changes");
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
  signal.addEventListener("abort", () => {
    window.clearTimeout(flashTimer);
    graph.destroy();
  });

  // Leaving must be a choice the person made, not something that happens to them (#24). The router
  // owns the address bar, so this catches the two ways out of a screen that a screen can see coming:
  // a link clicked here, and the tab going away. Back and forwards are the router's to guard.
  // Both listeners go away with the screen, because they are registered with its own signal.
  document.addEventListener("click", leaveAttempt, { capture: true, signal });
  window.addEventListener("beforeunload", unload, { signal });

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
          openError,
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
          el("div", { class: "bar" }, el("h2", { class: "h2", id: "graph-title" }, "Graph"), el("div", { class: "row" }, undoButton, discardButton, pinButton, addButton)),
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
    if (next !== text) {
      // The API's report is about the bytes it was given (#21). Once they have changed it proves
      // nothing about what is on screen, so it stops being a problem the reader has to clear.
      issues = [];
      validated = false;
      restored = false;
    }
    text = next;
    if (source !== "yaml") textarea.value = text;
    analysis = analyze(text, library);
    if (analysis.ok) lastGood = analysis;

    if (analysis.ok) {
      if (nextSelect !== undefined) selected = nextSelect;
      if (selected !== null && analysis.byId[selected] === undefined) selected = null;
      if (selected === null && analysis.order.length > 0) selected = analysis.order[0]!;
    }
    render(source);
    // A load is the record arriving, or a draft going back where it came from: neither is news.
    if (source !== "load" && source !== "init") keepDraft();
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
    status.textContent = unchanged()
      ? openName === null
        ? "Not stored yet."
        : `Stored as v${versions.find((v) => v.version === (openVersion === "latest" ? versions[0]?.version : openVersion))?.version ?? ""}, unchanged.`
      : restored
        ? "Unsaved changes, brought back from earlier in this tab."
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
    // The way out of a document that is not the record, which is also how a draft gets thrown away.
    discardButton.hidden = readOnly() || unchanged();

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

  // ---------- leaving, and throwing work away ----------

  /**
   * Whether the reader may replace what is on screen. Unsaved work is not thrown away silently: the
   * tab keeps it, so coming back brings it back, but the person still has to be the one who decides.
   */
  function confirmLeave(): boolean {
    if (unchanged()) return true;
    return window.confirm("You have unsaved changes. Carry on? This tab keeps them, so coming back brings them back.");
  }

  /** A link that would take the router somewhere else, seen before the router does. */
  function leaveAttempt(event: Event): void {
    if (gone()) return; // this screen is already off screen, and has no say over where the reader goes
    const link = (event.target as Element | null)?.closest?.("a[data-link]") as HTMLAnchorElement | null;
    if (link === null) return;
    if (!(link.getAttribute("href") ?? "").startsWith("/app")) return;
    if (confirmLeave()) return;
    // The router answers this same click, so it must not see it at all.
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function unload(event: BeforeUnloadEvent): void {
    if (unchanged()) return;
    // A browser will show its own words for this; there is nothing to gain by writing them.
    event.preventDefault();
    event.returnValue = "";
  }

  /** The Open field's own button, which replaces the document and so has to ask first. */
  function openChosen(): void {
    const name = openNameInput.value.trim();
    if (name === "" || !confirmLeave()) return;
    void openPipeline(name, "latest");
  }

  function discardChanges(): void {
    undoStack.push(text);
    undoKey = null;
    undoButton.disabled = false;
    setText(baseline, { source: "discard" });
    announce("Changes thrown away, and the record is on screen again. Undo brings yours back.");
  }

  /**
   * The one place a failed open is shown (#32): beside the field that caused it, and replaced by the
   * next attempt rather than added to the pile.
   */
  function showOpenError(error: { code?: string; message?: string } | null): void {
    if (error === null) {
      openError.hidden = true;
      openError.textContent = "";
      return;
    }
    openError.hidden = false;
    openError.textContent = `${error.code ?? "internal_error"}: ${error.message ?? "the server answered with no message."}`;
  }

  // ---------- the library, which is the API's ----------

  /**
   * Every block this document names, fetched once, so a step's contract is its own file's header.
   *
   * What to ask for is read out of `uses`, never out of `step.version`: `analyze` only fills a version
   * in once the library has answered, so waiting on it here would wait for the thing being fetched.
   * A path reference (`./count-words.sh`) carries no version, and the API runs blocks from the
   * library, so it asks for the newest one — which is the version `analyze` draws its contract from.
   */
  async function ensureLibrary(): Promise<void> {
    if (!analysis.ok) return;
    const wanted = new Set<string>();
    for (const step of analysis.steps) {
      const ref = step.uses === null ? null : readUses(step.uses);
      if (ref === null) continue;
      const key = `${ref.name}@${ref.version ?? ""}`;
      if (!fetched.has(key)) wanted.add(key);
    }
    if (wanted.size === 0) return;
    for (const key of wanted) {
      fetched.add(key);
      const [name, versionText] = key.split("@") as [string, string];
      try {
        const list = await api.blocks(name);
        const version = versionText === "" ? list.latest : Number(versionText);
        if (gone()) return;
        const entry = library[name] ?? { name, versions: [] };
        if (!entry.versions.some((known) => known.version === version)) {
          const content = await api.blockContent(name, version);
          if (gone()) return;
          entry.versions = [...entry.versions, { version, source: content.text }].toSorted((a, b) => a.version - b.version);
        }
        library = { ...library, [name]: entry };
      } catch (error) {
        if (gone()) return;
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
    if (gone()) return;
    try {
      render("library");
    } catch (error) {
      // Repainting is this screen's own work, and a rejected promise nobody awaits is not a message.
      view.prepend(errorBox({ code: "internal_error", message: error instanceof Error ? error.message : String(error) }));
    }
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

  /**
   * The editor for a typed `with` value, in the type the block input declares. Text that is not a
   * value of that type is not written: the message says so, and the YAML keeps the last good one.
   */
  function typedValue(step: Step, input: StepInput, fieldId: string, current: Json): HTMLElement {
    const id = `${fieldId}-value`;
    const write = (value: Json, key: string | null): void => edit(editStep(text, step.id, `with.${input.name}`, value), key);
    const label = el("label", { class: "sr", for: id }, `Value of ${input.name}`);

    if (input.type === "boolean") {
      const box = el("input", { id, type: "checkbox", disabled: readOnly() });
      box.checked = current === true;
      box.addEventListener("change", () => {
        focusAfter = id;
        write(box.checked, null);
      });
      return el("div", {}, label, el("label", { class: "check" }, box, el("span", {}, current === true ? "true" : "false")));
    }

    const message = el("p", { class: "form-error", role: "alert", hidden: true });
    const refuse = (why: string): void => {
      message.hidden = false;
      message.textContent = `${why} The YAML keeps its last value.`;
    };
    const shown = input.type === "json" ? JSON.stringify(current) : current === null ? "" : String(current);
    const field = el("input", {
      id,
      type: "text",
      spellcheck: "false",
      disabled: readOnly(),
      value: shown,
      oninput: (event) => {
        const raw = (event.target as HTMLInputElement).value;
        message.hidden = true;
        if (input.type !== "integer" && input.type !== "number" && input.type !== "json") return write(raw, `text:${fieldId}`);
        const reading = parseTyped(input.type, input.name, raw);
        if (!reading.ok) return refuse(reading.message);
        if (reading.value !== undefined && !writable(reading.value)) {
          return refuse(`${input.name} is ${Array.isArray(reading.value) ? "a list" : "an object"} the graph cannot write safely: edit it in the YAML pane.`);
        }
        write(reading.value as Json, `text:${fieldId}`);
      },
    });
    return el("div", {}, label, field, message);
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
            const start = input.required || !writable(input.default) ? blankOf(input.type) : input.default;
            edit(editStep(text, step.id, `with.${input.name}`, typed ? source.value : start), null);
          } else edit(editStep(text, step.id, `with.${input.name}`, value), null);
        },
      },
      el("option", { value: "__unset" }, input.default !== null ? `Block default (${input.default})` : "Not set"),
      // A file cannot be written in YAML (SPEC 1.2), so there is nothing to type for one.
      input.type === "file" && !typed ? null : el("option", { value: "__typed" }, "Typed value"),
      options.map((option) => el("option", { value: option.value }, option.label)),
      known ? null : el("option", { value: String(source.value) }, String(source.value)),
    );
    choice.value = current;
    return el(
      "div",
      { class: "wire-row" },
      el("div", { class: "wire-row__name" }, input.name, el("small", {}, `${input.type}${input.required ? ", required" : ""}`)),
      el("div", { class: typed ? "" : "wide" }, choice),
      typed ? typedValue(step, input, fieldId, source.value) : null,
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
            onInput: (value) => edit(editStep(text, step.id, "timeout", value === "" ? undefined : value), "text:timeout"),
          }),
          textField({
            id: "f-attempts",
            label: "Max attempts",
            value: step.maxAttempts === null ? null : String(step.maxAttempts),
            type: "number",
            placeholder: "1",
            onInput: (value) => edit(editStep(text, step.id, "retry.max_attempts", value === "" ? undefined : INTEGER.test(value) ? Number(value) : value), "text:attempts"),
          }),
          textField({
            id: "f-delay",
            label: "Delay between attempts",
            value: step.delay === null ? null : String(step.delay),
            placeholder: "1s",
            onInput: (value) => edit(editStep(text, step.id, "retry.delay", value === "" ? undefined : value), "text:delay"),
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
    showOpenError(null);
    status.textContent = `Opening ${name}.`;
    try {
      const list = await api.pipelines(name);
      if (gone()) return;
      const wanted = version === "latest" ? list.latest : version;
      const record = await api.pipelineVersion(name, wanted);
      if (gone()) return;
      openName = name;
      openVersion = wanted;
      versions = list.versions.map((entry) => ({ version: entry.version, created_at: entry.created_at }));
      issues = [];
      validated = false;
      baseline = record.yaml;
      openNameInput.value = name;
      versionSelect.hidden = false;
      versionSelect.replaceChildren(
        ...versions.toReversed().map((entry) => el("option", { value: String(entry.version) }, `v${entry.version}, ${entry.created_at.slice(0, 16)}`)),
      );
      versionSelect.value = String(wanted);
      setText(record.yaml, { source: "load" });
      restoreDraft();
      announce(`${name} version ${wanted} opened.`);
    } catch (error) {
      if (gone()) return;
      versionSelect.hidden = true;
      showOpenError(error instanceof ApiError ? error : { code: "internal_error", message: String(error) });
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
      if (gone()) return;
      issues = report.issues.map((issue) => ({ issue, line: lineOfPath(issue.path ?? "") }));
      validated = true;
      render("validate");
      status.textContent = report.valid ? "The API says this document is valid." : `The API found ${report.issues.length} ${report.issues.length === 1 ? "issue" : "issues"}.`;
      announce(report.valid ? "Valid." : `The API found ${report.issues.length} problems.`);
    } catch (error) {
      if (gone()) return;
      status.textContent = error instanceof ApiError ? `${error.code}: ${error.message}` : String(error);
    } finally {
      busy = false;
      if (!gone()) render("validate");
    }
  }

  async function save(): Promise<void> {
    if (!analysis.ok) return;
    const name = analysis.name;
    if (name === "") return;
    busy = true;
    saveButton.disabled = true;
    status.textContent = `Storing ${name}.`;
    // Typing goes on while the request is out, and only what was sent is on the record.
    const sent = text;
    // The draft is filed under the version that was open when it was written; storing moves that.
    const wasKey = draftKey();
    try {
      const record = await api.savePipeline(name, sent);
      if (gone()) return;
      openName = name;
      openVersion = record.version;
      baseline = sent;
      const list = await api.pipelines(name);
      if (gone()) return;
      versions = list.versions.map((entry) => ({ version: entry.version, created_at: entry.created_at }));
      versionSelect.hidden = false;
      versionSelect.replaceChildren(
        ...versions.toReversed().map((entry) => el("option", { value: String(entry.version) }, `v${entry.version}, ${entry.created_at.slice(0, 16)}`)),
      );
      versionSelect.value = String(record.version);
      openNameInput.value = name;
      sessionStorage.removeItem(wasKey);
      keepDraft();
      status.textContent = `Stored as v${record.version}.`;
      announce(`${name} stored as version ${record.version}.`);
      navigate(`/pipeline/${name}/${record.version}`, { replace: true });
    } catch (error) {
      if (gone()) return;
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
      if (!gone()) render("save");
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
    // The first block in the library is the one on offer, said out loud rather than left to whatever
    // the browser picks for a select it has just filled.
    usesSelect.value = names[0]!;
    const idInput = el("input", { id: "add-id", type: "text", spellcheck: "false", autocomplete: "off" });
    const error = el("p", { class: "form-error", role: "alert", hidden: true });
    const suggest = (): void => {
      if (!analysis.ok) return;
      // A block name is `a-z0-9-` and a step id is `a-z0-9_` (SPEC 1.1), so the name has to be
      // translated rather than copied: suggesting `check-corpus` would offer an id the rule refuses.
      const base = usesSelect.value.replace(/-/g, "_").slice(0, 64);
      let candidate = base;
      for (let n = 2; analysis.ok && analysis.byId[candidate] !== undefined; n++) candidate = `${base}_${n}`.slice(0, 64);
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
            if (!STEP_ID.test(id)) {
              error.hidden = false;
              error.textContent = "A step id starts with a lowercase letter and has only lowercase letters, numbers and _. A hyphen belongs to a block name, not a step.";
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
    const fields = analysis.inputs.map((input) => ({ input, ...startField(input) }));
    startDialog.replaceChildren(
      el(
        "form",
        {
          class: "dialog__body",
          onsubmit: (event) => {
            event.preventDefault();
            if (!analysis.ok) return;
            error.hidden = true;
            const inputs: Record<string, unknown> = {};
            for (const field of fields) {
              const reading = field.read();
              if (!reading.ok) {
                error.hidden = false;
                error.textContent = reading.message;
                field.control.focus();
                return;
              }
              if (reading.value !== undefined) inputs[field.input.name] = reading.value;
            }
            void startRun(inputs);
          },
        },
        el("h2", { class: "dialog__title", id: "start-title" }, `Start ${analysis.name}`),
        fields.length > 0 ? fields.map((field) => field.node) : el("p", {}, "This pipeline takes no inputs."),
        el(
          "p",
          { class: "help" },
          runsStored()
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
      const body = openName !== null && unchanged() ? { pipeline: openName, version: openVersion === "latest" ? undefined : openVersion, inputs } : { yaml: text, inputs };
      const run = await api.startRun(body);
      if (gone()) return;
      announce(`Run ${run.id} started.`);
      navigate(`/runs/${run.id}`);
    } catch (error) {
      if (gone()) return;
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
  const version = routeVersion(route.parts[2]);
  if (name === undefined) {
    setText(BLANK, { source: "init" });
    restoreDraft();
  } else if (version === null) {
    // `/pipeline/word-report/abc` is not version NaN (#35): there is no such version, and that is
    // said here instead of asking the API for a number the route never gave.
    setText(BLANK, { source: "init" });
    openNameInput.value = name;
    showOpenError({
      code: "type_mismatch",
      message: `${name} has no version "${route.parts[2] ?? ""}". Versions are whole numbers, starting at 1.`,
    });
    status.textContent = `Nothing opened for ${name}.`;
  } else {
    void openPipeline(name, version);
  }
  flashed = analysis.ok ? Object.fromEntries(analysis.steps.map((step) => [step.id, JSON.stringify(step.raw)])) : {};
}
