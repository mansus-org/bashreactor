// The pipeline editor. The one piece of state that matters is `text`, the YAML. Typing changes it
// directly; every control on the graph side computes a new text through model.ts. Everything on
// screen is drawn from analysing that text, so there is no second copy to keep in step.
//
// The API is what this edits against: the block contracts come from the library, the document is
// opened and stored as versions, `Validate` is the server's own report, and `Start a run` is a POST.

import { api, ApiError, canWrite } from "./api.js";
import type { LibraryName, ValidationIssue } from "./api.js";
import { announce, el, errorBox, isoInstant, when } from "./dom.js";
import { button, statusStamp, typeStamp } from "./ui.js";
import { INTEGER, blankOf, openStartRun, parseTyped, writable } from "./start-run.js";
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

/**
 * One version in the picker: its number and when it was stored, in the zone the person reading it is
 * in, to the second. Two saves either side of a fix are a breath apart, and a picker that shows
 * minutes cannot say which is which. A time with no zone in it is only ever the reader's own, so the
 * exact instant goes beside it: in the title, and again in the label, because no browser shows a
 * tooltip on an `<option>`.
 */
function versionOption(entry: { version: number; created_at: string }): HTMLElement {
  const stored = isoInstant(entry.created_at);
  const printed = when(entry.created_at);
  // A time this build cannot read is left out of the label rather than echoed into it: the version number
  // still tells people which is which, and "v3, " with nothing after it reads as a broken control.
  const label = printed === "" ? `v${entry.version}` : `v${entry.version}, ${printed}`;
  const exact = stored === "" ? {} : { title: `stored ${stored}`, "aria-label": `${label}, stored ${stored}` };
  return el("option", { value: String(entry.version), ...exact }, label);
}

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


