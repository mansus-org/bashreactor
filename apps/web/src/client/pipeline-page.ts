// One pipeline: its header, its version picker, and the four things you can look at — the runs, the
// definition, the stored versions and the contract. The runs tab is live; the other three are read
// when they are opened.

import { api, ApiError, canWrite } from "./api.js";
import type { PipelineList, PipelineVersion, RunPage, RunSummary } from "./api.js";
import { el, errorBox, insertNode, stateLine } from "./dom.js";
import type { Route } from "./app.js";
import { navigate } from "./app.js";
import { createGraph } from "./graph.js";
import { fetchLibrary } from "./library.js";
import { analyze, readUses } from "./model.js";
import type { Analysis, Decl, PipelineOutput, Read } from "./model.js";
import { IDLE_POLL_MS, POLL_MS, errorBody, errorWords, wallClock, whenShown } from "./run-shared.js";
import type { Clock } from "./run-shared.js";
import { openStartRun } from "./start-run.js";
import type { StartRunInput } from "./start-run.js";
import {
  barChart,
  button,
  codeView,
  exactTime,
  formatDuration,
  linkButton,
  pageHeader,
  readTab,
  relativeTime,
  runsTable,
  table,
  tabs,
  typeStamp,
  writeTab,
} from "./ui.js";
import type { Bar, TableColumn } from "./ui.js";

const TABS = ["runs", "definition", "versions", "inputs"] as const;
type TabId = (typeof TABS)[number];

interface ParsedInput {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default: unknown;
}

interface ParsedOutput {
  name: string;
  value: string;
}

interface ParsedContract {
  description: string;
  inputs: ParsedInput[];
  outputs: ParsedOutput[];
}

/** Read the API's parsed pipeline, if this build can read it, without trusting its shape. */
function parsedContract(parsed: unknown): ParsedContract | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const document = parsed as { description?: unknown; inputs?: unknown; outputs?: unknown };
  if (!Array.isArray(document.inputs) || !Array.isArray(document.outputs)) return null;
  const inputs: ParsedInput[] = [];
  for (const raw of document.inputs) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const input = raw as { name?: unknown; type?: unknown; description?: unknown; default?: unknown };
    if (typeof input.name !== "string") return null;
    inputs.push({
      name: input.name,
      type: typeof input.type === "string" ? input.type : "string",
      description: typeof input.description === "string" ? input.description : "",
      required: !Object.prototype.hasOwnProperty.call(input, "default"),
      default: input.default,
    });
  }
  const outputs: ParsedOutput[] = [];
  for (const raw of document.outputs) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const output = raw as { name?: unknown; ref?: unknown };
    if (typeof output.name !== "string" || output.ref === null || typeof output.ref !== "object") return null;
    const ref = output.ref as { kind?: unknown; step?: unknown; output?: unknown };
    if (ref.kind !== "step_output" || typeof ref.step !== "string" || typeof ref.output !== "string") return null;
    outputs.push({ name: output.name, value: `\${{ steps.${ref.step}.outputs.${ref.output} }}` });
  }
  return {
    description: typeof document.description === "string" ? document.description.trim() : "",
    inputs,
    outputs,
  };
}

/** The contract from `analyze`, for a version whose parsed form this build cannot read. */
function analyzedContract(analysis: Read): ParsedContract {
  if (!analysis.ok) return { description: "", inputs: [], outputs: [] };
  const inputs = analysis.inputs.map((input: Decl) => ({
    name: input.name,
    type: input.type,
    description: input.description,
    required: input.required,
    default: input.default,
  }));
  const outputs = analysis.outputs.map((output: PipelineOutput) => ({ name: output.name, value: output.value }));
  return { description: analysis.description, inputs, outputs };
}

function contractOf(version: PipelineVersion): ParsedContract {
  return parsedContract(version.parsed) ?? analyzedContract(analyze(version.yaml, {}));
}

