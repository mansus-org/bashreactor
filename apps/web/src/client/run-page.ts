// One run. The header says what it is and what can be done with it, the timeline says where every
// step got to, and the tabs hold the log, the steps, the graph, the values and the files. The run is
// read once a second while it is running, and only the live parts are patched: the controls keep
// their focus and the timeline keeps its scroll.

import { api, ApiError, canWrite } from "./api.js";
import type { Attempt, LogChunk, Run, RunFiles, RunStep } from "./api.js";
import { announce, el, errorBox, fill, flash, sign, stateLine } from "./dom.js";
import type { Child } from "./dom.js";
import { createGraph } from "./graph.js";
import type { Graph } from "./graph.js";
import { fetchLibrary } from "./library.js";
import { MAX_DRAWN_LINES, clipLine, emptyLog, feedLog, logLines } from "./logs.js";
import type { LogLine, LogState } from "./logs.js";
import { analyze, readUses } from "./model.js";
import type { Analysis } from "./model.js";
import { navigate } from "./app.js";
import { POLL_MS, errorBody, errorWords, state, wallClock, whenShown } from "./run-shared.js";
import type { Clock } from "./run-shared.js";
import { drawTimeline } from "./timeline.js";
import type { Timeline } from "./timeline.js";
import {
  alarm,
  button,
  confirmDialog,
  exactTime,
  formatBytes,
  formatDuration,
  pageHeader,
  readTab,
  relativeTime,
  segmented,
  statusStamp,
  table,
  tabs,
  writeTab,
} from "./ui.js";

type Children = Parameters<typeof fill>[1];

function lastAttempt(step: RunStep): Attempt | null {
  return step.attempts.length === 0 ? null : step.attempts[step.attempts.length - 1]!;
}