export function renderPipeline(view: HTMLElement, route: Route, signal: AbortSignal): void {
  let text = BLANK;
  let analysis: Read = analyze(BLANK, {});
  let lastGood: Analysis | null = null;
  let selected: string | null = null;
  let library: Library = {};
  // Every name the library holds, from `GET /v1/blocks`, newest version each. Names only: a step's
  // contract still comes from the source `ensureLibrary` fetches, so this is the list of what is on
  // offer, which is not the same as what has been read.
  let listed: LibraryName[] = [];
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
    announce("The unsaved edits this tab had are back on screen.");
  }

  // ---------- skeleton ----------

  // The breadcrumb is the only header above the toolbar, and the toolbar is this screen's header:
  // there is no Anybody title on an editing screen. `pageHeader` always draws one, so the crumb line
  // is built here from the same classes it uses.
  const crumbs = el("nav", { class: "crumbs", "aria-label": "Breadcrumb" });
  const toolbarName = el("h1", { class: "editor__name" });
  const fromStamp = typeStamp("");
  const unsavedStamp = statusStamp("unsaved");
  const status = el("p", { class: "sr", role: "status" });
  const notice = el("div", { class: "editor__notice" });
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
      navigate(`/pipelines/${encodeURIComponent(openName)}/edit?version=${encodeURIComponent(value)}`, { replace: true });
    },
  });
  const actionHost = el("div", { class: "editor__buttons" });
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
  const inspector = el("section", { class: "inspector editor__inspector", id: "inspector", "aria-labelledby": "inspector-title" });

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
  // a link clicked here or in the sidebar, and the tab going away. Back and forwards are the
  // router's to guard. Both listeners go away with the screen, because they are registered with its
  // own signal.
  document.addEventListener("click", leaveAttempt, { capture: true, signal });
  window.addEventListener("beforeunload", unload, { signal });

  view.replaceChildren(
    el(
      "div",
      { class: "editor" },
      crumbs,
      el(
        "div",
        { class: "editor__toolbar" },
        el("div", { class: "editor__id" }, toolbarName, fromStamp, unsavedStamp),
        el("div", { class: "editor__actions" }, el("div", { class: "editor__version" }, versionSelect), actionHost),
      ),
      notice,
      el(
        "div",
        { class: "editor__panes" },
        el(
          "div",
          { class: "editor__left" },
          el(
            "section",
            { class: "editor__yaml", "aria-labelledby": "yaml-title" },
            el("div", { class: "bar" }, el("h2", { class: "h2", id: "yaml-title" }, "YAML")),
            el("label", { class: "sr", for: "doc" }, "Pipeline YAML"),
            el("p", { class: "sr", id: "yaml-help" }, "Moving the caret into a step selects it in the graph. Tab leaves this field."),
            el("div", { class: "yaml" }, gutter, el("div", { class: "yaml__code" }, paint, textarea)),
          ),
          el(
            "section",
            { class: "problems editor__problems", id: "problems", "aria-labelledby": "problems-title", tabindex: "-1" },
            el("h3", { class: "h3", id: "problems-title" }, "Problems"),
            problemsNote,
            problemsList,
          ),
        ),
        el(
          "div",
          { class: "editor__right" },
          el(
            "section",
            { class: "editor__graph", "aria-labelledby": "graph-title" },
            el(
              "div",
              { class: "bar" },
              el("h2", { class: "h2", id: "graph-title" }, "Graph"),
              el("div", { class: "row" }, undoButton, discardButton, pinButton, addButton),
            ),
            stageNote,
            stage,
            el(
              "p",
              { class: "legend" },
              el("span", {}, el("span", { class: "sw sw--wired" }), "wired"),
              el("span", {}, el("span", { class: "sw sw--value" }), "value"),
              el("span", {}, el("span", { class: "sw sw--data" }), "data"),
              el("span", {}, el("span", { class: "sw sw--needs" }), "order"),
            ),
          ),
          inspector,
        ),
      ),
      status,
      startDialog,
      addDialog,
    ),
  );

  /** The route's name, kept apart from `openName` because a failed open still names its pipeline. */
  let routeName: string | null = null;

  function paintCrumbs(): void {
    const name = openName ?? routeName;
    const entries: { label: string; href?: string; mono?: boolean }[] =
      name === null
        ? [{ label: "Pipelines", href: "/app/pipelines" }, { label: "New" }]
        : [
            { label: "Pipelines", href: "/app/pipelines" },
            { label: name, href: `/app/pipelines/${encodeURIComponent(name)}` },
            { label: "Edit" },
          ];
    crumbs.replaceChildren(
      ...entries.flatMap((entry, index) => {
        const current = index === entries.length - 1;
        const node =
          current || entry.href === undefined
            ? el("span", { class: `crumbs__current${entry.mono === true ? " mono" : ""}` }, entry.label)
            : el("a", { class: entry.mono === true ? "mono" : "", href: entry.href, "data-link": "" }, entry.label);
        return index === 0 ? [node] : [" / ", node];
      }),
    );
  }

  /** The toolbar: the name, what it came from, whether it is unsaved, and the version picker. */
  function paintToolbar(shown: Analysis | null): void {
    const stored = openName ?? routeName;
    toolbarName.textContent = stored ?? (shown === null || shown.name === "" ? "New pipeline" : shown.name);
    const at = openVersion === "latest" ? versions[0]?.version : openVersion;
    fromStamp.hidden = openName === null || at === undefined;
    fromStamp.textContent = at === undefined ? "" : `from v${at}`;
    unsavedStamp.hidden = unchanged();
    versionSelect.hidden = openName === null;
  }

  // `button`'s `disabledReason` is built with the button, so the three actions are rebuilt when that
  // reason changes rather than left to a second, hand-made off state. Focus follows the label, so a
  // request finishing does not drop the reader off the control they pressed.
  let actionsKey = "";
  function paintActions(): void {
    const local = analysis.problems.length;
    const remote = issues.length;
    const blocked = !analysis.ok || local + remote > 0 || (analysis.ok && analysis.steps.length === 0);
    const reason = !blocked
      ? ""
      : readOnly()
        ? "This token can read only."
        : !analysis.ok
          ? "Fix the YAML to save or run."
          : local + remote > 0
            ? `Fix ${local + remote} ${local + remote === 1 ? "problem" : "problems"} to save or run.`
            : "Add a step to save or run.";
    const key = `${blocked}|${busy}|${reason}`;
    if (key === actionsKey) return;
    actionsKey = key;
    const focused = document.activeElement?.textContent ?? null;
    actionHost.replaceChildren(
      button("Validate", { disabled: busy, onClick: () => void validate() }),
      button("Save version", { disabled: blocked || readOnly(), onClick: () => void save() }),
      button("Run", {
        primary: true,
        disabled: blocked || readOnly(),
        disabledReason: reason === "" ? undefined : reason,
        onClick: startPipeline,
      }),
    );
    if (focused !== null) {
      [...actionHost.querySelectorAll("button")].find((node) => node.textContent === focused)?.focus();
    }
  }

  /** The one place a refused open is shown: the server's code and its own words. */
  function showError(error: { code?: string; message?: string } | null): void {
    notice.replaceChildren(...(error === null ? [] : [errorBox(error)]));
  }

  // ---------- text is the state ----------

  function setText(next: string, options: { source?: string; select?: string | null } = {}): void {
    const { source = "yaml", select: nextSelect } = options;
    if (next !== text) {
      // The API's report is about the bytes it was given (#21). Once they have changed it proves
      // nothing about what is on screen, so it stops being a problem the reader has to clear.
      issues = [];
      validated = false;
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

    document.title = `${shown === null || shown.name === "" ? (openName ?? routeName ?? "New pipeline") : shown.name} — Bashreactor`;
    paintCrumbs();
    paintToolbar(shown);
    paintActions();

    stageNote.hidden = !stale;
    if (!analysis.ok) stageNote.textContent = `Line ${analysis.error.line} does not parse.`;
    if (shown !== null) graph.update({ analysis: shown, selected, stale });

    addButton.disabled = readOnly() || !analysis.ok;

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

  function discardChanges(): void {
    undoStack.push(text);
    undoKey = null;
    undoButton.disabled = false;
    setText(baseline, { source: "discard" });
    announce("Changes thrown away, and the record is on screen again. Undo brings yours back.");
  }

  // ---------- the library, which is the API's ----------

  /**
   * Every block a step can be pointed at, newest version each: the whole library by name, plus any
   * version this document already names that the list has not (yet) reported.
   *
   * Before `GET /v1/blocks` there was nothing to ask, so this could only offer the blocks the
   * document already named — which is empty on a new pipeline, and the reason Add step used to
   * answer "publish a block first" at a library full of them.
   */
  function offers(): { name: string; uses: string }[] {
    const newest = new Map(listed.map((block) => [block.name, block.latest]));
    for (const [name, entry] of Object.entries(library)) {
      const version = entry.versions.length === 0 ? undefined : latest(entry).version;
      if (version !== undefined && version > (newest.get(name) ?? 0)) newest.set(name, version);
    }
    return [...newest.entries()]
      .toSorted(([first], [second]) => (first < second ? -1 : 1))
      .map(([name, version]) => ({ name, uses: libraryRef(name, version) }));
  }

  /** The library's own names, asked for once: what a step can point at. It is not worth making the
   * document on screen wait for — a list that will not answer leaves the names this document already
   * names, which is what there was before there was a list route at all.
   */
  async function loadNames(): Promise<void> {
    try {
      const blocks = await api.allBlocks();
      if (gone()) return;
      listed = blocks.blocks;
    } catch {
      // A list that will not answer leaves the document's own names, which are on screen already.
    }
    if (gone()) return;
    render("names");
  }

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
        showError(error instanceof ApiError ? { code: error.code, message: error.message } : { code: "internal_error", message: String(error) });
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

  let inspectorOpen = false;

  /**
   * The inspector's frame: a header that stays, and a body the reader opens. The graph owns the rest
   * of the column, which is what makes it readable at a laptop's height.
   */
  function inspectorFrame(title: string, actions: Child[], body: Child[], foldable = false): void {
    const bodyNode = el("div", { class: "editor__inspector-body" }, body);
    bodyNode.hidden = foldable && !inspectorOpen;
    let toggle: HTMLElement | null = null;
    if (foldable) {
      toggle = button(inspectorOpen ? "Collapse" : "Expand", {
        ariaLabel: inspectorOpen ? "Collapse the step inspector" : "Expand the step inspector",
        onClick: () => {
          inspectorOpen = !inspectorOpen;
          bodyNode.hidden = !inspectorOpen;
          toggle!.textContent = inspectorOpen ? "Collapse" : "Expand";
          toggle!.setAttribute("aria-expanded", String(inspectorOpen));
        },
      });
      toggle.setAttribute("aria-expanded", String(inspectorOpen));
    }
    inspector.replaceChildren(
      el(
        "div",
        { class: "bar" },
        el("h2", { class: "h2", id: "inspector-title" }, title),
        el("div", { class: "row" }, ...actions, toggle),
      ),
      bodyNode,
    );
  }

  function renderInspector(): void {
    if (!analysis.ok) {
      inspectorFrame("Step", [], [
        el("p", { class: "help" }, `Fix line ${analysis.error.line} in the YAML to edit steps here again.`),
      ]);
      return;
    }
    const step = selected !== null ? (analysis.byId[selected] ?? null) : null;
    if (step === null) {
      inspectorFrame("Step", [], [
        el("p", { class: "help" }, "Add a step and its block, timeout, retries and wiring can be edited here."),
      ]);
      return;
    }

    const active = inspector.contains(document.activeElement) ? document.activeElement?.id ?? null : null;
    const usesOptions = offers().map((offer) => offer.uses);
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

    inspectorFrame(
      step.id,
      [
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
      ],
      [
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
      ],
      true,
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
    problemsNote.textContent = all.length === 0 ? "None." : validated ? "Checked by the API." : "";
    problemsNote.hidden = problemsNote.textContent === "";
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
    showError(null);
    announce(`Opening ${name}.`);
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
      versionSelect.hidden = false;
      versionSelect.replaceChildren(...versions.toReversed().map(versionOption));
      versionSelect.value = String(wanted);
      setText(record.yaml, { source: "load" });
      announce(`${name} version ${wanted} opened.`);
      restoreDraft();
    } catch (error) {
      if (gone()) return;
      versionSelect.hidden = true;
      showError(error instanceof ApiError ? { code: error.code, message: error.message } : { code: "internal_error", message: String(error) });
      status.textContent = "";
    } finally {
      busy = false;
      if (!gone()) paintActions();
    }
  }

  async function validate(): Promise<void> {
    busy = true;
    paintActions();
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
      showError(error instanceof ApiError ? { code: error.code, message: error.message } : { code: "internal_error", message: String(error) });
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
    paintActions();
    showError(null);
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
      versionSelect.replaceChildren(...versions.toReversed().map(versionOption));
      versionSelect.value = String(record.version);
      sessionStorage.removeItem(wasKey);
      keepDraft();
      status.textContent = `Stored as v${record.version}.`;
      announce(`${name} stored as version ${record.version}.`);
      navigate(`/pipelines/${encodeURIComponent(name)}/edit?version=${encodeURIComponent(String(record.version))}`, { replace: true });
    } catch (error) {
      if (gone()) return;
      // A pipeline that does not validate is a 422 with its first issue, which is the same object the
      // problems pane lists: show it where it belongs rather than in a banner that says "failed".
      if (error instanceof ApiError && error.status === 422) {
        issues = [{ issue: { code: error.code, message: error.message, path: error.path }, line: lineOfPath(error.path ?? "") }];
        render("save");
        status.textContent = "The API refused to store this. Its issue is in the list.";
      } else {
        showError(error instanceof ApiError ? { code: error.code, message: error.message } : { code: "internal_error", message: String(error) });
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
    const onOffer = offers();
    if (onOffer.length === 0) {
      announce("There is no block in the library yet. Publish one on the Blocks screen first.");
      return;
    }
    const usesSelect = el(
      "select",
      { id: "add-uses" },
      onOffer.map((offer) => el("option", { value: offer.uses }, offer.uses)),
    );
    // The first block in the library is the one on offer, said out loud rather than left to whatever
    // the browser picks for a select it has just filled.
    usesSelect.value = onOffer[0]!.uses;
    const idInput = el("input", { id: "add-id", type: "text", spellcheck: "false", autocomplete: "off" });
    const error = el("p", { class: "form-error", role: "alert", hidden: true });
    const suggest = (): void => {
      if (!analysis.ok) return;
      // A block name is `a-z0-9-` and a step id is `a-z0-9_` (SPEC 1.1), so the name has to be
      // translated rather than copied: suggesting `check-corpus` would offer an id the rule refuses.
      const base = (readUses(usesSelect.value)?.name ?? "").replace(/-/g, "_").slice(0, 64);
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
            const next = addStep(text, model, id, { uses: usesSelect.value });
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

  function startPipeline(): void {
    if (!analysis.ok) return;
    openStartRun(startDialog, {
      name: analysis.name,
      inputs: analysis.inputs,
      help: runsStored()
        ? "This starts the stored version you have open, so what runs is what is on the record."
        : "These are unsaved changes: the run takes the YAML as it stands here, and nothing is stored.",
      body: (inputs) =>
        openName !== null && unchanged()
          ? { pipeline: openName, version: openVersion === "latest" ? undefined : openVersion, inputs }
          : { yaml: text, inputs },
      started: (run) => {
        if (gone()) return;
        announce(`Run ${run.id} started.`);
        navigate(`/runs/${run.id}`);
      },
      sending: (sending) => {
        busy = sending;
        paintActions();
        if (sending) status.textContent = "Starting the run.";
      },
    });
  }

  // ---------- start ----------

  textarea.value = text;
  void loadNames();
  // Two addresses reach this screen now: `/pipelines-new` and `/pipelines/:name/edit?version=n`. The
  // old `/pipeline` shapes still work when a test calls this function directly, but the router
  // rewrites them before they get here.
  const editing = route.parts[0] === "pipelines" && route.parts[2] === "edit";
  const name = route.parts[0] === "pipelines-new" ? undefined : editing ? route.parts[1] : route.parts[1];
  const versionText = editing ? (route.query.get("version") ?? undefined) : route.parts[2];
  const version = routeVersion(versionText);
  routeName = name ?? null;
  if (name === undefined) {
    setText(BLANK, { source: "init" });
    restoreDraft();
  } else if (version === null) {
    // `/pipelines/word-report/edit?version=abc` is not version NaN (#35): there is no such version,
    // and that is said here instead of asking the API for a number the route never gave.
    setText(BLANK, { source: "init" });
    showError({
      code: "type_mismatch",
      message: `${name} has no version "${versionText ?? ""}". Versions are whole numbers, starting at 1.`,
    });
    status.textContent = `Nothing opened for ${name}.`;
  } else {
    void openPipeline(name, version);
  }
  flashed = analysis.ok ? Object.fromEntries(analysis.steps.map((step) => [step.id, JSON.stringify(step.raw)])) : {};
}