/** The inputs the Start dialog needs, in the shape start-run.ts reads. */
function startInputs(version: PipelineVersion): StartRunInput[] {
  return contractOf(version).inputs.map((input) => ({
    name: input.name,
    type: input.type,
    default: (input.default ?? null) as StartRunInput["default"],
    description: input.description,
    required: input.required,
  }));
}

function defaultText(value: unknown): string {
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

function storedTime(iso: string): HTMLElement {
  const exact = exactTime(iso);
  return el("time", exact === "" ? {} : { datetime: iso, title: exact }, relativeTime(iso));
}

function versionOptions(list: PipelineList, selected: number): HTMLOptionElement[] {
  return [...list.versions]
    .toSorted((a, b) => b.version - a.version)
    .map((entry) =>
      el(
        "option",
        {
          value: String(entry.version),
          selected: entry.version === selected,
        },
        entry.version === list.latest ? `v${entry.version} (latest)` : `v${entry.version}`,
      ),
    );
}

export async function renderPipelinePage(
  view: HTMLElement,
  route: Route,
  signal: AbortSignal,
  clock: Clock = wallClock,
): Promise<void> {
  const name = route.parts[1] ?? "";
  view.replaceChildren(stateLine(`Loading ${name}.`));

  let list: PipelineList;
  try {
    list = await api.pipelines(name);
  } catch (error) {
    if (signal.aborted) return;
    view.replaceChildren(notFound(error, "All pipelines"));
    return;
  }
  if (signal.aborted) return;

  const wanted = route.query.get("version");
  let resolved: number | "latest" = "latest";
  if (wanted !== null && wanted !== "latest") {
    if (!/^[1-9][0-9]*$/.test(wanted)) {
      view.replaceChildren(
        errorBox(
          {
            code: "type_mismatch",
            message: `"${wanted}" is not a version of ${name}. Versions are whole numbers, starting at 1.`,
          },
          linkButton("All pipelines", "/app/pipelines"),
        ),
      );
      return;
    }
    resolved = Number(wanted);
  }

  let version: PipelineVersion;
  try {
    version = await api.pipelineVersion(name, resolved);
  } catch (error) {
    if (signal.aborted) return;
    view.replaceChildren(notFound(error, "All pipelines"));
    return;
  }
  if (signal.aborted) return;

  const contract = contractOf(version);
  const initialTab = (TABS as readonly string[]).includes(readTab("runs")) ? (readTab("runs") as TabId) : "runs";
  let activeTab: TabId = initialTab;

  const versionSelect = el(
    "select",
    {
      id: "pipeline-version",
      class: "pipeline-version-select",
      "aria-label": "Version",
      onchange: () => {
        const next = new URLSearchParams();
        next.set("version", versionSelect.value);
        next.set("tab", activeTab);
        navigate(`/pipelines/${encodeURIComponent(name)}?${next.toString()}`, { replace: true });
      },
    },
    versionOptions(list, version.version),
  );

  const dialog = el("dialog", { class: "dialog", "aria-labelledby": "start-title" });
  const actions: HTMLElement[] = [versionSelect];
  if (canWrite()) {
    actions.push(
      button("Run", {
        primary: true,
        onClick: () => {
          openStartRun(dialog, {
            name,
            inputs: startInputs(version),
            help: `This starts ${name} v${version.version}, the version this page is showing.`,
            body: (values) => ({ pipeline: name, version: version.version, inputs: values }),
            started: (run) => {
              if (signal.aborted) return;
              navigate(`/runs/${run.id}`);
            },
          });
        },
      }),
      linkButton("Edit", `/app/pipelines/${encodeURIComponent(name)}/edit?version=${version.version}`),
    );
  }

  const header = pageHeader({
    crumbs: [{ label: "Pipelines", href: "/app/pipelines" }, { label: name, mono: true }],
    title: name,
    actions,
    meta: [
      ["Version", `v${version.version} of ${list.versions.length}`],
      ["Stored", storedTime(version.created_at)],
      ["sha256", el("code", { class: "mono", title: version.sha256 }, version.sha256.slice(0, 12))],
    ],
  });
  if (contract.description !== "") {
    const description = el("p", { class: "lead pipeline-lead" }, contract.description);
    const reference = header.querySelector(".id-line") ?? header.querySelector(".meta-line");
    insertNode(header, description, reference);
  }

  const panels: Record<TabId, HTMLElement> = {
    runs: el("div", { class: "pipeline-runs" }),
    definition: el("div", { class: "pipeline-definition-panel" }),
    versions: el("div", { class: "pipeline-versions" }),
    inputs: el("div", { class: "pipeline-contract" }),
  };
  const built = new Set<TabId>();

  const runs = createRunsTab(panels.runs, name, signal, clock);


  function ensure(tab: TabId): void {
    if (tab === "runs") {

      runs.start();
      return;
    }
    if (!built.has(tab)) {
      built.add(tab);
      if (tab === "definition") void definition(panels.definition, version, signal);
      if (tab === "versions") versions(panels.versions, name, list, version);
      if (tab === "inputs") renderInputs(panels.inputs, contract);
    }
  }

  const tabStrip = tabs(
    [
      { id: "runs", label: "Runs", panel: panels.runs },
      { id: "definition", label: "Definition", panel: panels.definition },
      { id: "versions", label: "Versions", panel: panels.versions },
      { id: "inputs", label: "Inputs", panel: panels.inputs },
    ],
    initialTab,
    (id) => {
      activeTab = id as TabId;
      writeTab(id);
      if (id !== "runs") runs.stop();
      ensure(activeTab);
    },
  );

  view.replaceChildren(header, tabStrip, dialog);
  ensure(initialTab);
}

function notFound(error: unknown, actionLabel: string): HTMLElement {
  const body = error instanceof ApiError ? error : { code: "internal_error", message: String(error) };
  return errorBox(body, linkButton(actionLabel, "/app/pipelines"));
}

// ---------- runs ----------

function durationOf(run: RunSummary, now: number): number {
  const start = Date.parse(run.created_at);
  if (Number.isNaN(start)) return 0;
  const end = run.finished_at === null ? now : Date.parse(run.finished_at);
  return Number.isNaN(end) ? 0 : Math.max(0, end - start);
}

/**
 * A chart tick is a round number, not a sentence: a 0.5 s tick reads `0.5 s`, never `<1 s`, and a
 * long tick drops the zero it would not count. Bars keep the house duration formatter in their titles.
 */
function tickDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0";
  if (ms < 1000) {
    const seconds = ms / 1000;
    return `${Number(seconds.toFixed(seconds < 0.1 ? 3 : 2))} s`;
  }
  return formatDuration(ms).replace(/ 00 (s|m|h)$/, "");
}