function attemptSeconds(attempt: Attempt, now: number): number {
  const began = Date.parse(attempt.started_at);
  const ended = attempt.finished_at === null ? now : Date.parse(attempt.finished_at);
  return Number.isNaN(began) || Number.isNaN(ended) ? Number.NaN : Math.max(0, (ended - began) / 1000);
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isFileValue(value: unknown): value is string {
  return typeof value === "string" && /^steps\/[^/]+\/attempts\/[0-9]+\/outputs\//.test(value);
}

/** A block as the steps table names it: the library form, or the path a pipeline file uses. */
function blockLabel(uses: string): string {
  if (!uses.startsWith("./")) return uses;
  const path = uses.replace(/@[1-9][0-9]*$/, "");
  return path.endsWith(".sh") ? path : `${path}.sh`;
}

/** A link that looks like a file and opens through the API, because the browser's own navigation
 * cannot carry the bearer token (SPEC 4.1). */
function fileLink(href: string, label: string, onClick: () => void, size?: number): HTMLAnchorElement {
  return el(
    "a",
    {
      class: "file",
      href,
      "data-download": label,
      onclick: (event: Event) => {
        event.preventDefault();
        onClick();
      },
    },
    label,
    size === undefined ? null : el("span", { class: "file__size" }, ` ${formatBytes(size)}`),
  );
}

function downloadButton(label: string, href: string, onClick: () => void): HTMLAnchorElement {
  return el(
    "a",
    {
      class: "btn",
      href,
      "data-download": label,
      onclick: (event: Event) => {
        event.preventDefault();
        onClick();
      },
    },
    label,
  );
}

function attemptsOf(run: Run, step: string): number[] {
  return (run.steps[step]?.attempts ?? []).map((entry) => entry.n);
}

/** A step that has said its last word (SPEC 4.4); `waiting_retry` is still going. */
function settled(step: RunStep | undefined): boolean {
  return step !== undefined && ["succeeded", "failed", "skipped", "cancelled"].includes(step.status);
}

function pickStep(run: Run): string {
  const ids = Object.keys(run.steps);
  const live = ids.find((id) => run.steps[id]!.status === "running");
  const failed = ids.find((id) => run.steps[id]!.status === "failed");
  const last = ids.toReversed().find((id) => (run.steps[id]?.attempts.length ?? 0) > 0);
  return live ?? failed ?? last ?? ids[0] ?? "";
}

function stateChanged(before: Run, after: Run): string[] {
  const changed: string[] = [];
  for (const id of Object.keys(after.steps)) {
    if (before.steps[id]?.status !== after.steps[id]!.status) changed.push(id);
  }
  if (before.status !== after.status) changed.push("run");
  return changed;
}

function metaPair(header: HTMLElement, label: string): { label: HTMLElement; value: HTMLElement } | null {
  const labelNode = [...header.querySelectorAll<HTMLElement>(".meta-line__label")].find((node) => node.textContent === label);
  if (labelNode === undefined) return null;
  const parent = labelNode.parentElement ?? (labelNode as unknown as { parent: HTMLElement | null }).parent;
  if (parent === null) return null;
  const index = [...parent.children].indexOf(labelNode);
  const value = parent.children[index + 1] as HTMLElement | undefined;
  return value === undefined ? null : { label: labelNode, value };
}

function lineNode(line: LogLine, number: number): HTMLElement {
  const clipped = clipLine(line.text);
  return el(
    "li",
    { class: "log__line" },
    el("span", { class: "log__number", "aria-hidden": "true" }, String(number)),
    el("span", { class: "log__text" }, clipped === "" ? " " : clipped),
  );
}

/** The block versions a run's snapshot names, in the library's own vocabulary. */
function libraryRefs(text: string): { name: string; version: number }[] {
  const refs = new Map<string, { name: string; version: number }>();
  const add = (name: string, blockVersion: number): void => {
    refs.set(`${name}@${blockVersion}`, { name, version: blockVersion });
  };
  const read = (value: string): void => {
    const ref = readUses(value);
    if (ref !== null && ref.version !== null) add(ref.name, ref.version);
    else {
      // A run's snapshot keeps the file-shaped form of a library reference, because that is what
      // the server staged. The library is still the thing that answers with its contract.
      const staged = /^\.\/([a-z][a-z0-9-]{0,63})(?:\.sh)?@([1-9][0-9]*)$/.exec(value);
      if (staged !== null) add(staged[1]!, Number(staged[2]));
    }
  };
  const parsed = analyze(text, {});
  if (parsed.ok) {
    for (const step of parsed.steps) if (step.uses !== null) read(step.uses);
  } else {
    for (const match of text.matchAll(/(?:\.\/)?([a-z][a-z0-9-]{0,63})(?:\.sh)?@([1-9][0-9]*)/g)) {
      add(match[1]!, Number(match[2]));
    }
  }
  return [...refs.values()];
}

/** The run's snapshot with a staged `./name@1` rewritten to the library's `name@1`. */
function graphText(text: string): string {
  return text.replace(/\.\/([a-z][a-z0-9-]{0,63})(?:\.sh)?(@[1-9][0-9]*)/g, "$1$2");
}

interface Refusal {
  kind: string;
  error: { code: string; message: string; path?: string; file?: string };
}

export async function renderRunPage(
  view: HTMLElement,
  id: string,
  signal: AbortSignal,
  clock: Clock = wallClock,
): Promise<void> {
  view.replaceChildren(stateLine(`Loading run ${id}.`));
  let run: Run;
  try {
    run = await api.run(id);
  } catch (error) {
    if (signal.aborted) return;
    view.replaceChildren(
      errorBox(errorBody(error), el("a", { class: "btn btn--ink", href: "/app/runs", "data-link": "" }, "All runs")),
    );
    return;
  }
  if (signal.aborted) return;

  const params = new URL(location.href).searchParams;
  let selected = params.get("step") ?? pickStep(run);
  if (run.steps[selected] === undefined) selected = pickStep(run);
  let attempt = Number(params.get("attempt") ?? "0");
  if (!attemptsOf(run, selected).includes(attempt)) attempt = attemptsOf(run, selected).at(-1) ?? 0;
  let selectedTab = readTab("logs");
  let log: LogState = emptyLog;
  let polling = false;
  let follow = true;
  let busy = false;
  let refused: Refusal | null = null;
  let lastError: string | null = null;
  let lastPollError: string | null = null;
  let files: RunFiles | null = null;
  let shown = 0;
  let notDrawn = 0;
  let partialNode: HTMLElement | null = null;
  let readGeneration = 0;
  let reading: Promise<void> | null = null;
  let readingKey = "";
  let unmake: (() => void) | null = null;
  let programmaticScroll = false;

  // ---------- the head ----------

  const startedValue = el("time");
  const finishedValue = el("time");
  const durationValue = el("span", { class: "run-page__duration" });
  const stepsValue = el("span", { class: "run-page__steps" });
  const version = run.pipeline_version;
  const versionValue =
    version === null || version === undefined
      ? null
      : el("a", { class: "mono", href: `/app/pipelines/${run.pipeline}?version=${version}`, "data-link": "" }, `v${version}`);

  const cancelButton = button("Cancel", { onClick: () => void askCancel() });
  cancelButton.dataset.action = "cancel";
  const retryButton = button("Retry", { primary: true, onClick: () => void act("retry") });
  retryButton.dataset.action = "retry";
  const resumeButton = button("Resume", { onClick: () => void act("resume") });
  resumeButton.dataset.action = "resume";
  const download = downloadButton("Download", api.runArchiveUrl(run.id), () => void api.saveRunArchive(run.id));
  download.dataset.action = "download";
  const deleteButton = button("Delete", { onClick: () => void askDelete() });
  deleteButton.dataset.action = "delete";
  const stale = el("span", { class: "run-page__stale", hidden: true }, "lost the server, still trying");
  const actions = el("div", { class: "row" }, cancelButton, resumeButton, retryButton, download, deleteButton, stale);
  const idStatus = statusStamp(run.status);
  const idCancel = el("span", { class: "stamp", hidden: true }, "cancel requested");
  const header = pageHeader({
    crumbs: [
      { label: "Runs", href: "/app/runs" },
      { label: run.pipeline, href: `/app/pipelines/${run.pipeline}` },
      { label: run.id, mono: true },
    ],
    title: run.pipeline,
    actions: [actions],
    idLine: { id: run.id, stamps: [idStatus, idCancel] },
    meta: [
      ["Started", startedValue],
      ["Finished", finishedValue],
      ["Duration", durationValue],
      ["Steps", stepsValue],
      ...(versionValue === null ? [] : ([["Version", versionValue]] as [string, Child][])),
    ],
  });
  const finishedPair = metaPair(header, "Finished");

  const alarmSlot = el("div", { class: "run-alarm", hidden: true });
  const timeline: Timeline = drawTimeline(run, {
    now: clock.now(),
    selected,
    onSelect: (stepId) => choose(stepId, true),
  });

  // ---------- the log ----------

  const attemptHost = el("div", { class: "attempts" });
  const followButton = button("Follow", {
    onClick: () => toggleFollow(),
  }) as HTMLButtonElement;
  followButton.setAttribute("aria-pressed", "true");
  const logStatus = el("p", { class: "log-status", id: "log-status" });
  const logBytes = el("span", { class: "log-bytes", "aria-label": "Bytes read so far" });
  const logDownloadHost = el("span", { class: "log-download" });
  const logNote = el("p", { class: "log-note help", id: "log-note", hidden: true });
  const logLinesNode = el("ol", { class: "log__lines" });
  const logBox = el(
    "div",
    {
      class: "log",
      tabindex: "0",
      "aria-label": "Log output. Arrow keys scroll it.",
      "aria-live": "off",
      "aria-describedby": "log-status log-note",
    },
    logLinesNode,
  );
  const logPanel = el(
    "div",
    { class: "log-panel" },
    el(
      "div",
      { class: "log-toolbar" },
      el("span", { class: "log-toolbar__step mono", id: "log-step" }),
      attemptHost,
      followButton,
      logBytes,
      logDownloadHost,
    ),
    logStatus,
    logNote,
    logBox,
  );

  // ---------- the tabs ----------

  const stepsPanel = el("div", { class: "run-tabpanel" });
  const ioPanel = el("div", { class: "run-tabpanel" });
  const filesPanel = el("div", { class: "run-tabpanel" });
  const graphPanel = el("div", { class: "run-graph" });
  const tabRoot = tabs(
    [
      { id: "logs", label: "Logs", panel: logPanel },
      { id: "steps", label: "Steps", panel: stepsPanel },
      { id: "graph", label: "Graph", panel: graphPanel },
      { id: "io", label: "Inputs & outputs", panel: ioPanel },
      { id: "files", label: "Files", panel: filesPanel },
    ],
    selectedTab,
    (tab) => {
      selectedTab = tab;
      writeTab(tab);
      rememberStepAttempt();
      if (tab === "graph") void ensureGraph();
      renderTabs();
    },
  );

  view.replaceChildren(header, alarmSlot, timeline.node, tabRoot);

  signal.addEventListener("abort", () => {
    unmake?.();
    graph?.destroy();
  });

  const said = new WeakMap<HTMLElement, string>();
  function say(node: HTMLElement, key: string, build: () => Children): void {
    if (said.get(node) === key) return;
    said.set(node, key);
    fill(node, build());
  }

  function rememberStepAttempt(): void {
    const url = new URL(location.href);
    if (selected === "") url.searchParams.delete("step");
    else url.searchParams.set("step", selected);
    if (attempt > 0) url.searchParams.set("attempt", String(attempt));
    else url.searchParams.delete("attempt");
    history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function showTab(tab: string): void {
    const buttonNode = [...tabRoot.querySelectorAll<HTMLButtonElement>(".tab")].find((node) =>
      (node.getAttribute("id") ?? "").endsWith(`-tab-${tab}`),
    );
    if (buttonNode !== undefined) buttonNode.click();
    else if (tab === "graph") void ensureGraph();
  }

  function renderHead(): void {
    document.title = `${run.pipeline} — Bashreactor`;
    const stamp = state(run.status);
    idStatus.replaceChildren(sign(stamp), stamp);
    idCancel.hidden = run.cancel_requested_at === null;
    const started = relativeTime(run.created_at, clock.now());
    startedValue.textContent = started;
    startedValue.setAttribute("datetime", run.created_at);
    const exactStarted = exactTime(run.created_at);
    if (exactStarted === "") startedValue.removeAttribute("title");
    else startedValue.title = exactStarted;
    const ended = run.finished_at === null ? null : relativeTime(run.finished_at, clock.now());
    if (finishedPair !== null) {
      finishedPair.label.hidden = ended === null;
      finishedPair.value.hidden = ended === null;
      finishedValue.textContent = ended ?? "";
      if (run.finished_at !== null) {
        finishedValue.setAttribute("datetime", run.finished_at);
        const exactFinished = exactTime(run.finished_at);
        if (exactFinished !== "") finishedValue.title = exactFinished;
      }
    }
    const began = Date.parse(run.created_at);
    const end = run.finished_at === null ? clock.now() : Date.parse(run.finished_at);
    durationValue.textContent = Number.isNaN(began) || Number.isNaN(end) ? "—" : formatDuration(Math.max(0, end - began));
    const counts = Object.values(run.steps);
    const done = counts.filter((step) => step.status === "succeeded").length;
    stepsValue.textContent = `${done} / ${counts.length}`;

    const live = run.status === "running";
    const held = run.claim?.live === true;
    const writable = canWrite();
    cancelButton.hidden = !(writable && live);
    resumeButton.hidden = !(writable && live && !held);
    retryButton.hidden = !(writable && (run.status === "failed" || run.status === "cancelled"));
    deleteButton.hidden = !(writable && !live);
    for (const control of [cancelButton, retryButton, resumeButton, deleteButton] as HTMLButtonElement[]) {
      control.disabled = busy;
    }
    stale.hidden = lastPollError === null;
    if (lastPollError !== null) stale.title = lastPollError;

    renderAlarm();
    renderTimeline();
    renderAttempts();
    renderLogStatus();
    renderTabs();
  }

  function renderTimeline(): void {
    timeline.update(run, { now: clock.now(), selected, onSelect: (stepId) => choose(stepId, true) });
  }

  function failedSteps(): string[] {
    return Object.keys(run.steps).filter((stepId) => run.steps[stepId]!.status === "failed");
  }

  function retryScope(): string {
    const parts: string[] = [];
    for (const status of ["failed", "skipped", "cancelled"] as const) {
      const count = Object.values(run.steps).filter((step) => step.status === status).length;
      if (count > 0) parts.push(`${count} ${status} ${count === 1 ? "step" : "steps"}`);
    }
    return parts.join(", ");
  }

  function renderAlarm(): void {
    const failed = failedSteps();
    const key =
      refused !== null
        ? `refused ${refused.kind} ${refused.error.code}`
        : failed.map((stepId) => `${stepId} ${run.steps[stepId]!.failure?.code ?? ""}`).join(" · ");
    alarmSlot.hidden = key === "";
    if (key === "") {
      alarmSlot.replaceChildren();
      return;
    }
    say(alarmSlot, key, () => [refused !== null ? refusalAlarm(refused) : failureAlarm(failed)]);
  }

  function refusalAlarm(refusal: Refusal): HTMLElement {
    const kind = refusal.kind.charAt(0).toUpperCase() + refusal.kind.slice(1);
    return alarm({
      status: "failed",
      lead: `${kind} refused`,
      text: [el("code", {}, refusal.error.code), ` ${refusal.error.message}`],
      actions: [
        button("Dismiss", {
          onClick: () => {
            refused = null;
            renderAlarm();
          },
        }),
      ],
    });
  }

  function failureAlarm(failed: string[]): HTMLElement {
    const reset = Object.values(run.steps).filter((step) => ["failed", "skipped", "cancelled"].includes(step.status)).length;
    const names = failed.map((stepId) =>
      el(
        "button",
        { class: "btn btn--small", type: "button", "data-log-step": stepId, onclick: () => showLog(stepId) },
        stepId,
      ),
    );
    const words = failed.map((stepId) => {
      const failure = run.steps[stepId]!.failure;
      return failure === null ? "The step exited with an error." : `${failure.code}: ${failure.message}`;
    });
    const canRetry = canWrite();
    const retry = button(reset > 0 ? `Retry ${reset} ${reset === 1 ? "step" : "steps"}` : "Retry", {
      onClick: () => void act("retry"),
      title: `Sets ${retryScope()} back to pending`,
    });
    retry.dataset.action = "retry-all";
    const showLogButton = button("Show log", { onClick: () => showLog(failed[0] ?? selected) });
    showLogButton.dataset.action = "show-log";
    return alarm({
      status: "failed",
      lead:
        failed.length === 1
          ? el(
              "button",
              { class: "btn btn--text", type: "button", "data-log-step": failed[0], onclick: () => showLog(failed[0]!) },
              `${failed[0]} failed`,
            )
          : `${failed.length} steps failed`,
      text:
        failed.length === 1
          ? `· ${words[0]}`
          : [
              el("span", { class: "run-alarm__steps" }, ...names.flatMap((node, index) => [index === 0 ? "" : " · ", node])),
              ` · ${words.join(" · ")}`,
            ],
      actions: [showLogButton, ...(canRetry ? [retry] : [])],
    });
  }

  function showLog(stepId: string): void {
    choose(stepId, true);
    showTab("logs");
    timeline.focus(stepId);
  }

  // ---------- the log's controls ----------

  let attemptKey = "";
  function renderAttempts(): void {
    const attempts = attemptsOf(run, selected);
    const step = run.steps[selected];
    const statuses = attempts.map((n) => step?.attempts.find((entry) => entry.n === n)?.status ?? "pending").join(",");
    const key = `${selected}:${attempts.join(",")}:${statuses}:${attempt}`;
    if (key === attemptKey) return;
    attemptKey = key;
    logPanel.querySelector(".log-toolbar__step")?.replaceChildren(selected);
    if (attempts.length === 0) {
      attemptHost.replaceChildren(el("span", { class: "help" }, "No attempts yet."));
      return;
    }
    const control = segmented(
      "Attempt",
      attempts.map((n) => ({
        value: String(n),
        label: String(n),
        sign: step?.attempts.find((entry) => entry.n === n)?.status ?? "pending",
      })),
      String(attempt === 0 ? attempts[attempts.length - 1] : attempt),
      (value) => {
        attempt = Number(value);
        log = emptyLog;
        shown = 0;
        renderAttempts();
        renderLog(true);
        rememberStepAttempt();
        void readLog(true);
      },
    );
    attemptHost.replaceChildren(control);
  }

  function renderLogStatus(): void {
    const step = run.steps[selected];
    const started = (step?.attempts.length ?? 0) > 0;
    const live = run.status === "running";
    followButton.disabled = !live;
    followButton.setAttribute("aria-pressed", String(follow));
    logBytes.textContent = `${formatBytes(log.offset)} read`;

    if (lastError !== null) logStatus.textContent = `Lost the server, still trying. ${lastError}`;
    else if (!started) logStatus.textContent = "Not started.";
    else if (log.truncated) logStatus.textContent = "More of the log is waiting.";
    else if (live && step?.status === "running") logStatus.textContent = "Reading.";
    else logStatus.textContent = "Read to the end.";
  }

  function renderLogDownload(): void {
    const listed = files?.steps[selected]?.attempts.find((entry) => entry.n === attempt);
    const logPath = listed?.log?.path;
    const key = logPath === undefined ? "" : `${logPath}:${listed?.log?.size ?? ""}`;
    say(logDownloadHost, key, () =>
      logPath === undefined
        ? []
        : [
            fileLink(
              api.runFileUrl(run.id, logPath),
              "Download log",
              () => void api.saveRunFile(run.id, logPath),
              listed?.log?.size,
            ),
          ],
    );
  }

  function renderLog(reset: boolean): void {
    const lines = logLines(log);
    if (reset) shown = 0;
    if (lines.length === 0) {
      const step = run.steps[selected];
      const message =
        step === undefined || step.attempts.length === 0
          ? run.status === "running"
            ? "No output yet."
            : "This step never started."
          : run.status === "running"
            ? "No output yet."
            : "This attempt wrote nothing.";
      logLinesNode.replaceChildren(el("li", { class: "log__empty" }, message));
      logNote.hidden = true;
      shown = 0;
      notDrawn = 0;
      partialNode = null;
      return;
    }
    if (shown === 0) {
      logLinesNode.replaceChildren();
      notDrawn = 0;
      partialNode = null;
    }
    partialNode?.remove();
    partialNode = null;

    const fresh = log.lines.slice(shown);
    const drawn = fresh.slice(-MAX_DRAWN_LINES);
    notDrawn += fresh.length - drawn.length;
    drawn.forEach((line, index) => logLinesNode.append(lineNode(line, shown + index + 1)));
    shown = log.lines.length;
    if (log.partial !== "") {
      partialNode = lineNode({ offset: log.partialOffset, text: log.partial }, log.lines.length + 1);
      logLinesNode.append(partialNode);
    }
    while (logLinesNode.childElementCount > MAX_DRAWN_LINES) {
      logLinesNode.firstElementChild?.remove();
      notDrawn += 1;
    }

    logNote.hidden = notDrawn === 0;
    if (notDrawn > 0) {
      logNote.textContent = `Drawing the last ${MAX_DRAWN_LINES} lines. The first ${notDrawn} lines are not drawn.`;
    }
    if (follow) scrollToEnd();
    else if (reset) logBox.scrollTop = 0;
  }

  function scrollToEnd(): void {
    programmaticScroll = true;
    logBox.scrollTop = logBox.scrollHeight;
    requestAnimationFrame(() => {
      programmaticScroll = false;
    });
  }

  logBox.addEventListener("scroll", () => {
    if (programmaticScroll || !follow) return;
    if (logBox.scrollTop + logBox.clientHeight < logBox.scrollHeight - 8) {
      follow = false;
      renderLogStatus();
    }
  });

  function choose(stepId: string, byHand: boolean): void {
    if (run.steps[stepId] === undefined) return;
    const moved = stepId !== selected;
    selected = stepId;
    const attempts = attemptsOf(run, stepId);
    const newest = attempts.at(-1) ?? 0;
    if (moved || newest !== attempt) {
      attempt = newest;
      log = emptyLog;
      shown = 0;
    }
    if (byHand && run.steps[stepId]!.status !== "running" && follow) follow = false;
    timeline.select(stepId);
    renderAttempts();
    renderLog(true);
    renderLogStatus();
    renderAlarm();
    renderTabs();
    if (moved) rememberStepAttempt();
    if (attempts.length > 0) void readLog(true);
  }

  function toggleFollow(): void {
    follow = !follow;
    if (follow) {
      const live = Object.keys(run.steps).find((step) => run.steps[step]!.status === "running");
      if (live !== undefined && live !== selected) choose(live, false);
      scrollToEnd();
    }
    renderLogStatus();
  }

  function readLog(reset: boolean): Promise<void> {
    if (attempt === 0) return Promise.resolve();
    const key = `${selected}/${attempt}`;
    if (reset || key !== readingKey) {
      readGeneration += 1;
      reading = null;
    } else if (reading !== null) {
      return reading;
    }
    const mine = readGeneration;
    readingKey = key;
    const loop = readUntilEnd(reset, mine, key).finally(() => {
      if (reading === loop) reading = null;
    });
    reading = loop;
    return loop;
  }

  async function readUntilEnd(reset: boolean, generation: number, key: string): Promise<void> {
    let first = reset;
    try {
      for (;;) {
        const chunk: LogChunk = await api.log(run.id, selected, attempt, first ? 0 : log.offset);
        if (signal.aborted || generation !== readGeneration || key !== `${selected}/${attempt}`) return;
        log = feedLog(first ? emptyLog : log, chunk);
        lastError = null;
        renderLogStatus();
        renderLog(first);
        first = false;
        if (!chunk.truncated) break;
        await new Promise((done) => setTimeout(done, 0));
      }
      renderLogDownload();
    } catch (error) {
      if (signal.aborted || generation !== readGeneration) return;
      if (error instanceof ApiError && (error.code === "attempt_not_found" || error.code === "step_not_found")) {
        log = emptyLog;
        renderLog(true);
        renderLogStatus();
        return;
      }
      lastError = errorWords(error);
      renderLogStatus();
    }
  }

  // ---------- actions ----------

  async function askCancel(): Promise<void> {
    const yes = await confirmDialog({
      title: "Cancel this run?",
      text: "The running step gets SIGTERM and every pending step is cancelled. The work directories stay, so a retry carries on from them.",
      confirmLabel: "Cancel the run",
    });
    if (yes) await act("cancel");
  }

  async function askDelete(): Promise<void> {
    const yes = await confirmDialog({
      title: "Delete this run?",
      text: "Its directory, every log and every file a block made are removed. This cannot be undone.",
      confirmLabel: "Delete the run",
    });
    if (yes) await act("delete");
  }

  async function act(kind: "cancel" | "retry" | "resume" | "delete"): Promise<void> {
    busy = true;
    renderHead();
    try {
      if (kind === "delete") {
        await api.deleteRun(run.id);
        announce(`${run.id} deleted.`);
        navigate("/runs");
        return;
      }
      const next =
        kind === "cancel" ? await api.cancelRun(run.id) : kind === "retry" ? await api.retryRun(run.id) : await api.resumeRun(run.id);
      run = next;
      refused = null;
      lastError = null;
      announce(`${run.id} ${kind} requested.`);
      if (kind === "retry") {
        log = emptyLog;
        shown = 0;
        follow = true;
      }
      renderHead();
      void tick();
    } catch (error) {
      refused = { kind, error: errorBody(error) };
    } finally {
      busy = false;
      renderHead();
    }
  }

  // ---------- steps, inputs and outputs, files ----------

  function renderTabs(): void {
    const stepKey = Object.values(run.steps)
      .map((step) => `${step.id}:${step.status}:${step.attempts.length}:${step.attempts_used}:${Object.keys(step.outputs ?? {}).join("|")}`)
      .join(",");
    say(stepsPanel, stepKey, () => [stepsTable()]);

    const ioKey = `${run.status}:${JSON.stringify(run.inputs)}:${JSON.stringify(run.outputs)}`;
    say(ioPanel, ioKey, () => [inputsOutputs()]);

    const fileKey = files === null ? "none" : JSON.stringify(files);
    say(filesPanel, fileKey, () => [filesView()]);
  }

  function stepsTable(): HTMLElement {
    const rows = Object.values(run.steps);
    const drawn = table(
      [
        {
          header: "Step",
          cell: (step: RunStep) => {
            const newest = attemptsOf(run, step.id).at(-1) ?? 0;
            const href = `/app/runs/${run.id}?tab=logs&step=${encodeURIComponent(step.id)}&attempt=${newest}`;
            return el(
              "a",
              {
                class: "table__link",
                href,
                "data-link": "",
                onclick: (event: Event) => {
                  event.preventDefault();
                  openLogs(step.id);
                },
              },
              el("span", { class: "mono" }, step.id),
              step.name !== step.id ? el("span", { class: "step-cell__name" }, step.name) : null,
            );
          },
        },
        { header: "Block", cell: (step: RunStep) => el("span", { class: "mono" }, blockLabel(step.block.uses)) },
        { header: "Status", cell: (step: RunStep) => statusStamp(state(step.status)) },
        { header: "Attempts", align: "right", cell: (step: RunStep) => String(step.attempts_used) },
        {
          header: "Started",
          cell: (step: RunStep) => {
            const last = lastAttempt(step);
            if (last === null) return "—";
            const node = el("time", {}, relativeTime(last.started_at, clock.now()));
            node.setAttribute("datetime", last.started_at);
            const exact = exactTime(last.started_at);
            if (exact !== "") node.title = exact;
            return node;
          },
        },
        {
          header: "Duration",
          align: "right",
          cell: (step: RunStep) => {
            const last = lastAttempt(step);
            if (last === null) return "—";
            const seconds = attemptSeconds(last, clock.now());
            return Number.isNaN(seconds) ? "—" : formatDuration(seconds * 1000);
          },
        },
        {
          header: "Outputs",
          cell: (step: RunStep) => {
            const names = Object.keys(step.outputs ?? {});
            return names.length === 0 ? "—" : el("span", { class: "mono" }, names.join(", "));
          },
        },
      ],
      rows,
      {
        empty: "This run has no steps.",
        rowHref: (step: RunStep) =>
          `/app/runs/${run.id}?tab=logs&step=${encodeURIComponent(step.id)}&attempt=${attemptsOf(run, step.id).at(-1) ?? 0}`,
      },
    );
    drawn.classList.add("run-steps");
    drawn.querySelectorAll("tbody tr").forEach((row, index) => {
      const step = rows[index];
      if (step !== undefined) row.setAttribute("data-step", step.id);
    });
    return drawn;
  }

  function openLogs(stepId: string): void {
    choose(stepId, true);
    showTab("logs");
  }

  function valueCell(value: unknown): Child {
    if (isFileValue(value)) {
      return fileLink(api.runFileUrl(run.id, value), value, () => void api.saveRunFile(run.id, value));
    }
    return el("span", { class: "mono run-io__value" }, valueText(value));
  }

  function inputsOutputs(): Child[] {
    const inputs = Object.entries(run.inputs).map(([name, value]) => ({ name, value }));
    const outputs = Object.entries(run.outputs ?? {}).map(([name, value]) => ({ name, value }));
    const inputTable = table(
      [
        { header: "Name", cell: (row: { name: string; value: unknown }) => el("span", { class: "mono" }, row.name) },
        { header: "Value", cell: (row: { name: string; value: unknown }) => valueCell(row.value) },
      ],
      inputs,
      { empty: "This run has no inputs." },
    );
    const outputTable = table(
      [
        { header: "Name", cell: (row: { name: string; value: unknown }) => el("span", { class: "mono" }, row.name) },
        { header: "Value", cell: (row: { name: string; value: unknown }) => valueCell(row.value) },
      ],
      outputs,
      {
        empty: run.status === "succeeded" ? "This run has no outputs." : "Outputs appear when the run succeeds.",
      },
    );
    return [
      el("section", { class: "run-io" }, el("h2", { class: "h2" }, "Inputs"), inputTable),
      el("section", { class: "run-io" }, el("h2", { class: "h2" }, "Outputs"), outputTable),
    ];
  }

  function filesView(): Child[] {
    const rows: { path: string; size?: number }[] = [];
    const seen = new Set<string>();
    const add = (path: string, size?: number): void => {
      if (seen.has(path)) return;
      seen.add(path);
      rows.push(size === undefined ? { path } : { path, size });
    };
    for (const output of files?.outputs ?? []) add(output.path, output.size);
    for (const step of Object.values(files?.steps ?? {})) {
      for (const attemptEntry of step.attempts) {
        if (attemptEntry.log !== undefined) add(attemptEntry.log.path, attemptEntry.log.size);
        for (const entry of [...(attemptEntry.outputs ?? []), ...(attemptEntry.work ?? [])]) add(entry.path, entry.size);
      }
    }

    const downloadTable = table(
      [
        { header: "Path", cell: (row: { path: string; size?: number }) => el("span", { class: "mono" }, row.path) },
        { header: "Size", align: "right", cell: (row: { path: string; size?: number }) => (row.size === undefined ? "—" : formatBytes(row.size)) },
        {
          header: "Download",
          align: "right",
          cell: (row: { path: string; size?: number }) =>
            fileLink(api.runFileUrl(run.id, row.path), "Download", () => void api.saveRunFile(run.id, row.path)),
        },
      ],
      rows,
      { empty: files === null ? "No files for this run." : "This run wrote no files." },
    );

    const archives: HTMLElement[] = [];
    for (const [stepId, step] of Object.entries(files?.steps ?? {})) {
      for (const attemptEntry of step.attempts) {
        const label = `Everything in ${stepId} attempt ${attemptEntry.n} as one archive`;
        archives.push(
          fileLink(
            api.runArchiveUrl(run.id, { step: stepId, attempt: attemptEntry.n }),
            label,
            () => void api.saveRunArchive(run.id, { step: stepId, attempt: attemptEntry.n }),
          ),
        );
      }
    }

    return [
      el(
        "div",
        { class: "files-toolbar" },
        downloadButton("Download the whole run", api.runArchiveUrl(run.id), () => void api.saveRunArchive(run.id)),
        downloadButton("Download the manifest", api.runManifestUrl(run.id), () => void api.saveRunManifest(run.id)),
      ),
      downloadTable,
      archives.length === 0 ? null : el("div", { class: "files-archives" }, el("span", { class: "label" }, "Attempt archives"), ...archives),
    ];
  }

  // ---------- the graph ----------

  let graph: Graph | null = null;
  let graphAnalysis: Analysis | null = null;
  let graphLoading = false;
  let graphStage: HTMLElement | null = null;

  function graphStatuses(): Record<string, string> {
    return Object.fromEntries(Object.entries(run.steps).map(([stepId, step]) => [stepId, step.status]));
  }

  function paintGraph(): void {
    if (graph === null || graphAnalysis === null) return;
    graph.update({ analysis: graphAnalysis, selected, stale: false, statuses: graphStatuses() });
  }

  async function ensureGraph(): Promise<void> {
    if (graph !== null || graphLoading) return;
    graphLoading = true;
    graphPanel.replaceChildren(stateLine("Loading graph."));
    try {
      const text = await api.runFileText(run.id, "pipeline.yaml");
      const library = await fetchLibrary(libraryRefs(text));
      const analysis = analyze(graphText(text), library);
      if (signal.aborted) return;
      if (!analysis.ok) {
        graphPanel.replaceChildren(errorBox({ code: analysis.error.code, message: analysis.error.message }));
        return;
      }
      graphAnalysis = analysis;
      graphStage = el("div", { class: "stage run-graph__stage" });
      graph = createGraph(graphStage, {
        onSelect: (stepId) => {
          choose(stepId, true);
          showTab("logs");
        },
      });
      graphPanel.replaceChildren(graphStage);
      paintGraph();
    } catch (error) {
      if (!signal.aborted) graphPanel.replaceChildren(errorBox(errorBody(error)));
    } finally {
      graphLoading = false;
    }
  }

  // ---------- polling ----------

  async function tick(): Promise<void> {
    unmake?.();
    unmake = null;
    if (signal.aborted || document.hidden || polling) return;
    polling = true;
    let changed: string[] = [];
    try {
      const next = await api.run(run.id);
      if (signal.aborted) return;
      changed = stateChanged(run, next);
      run = next;
      lastPollError = null;
    } catch (error) {
      if (signal.aborted) return;
      lastPollError = errorWords(error);
    } finally {
      polling = false;
    }

    if (follow && settled(run.steps[selected])) {
      const live = Object.keys(run.steps).find((step) => run.steps[step]!.status === "running");
      if (live !== undefined && live !== selected) {
        choose(live, false);
        announce(`Following ${live}.`);
      }
    }

    const attempts = attemptsOf(run, selected);
    const newest = attempts.at(-1) ?? 0;
    if (newest !== attempt && follow) {
      attempt = newest;
      log = emptyLog;
      shown = 0;
    }

    await readLog(false);
    if (signal.aborted) return;

    renderHead();
    paintGraph();
    for (const stepId of changed) {
      timeline.flash([stepId]);
      if (stepId !== "run") announce(`${stepId} ${run.steps[stepId]?.status ?? ""}.`);
    }
    if (changed.includes("run")) {
      flash(idStatus);
      announce(`Run ${run.id} ${run.status}.`);
    }

    if (run.status === "running") startPolling();
    else await readLog(false);
  }

  async function readFiles(): Promise<void> {
    try {
      files = await api.runFiles(run.id);
    } catch {
      files = null;
    }
    if (signal.aborted) return;
    renderTabs();
    renderLogDownload();
  }

  function startPolling(): void {
    if (signal.aborted || document.hidden || unmake !== null || run.status !== "running") return;
    unmake = clock.after(POLL_MS, () => void tick());
  }

  whenShown(signal, () => void tick());

  renderHead();
  rememberStepAttempt();
  renderLog(true);
  renderLogDownload();
  if (selectedTab === "graph") void ensureGraph();
  void readFiles();
  await readLog(true);
  if (signal.aborted) return;
  if (run.status === "running") startPolling();
  else void readLog(false);
}