function runsChart(runs: RunSummary[], now: number): HTMLElement {
  // listRuns is newest first; a chart reads left to right, so the newest bar is the rightmost one.
  const shown = runs.slice(0, 30).toReversed();
  const bars: Bar[] = shown.map((run) => {
    const duration = durationOf(run, now);
    return {
      key: run.id,
      label: run.id,
      title: `${exactTime(run.created_at)} · ${run.status} · ${formatDuration(duration)}`,
      href: `/app/runs/${run.id}`,
      segments: [{ status: run.status, value: Math.max(1, duration) }],
    };
  });
  return barChart({ bars, height: 160, yLabel: "Run duration", yFormat: tickDuration });
}

/**
 * The Runs tab: a duration chart over the last thirty runs and the runs table under it. It is the
 * same live view the Runs list is — a second while anything is running, fifteen when nothing is,
 * and nothing at all while the tab or the panel is out of sight.
 */
function createRunsTab(panel: HTMLElement, pipeline: string, signal: AbortSignal, clock: Clock) {
  const chart = el("div", { class: "pipeline-chart" });
  chart.hidden = true;
  const note = el("p", { class: "runlist__note", role: "status" }, "Loading the runs.");
  const tableHost = el("div", { class: "pipeline-runs-table" });
  tableHost.hidden = true;
  const moreButton = button("Load more", { onClick: () => void loadMore() }) as HTMLButtonElement;
  const more = el("div", { class: "pipeline-more" }, moreButton);
  more.hidden = true;
  const failure = el("div", { class: "pipeline-failure" });
  const list = runsTable({
    columns: ["status", "run", "version", "started", "duration", "steps"],
    empty: "No runs for this pipeline yet.",
  });
  tableHost.replaceChildren(list.node);
  panel.replaceChildren(chart, note, tableHost, more, failure);

  const known = new Map<string, RunSummary>();
  let next: string | null = null;
  /** Whether the person has already asked for a page after the first one. */
  let paged = false;
  let started = false;
  let active = false;
  let reading = false;
  let loadingMore = false;
  let seen = false;
  let timer: (() => void) | null = null;
  let said = "";

  function paint(): void {
    const sorted = [...known.values()].toSorted((a, b) => b.id.localeCompare(a.id));
    list.update(sorted);
    chart.hidden = sorted.length === 0;
    if (sorted.length > 0) chart.replaceChildren(runsChart(sorted, clock.now()));
    tableHost.hidden = false;
    more.hidden = next === null;
    note.hidden = true;
  }

  function tell(error: unknown): void {
    const message = error === null ? "" : errorWords(error);
    if (message === said) return;
    said = message;
    failure.replaceChildren();
    if (message === "") {
      note.hidden = true;
      return;
    }
    if (seen) {
      note.textContent = `Lost the server, still trying. ${message}`;
      note.hidden = false;
      return;
    }
    note.hidden = true;
    failure.replaceChildren(errorBox(errorBody(error)));
  }

  async function tick(): Promise<void> {
    timer?.();
    timer = null;
    if (signal.aborted || !active || document.hidden || reading) return;
    reading = true;
    let page: RunPage | null = null;
    let error: unknown = null;
    try {
      page = await api.listRuns({ pipeline, limit: 50 });
    } catch (caught) {
      error = caught;
    }
    reading = false;
    if (signal.aborted) return;
    if (page !== null) {
      seen = true;
      for (const run of page.runs) known.set(run.id, run);
      if (!paged) next = page.next;
      paint();
      tell(null);
    } else {
      tell(error);
    }
    if (signal.aborted || !active || document.hidden) return;
    const busy = page === null || [...known.values()].some((run) => run.status === "running");
    timer = clock.after(busy ? POLL_MS : IDLE_POLL_MS, () => void tick());
  }

  async function loadMore(): Promise<void> {
    if (next === null || loadingMore) return;
    const cursor = next;
    loadingMore = true;
    moreButton.disabled = true;
    try {
      const page = await api.listRuns({ pipeline, limit: 50, cursor });
      for (const run of page.runs) known.set(run.id, run);
      next = page.next;
      paged = true;
      paint();
      tell(null);
    } catch (error) {
      tell(error);
    } finally {
      loadingMore = false;
      moreButton.disabled = false;
      more.hidden = next === null;
    }
  }

  function start(): void {
    active = true;
    if (!started) {
      started = true;
      whenShown(signal, () => {
        if (active) void tick();
      });
      signal.addEventListener("abort", () => timer?.(), { once: true });
    }
    void tick();
  }

  function stop(): void {
    active = false;
    timer?.();
    timer = null;
  }

  return { start, stop };
}

// ---------- definition ----------

async function definition(panel: HTMLElement, version: PipelineVersion, signal: AbortSignal): Promise<void> {
  const yaml = el(
    "section",
    { class: "pipeline-definition__yaml", "aria-labelledby": "definition-yaml" },
    el("h2", { class: "h2", id: "definition-yaml" }, "YAML"),
    codeView(version.yaml, { lineNumbers: true }),
  );
  const graphHost = el("section", { class: "pipeline-definition__graph", "aria-labelledby": "definition-graph" });
  graphHost.append(
    el("h2", { class: "h2", id: "definition-graph" }, "Graph"),
    stateLine("Reading the blocks this pipeline names."),
  );
  panel.replaceChildren(el("div", { class: "pipeline-definition" }, yaml, graphHost));

  // The first read needs no contracts: it knows every `uses`, and the library is read for exactly
  // those block versions. The second read is the one whose graph can name its ports.
  const preliminary = analyze(version.yaml, {});
  const refs: { name: string; version: number }[] = [];
  if (preliminary.ok) {
    for (const step of preliminary.steps) {
      if (step.uses === null) continue;
      const ref = readUses(step.uses);
      if (ref !== null && ref.version !== null) refs.push({ name: ref.name, version: ref.version });
    }
  }

  let analysis: Analysis;
  try {
    const library = await fetchLibrary(refs);
    if (signal.aborted) return;
    const read = analyze(version.yaml, library);
    if (!read.ok) {
      graphHost.replaceChildren(
        el("h2", { class: "h2" }, "Graph"),
        errorBox({ code: read.error.code, message: read.error.message }),
      );
      return;
    }
    analysis = read;
  } catch (error) {
    if (signal.aborted) return;
    graphHost.replaceChildren(el("h2", { class: "h2" }, "Graph"), errorBox(errorBody(error)));
    return;
  }

  const stage = el("div", { class: "stage", "aria-label": "Pipeline graph" });
  graphHost.replaceChildren(el("h2", { class: "h2" }, "Graph"), stage);
  const graph = createGraph(stage, { onSelect: () => {} });
  graph.update({ analysis, selected: null, stale: false });
  signal.addEventListener("abort", () => graph.destroy(), { once: true });
}

// ---------- versions ----------

function versions(panel: HTMLElement, name: string, list: PipelineList, current: PipelineVersion): void {
  const columns: TableColumn<PipelineList["versions"][number]>[] = [
    {
      header: "Version",
      cell: (entry) =>
        el(
          "a",
          {
            class: "mono pipeline-version-link",
            href: `/app/pipelines/${encodeURIComponent(name)}?tab=definition&version=${entry.version}`,
            "data-link": "",
            "aria-current": entry.version === current.version ? "true" : undefined,
          },
          `v${entry.version}`,
        ),
    },
    { header: "Stored", cell: (entry) => storedTime(entry.created_at) },
    {
      header: "sha256",
      cell: (entry) => el("code", { class: "mono", title: entry.sha256 }, entry.sha256.slice(0, 12)),
    },
  ];
  if (canWrite()) {
    columns.push({
      header: "Actions",
      align: "right",
      cell: (entry) =>
        el(
          "a",
          { class: "btn btn--small", href: `/app/pipelines/${encodeURIComponent(name)}/edit?version=${entry.version}`, "data-link": "" },
          "Edit from this version",
        ),
    });
  }
  const rows = [...list.versions].toSorted((a, b) => b.version - a.version);
  panel.replaceChildren(table(columns, rows, { empty: "This pipeline has no stored versions." }));
}

// ---------- inputs and outputs ----------

function renderInputs(panel: HTMLElement, contract: ParsedContract): void {
  const inputTable = table<ParsedInput>(
    [
      { header: "Name", cell: (input) => el("span", { class: "mono" }, input.name) },
      { header: "Type", cell: (input) => typeStamp(input.type) },
      {
        header: "If not set",
        cell: (input) =>
          input.required ? el("span", { class: "pipeline-required" }, "required") : el("code", { class: "mono" }, defaultText(input.default)),
      },
      { header: "Description", cell: (input) => input.description },
    ],
    contract.inputs,
    { empty: "This pipeline takes no inputs." },
  );
  const outputTable = table<ParsedOutput>(
    [
      { header: "Name", cell: (output) => el("span", { class: "mono" }, output.name) },
      { header: "Expression", cell: (output) => el("code", { class: "mono" }, output.value) },
    ],
    contract.outputs,
    { empty: "This pipeline declares no outputs." },
  );
  panel.replaceChildren(
    el("section", { "aria-labelledby": "pipeline-inputs" }, el("h2", { class: "h2", id: "pipeline-inputs" }, "Inputs"), inputTable),
    el(
      "section",
      { "aria-labelledby": "pipeline-outputs" },
      el("h2", { class: "h2", id: "pipeline-outputs" }, "Outputs"),
      outputTable,
    ),
  );
}
