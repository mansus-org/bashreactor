// The run screen. The list is `GET /v1/runs`; one run is rendered from its own `run.json` and
// nothing else — steps in declaration order, their statuses, attempt counts and durations, and a log
// pane that follows one attempt by byte offset. Ported from mockup/run.js with the simulator
// replaced by polling, because the engine is the only thing that knows what a step is doing.

import { api, ApiError, canWrite } from "./api.js";
import { announce, duration, el, errorBox, fill, flash, isoInstant, restamp, sign, stateLine, stateStamp, when } from "./dom.js";
import type { State } from "./dom.js";
import { MAX_DRAWN_LINES, clipLine, emptyLog, feedLog, logLines } from "./logs.js";
import type { LogLine, LogState } from "./logs.js";
import type { Route } from "./app.js";
import { navigate } from "./app.js";
import type { Attempt, LogChunk, Run, RunFiles, RunStep, RunSummary } from "./api.js";

/** How often a live run is re-read. The log is a byte offset, so this is a cursor, not a stream. */
export const POLL_MS = 1000;

/**
 * How often the Runs list is re-read when nothing on it is running.
 *
 * Nothing running is not the end of the story: the run that starts next may be started from the CLI
 * or in another tab, and the page is the only place most people look. A second would be rude, so the
 * list goes quiet rather than stopping, and a run that turns up takes the fast loop back.
 */
export const IDLE_POLL_MS = 15_000;

/**
 * The time a live view runs on: what now is, and how to be woken later.
 *
 * Both live views are built on this instead of calling `setTimeout` and `Date.now()` themselves so
 * that a test can advance time and count requests instead of sleeping. That is what makes finding 45
 * testable at all: "the list polled twice and then stopped" is a count of reads against a clock the
 * test chose, not a wait, and "the elapsed time on screen is 4 m 07 s" is checked against a now the
 * test set rather than whatever the machine running the test thinks it is.
 */
export interface Clock {
  now(): number;
  /** Do `run` in `ms`, unless it is called off first. Hands back the calling-off. */
  after(ms: number, run: () => void): () => void;
}

/** The real one. */
export const wallClock: Clock = {
  now: () => Date.now(),
  after: (ms, run) => {
    const id = window.setTimeout(run, ms);
    return () => window.clearTimeout(id);
  },
};

/**
 * Start `again` whenever the tab is shown, so a view that stopped reading starts again.
 *
 * A tab in the background is not watching anybody, and browsers throttle its timers to about a minute
 * anyway, so neither live view reads while it is hidden. Coming back is the moment a run that started
 * somewhere else turns up, which is when the reading picks itself back up.
 */
function whenShown(signal: AbortSignal, again: () => void): void {
  const onVisibility = (): void => {
    if (!document.hidden && !signal.aborted) again();
  };
  document.addEventListener("visibilitychange", onVisibility);
  signal.addEventListener("abort", () => document.removeEventListener("visibilitychange", onVisibility));
}

/**
 * A link to one of a run's files. The href is the real API address, so it can be copied, opened in a
 * new tab against a server that takes a token some other way, or read by whatever is checking that a
 * page says what it links to; the click goes through the API client instead, because that is the only
 * thing holding the bearer token (SPEC 4.1) and a navigation the browser makes alone cannot carry it.
 */
function downloadLink(href: string, label: string, onClick: () => void, size?: number): HTMLElement {
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
    ...(size === undefined ? [] : [el("span", { class: "file__size" }, ` ${bytes(size)}`)]),
  );
}

/** Bytes the way a person reads them, because a run that ingested URLs has gigabytes in it. */
function bytes(count: number): string {
  if (count < 1024) return `${count} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = count / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * The statuses this screen can stamp: the seven step statuses of SPEC 4.4, the run statuses that
 * section's table ends with, and `interrupted` — SPEC 5 keeps that to an attempt, never a step or a
 * run, but `status` is an unvalidated string on the wire and dom.ts already draws the shape, so a
 * server that answers with it gets its own word rather than a guess.
 *
 * Everything else falls back to `pending`, which is a choice rather than a reflex. `stateStamp`
 * prints the word it is handed and `sign` substitutes the not-started shape for a name it does not
 * know, so handing an unknown status through would pair one state's word with another's shape. And
 * `pending` is the least wrong thing to say about a status from an older server: it claims nothing
 * about the outcome and is not final, so it cannot tell a reader a run is over when the UI has simply
 * never seen that state — and it always draws, so the stamp is never blank and nothing throws.
 */
const STAMPABLE = new Set<string>([
  "pending",
  "running",
  "waiting_retry",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
  "interrupted",
] satisfies State[]);

function state(value: string): State {
  return (STAMPABLE.has(value) ? value : "pending") as State;
}

function attemptDuration(attempt: Attempt, now: number): number {
  const start = Date.parse(attempt.started_at);
  const end = attempt.finished_at === null ? now : Date.parse(attempt.finished_at);
  return Math.max(0, (end - start) / 1000);
}

function lastAttempt(step: RunStep): Attempt | null {
  return step.attempts.length > 0 ? step.attempts[step.attempts.length - 1]! : null;
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The SPEC 5 words for whatever went wrong, so one line reads the same wherever it came from. */
function errorWords(error: unknown): string {
  return error instanceof ApiError ? `${error.code}: ${error.message}` : String(error);
}

/** The body `errorBox` draws, whether the server answered in an error or something else threw. */
function errorBody(error: unknown): { code: string; message: string; path?: string; file?: string } {
  return error instanceof ApiError ? error : { code: "internal_error", message: String(error) };
}

/** An action the server said no to, kept on the page until it is dismissed or an action works. */
interface Refusal {
  kind: string;
  error: { code: string; message: string; path?: string; file?: string };
}

/** What `fill` takes, so a builder can name what it returns without a type dom.ts keeps to itself. */
type Children = Parameters<typeof fill>[1];

export function renderRuns(view: HTMLElement, route: Route, signal: AbortSignal, clock: Clock = wallClock): void {
  const id = route.parts[1];
  if (id === undefined) {
    void renderList(view, signal, clock);
    return;
  }
  void renderOne(view, id, signal, clock);
}

// ---------- the list ----------

/** The empty list, made once and hidden until a read says there is nothing in it. */
function emptyRuns(): HTMLElement {
  return el(
    "div",
    { class: "stage__empty" },
    sign("queued", "sign sign--large"),
    el("p", {}, "Nothing has run here yet. Start a pipeline from the editor and it shows up while it works."),
    el("a", { class: "btn btn--ink", href: "/app/pipeline", "data-link": "" }, "Open the editor"),
  );
}

/**
 * The list of runs, which is a live view in its own right: while any run on it is going it reads again
 * every `POLL_MS`, and stops the moment none is. A run that starts, finishes or is retried while you
 * are looking has to say so here, and not only after a reload.
 *
 * Rows are made once and patched where they changed, for the reason the run screen gives for its step
 * rows: this screen redraws itself under you, and a rebuilt row takes your focus, your hover and your
 * place in the scroll with it. Only the state stamp changes on the way, because that is the only thing
 * about a run on this list that can move.
 */
async function renderList(view: HTMLElement, signal: AbortSignal, clock: Clock): Promise<void> {
  const lead = el("p", { class: "lead" });
  // The one line that says what the reading is doing: loading, still trying after a failure, or gone.
  const note = el("p", { class: "runlist__note", role: "status" }, "Loading the runs.");
  const empty = emptyRuns();
  empty.hidden = true;
  const list = el("ul", { class: "blocklist", "aria-label": "Runs, newest first" });
  view.replaceChildren(
    el(
      "div",
      { class: "head" },
      el("div", { class: "head__text" }, el("h1", { class: "title" }, "Runs"), lead),
    ),
    note,
    empty,
    list,
  );

  /** The rows on the page, keyed by run id, in the order they were made. */
  const rows = new Map<string, HTMLElement>();
  let failure: HTMLElement | null = null;
  let seen = false;
  let unmake: (() => void) | null = null;
  /** Whether a read is on its way, so two wakes cannot start two and land them out of order. */
  let reading = false;

  /** Put `node` at `index` among the list's children, moving it if it is not already sitting there. */
  function place(node: HTMLElement, index: number): void {
    if (list.children[index] === node) return;
    list.insertBefore(node, list.children[index] ?? null);
  }

  function paint(runs: RunSummary[]): void {
    seen = true;
    note.hidden = true;
    lead.textContent = `${runs.length} ${runs.length === 1 ? "run" : "runs"}, newest first. A run is a directory; this is its run.json.`;
    empty.hidden = runs.length !== 0;
    runs.forEach((run, at) => {
      let row = rows.get(run.id);
      if (row === undefined) {
        row = el("li", {}, runRow(run));
        rows.set(run.id, row);
      } else {
        const stamp = row.querySelector<HTMLElement>(".stamp");
        if (stamp !== null) restamp(stamp, state(run.status));
      }
      place(row, at);
    });
    // A Map being walked while entries drop out of it is fine: the iterator notices.
    const stillHere = new Set(runs.map((run) => run.id));
    for (const [id, row] of rows) {
      if (stillHere.has(id)) continue;
      row.remove();
      rows.delete(id);
    }
  }

  /** The last thing said about a read, so a stretch of failures does not rebuild the same box. */
  let said = "";

  /** Say what the last read did. Rows already up stay, under a line saying they may be out of date. */
  function tell(error: unknown): void {
    const message = error === null ? "" : errorWords(error);
    if (message === said) return;
    said = message;
    failure?.remove();
    failure = null;
    if (message === "") {
      note.hidden = true;
      return;
    }
    if (seen) {
      note.textContent = `Lost the server, still trying. ${message}`;
      note.hidden = false;
      return;
    }
    // Nothing on the page yet, so there is nothing to call out of date: this is the whole of the screen,
    // and the line that said it was loading has to get out of the way of the box saying it failed.
    note.hidden = true;
    failure = errorBox(errorBody(error), el("a", { class: "btn btn--ink", href: "/app/pipeline", "data-link": "" }, "Open the editor"));
    view.append(failure);
  }

  async function tick(): Promise<void> {
    unmake?.();
    unmake = null;
    // A hidden tab is not watching, and its timers are throttled to about a minute anyway. The reading
    // stops here and `whenShown` starts it again when the tab is next looked at.
    if (signal.aborted || document.hidden || reading) return;
    reading = true;
    let runs: RunSummary[] | null = null;
    let error: unknown = null;
    try {
      runs = await api.runs();
    } catch (cause) {
      error = cause;
    }
    reading = false;
    if (signal.aborted) return;
    if (runs !== null) {
      paint(runs);
      tell(null);
    } else {
      tell(error);
    }
    // A run is either `running` or one of the final states (SPEC 4.4), so once nothing on the page is
    // running there is nothing of its own left to watch and the list drops to the slow one.
    // A read that landed while the tab went hidden arms nothing: `whenShown` owns the restart.
    if (document.hidden) return;
    // A read that failed says nothing about what is running, so it does not change the pace: the run
    // this page last saw going may well still be going, and a lost server is not a reason to slow down.
    const busy = runs === null || runs.some((run) => run.status === "running");
    unmake = clock.after(busy ? POLL_MS : IDLE_POLL_MS, () => void tick());
  }

  whenShown(signal, () => void tick());
  signal.addEventListener("abort", () => unmake?.());
  await tick();
}

function runRow(run: RunSummary): HTMLElement {
  // The words are the reader's own clock; `datetime` and the title carry that same instant in UTC, so
  // two screens and a server log line up without anybody doing sums.
  const stored = isoInstant(run.created_at);
  const printed = when(run.created_at);
  const exact = stored === "" ? {} : { datetime: stored, title: stored };
  return el(
    "a",
    { class: "runrow", href: `/app/runs/${run.id}`, "data-link": "" },
    el(
      "span",
      {},
      el("span", { class: "runrow__id" }, run.id),
      // A time this build cannot read is left out rather than echoed back at the reader: the pipeline is
      // still worth the row, and a wrong time on a list is worse than a missing one.
      printed === ""
        ? el("span", { class: "runrow__meta" }, ` · ${run.pipeline}`)
        : el("time", { class: "runrow__meta", ...exact }, ` · ${run.pipeline}, started ${printed}`),
    ),
    // The stamp is the state: it carries the sign and the word, so the row does not repeat the shape
    // at 70 px next to it.
    stateStamp(state(run.status)),
  );
}

function lineNode(line: LogLine): HTMLElement {
  const clipped = clipLine(line.text);
  return el(
    "li",
    { class: "log__line" },
    el("span", { class: "log__offset" }, String(line.offset)),
    el("span", { class: "log__text" }, clipped === "" ? " " : clipped),
  );
}

function attemptsOf(run_: Run, step: string): number[] {
  return (run_.steps[step]?.attempts ?? []).map((entry) => entry.n);
}

/**
 * Whether a step has said its last word (SPEC 4.4). `waiting_retry` is not one of these: a step that
 * failed an attempt and is due another one is still going, and moving off it is how a pane ends up
 * reading a parallel step while the one you chose starts its second attempt behind you.
 */
function settled(step: RunStep | undefined): boolean {
  return step !== undefined && ["succeeded", "failed", "skipped", "cancelled"].includes(step.status);
}

function pickStep(run_: Run): string {
  const ids = Object.keys(run_.steps);
  const live = ids.find((step) => run_.steps[step]!.status === "running");
  const failed = ids.find((step) => run_.steps[step]!.status === "failed");
  const last = ids.toReversed().find((step) => (run_.steps[step]?.attempts.length ?? 0) > 0);
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

// ---------- one run ----------

async function renderOne(view: HTMLElement, id: string, signal: AbortSignal, clock: Clock): Promise<void> {
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

  let selected = pickStep(run);
  let attempt = attemptsOf(run, selected).at(-1) ?? 0;
  let log: LogState = emptyLog;
  /** Whether a run read is on its way, so a click and a timer cannot land two of them out of order. */
  let polling = false;
  let follow = true;
  let paused = false;
  let busy = false;
  // The server's own words after it refused an action, in state of its own because renderHead runs on
  // every poll and would otherwise hide the box in the same tick the refusal arrived in. Cleared by a
  // dismiss or by an action that works.
  let refused: Refusal | null = null;
  // The last read that failed, shown until a read succeeds. A page that has stopped getting polls
  // keeps drawing the last good one, so it has to say that it has.
  let lastError: string | null = null;
  // What the last read of the run could not say, kept apart from the log's own failure: the two are
  // read separately, and a log that got through must not cover up a run that did not.
  let lastPollError: string | null = null;
  let programmaticScroll = false;
  // The manifest of downloadable files, read once per run rather than on every poll: what a run can
  // hand out does not change while you watch it, and a second of polling should not refetch a tree.
  let files: RunFiles | null = null;
  // Finished lines of `log` that have been handled by renderLog, and how many of those were not drawn.
  let shown = 0;
  let notDrawn = 0;
  // The node showing the unfinished last line, which has to be replaced when more of that line arrives.
  let partialNode: HTMLElement | null = null;
  // Bumped when the log is pointed somewhere else, so a read loop still in flight lets go of it.
  let readGeneration = 0;
  let reading: Promise<void> | null = null;
  let readingKey = "";
  // The next poll, and the way to call it off. Null means there is none: the run has finished, or the
  // tab is hidden, and `startPolling` is the only thing that puts one back.
  let unmake: (() => void) | null = null;

  // The id is 26 characters of code, not a headline: "Run" is the display word and the id goes under
  // it in the code face, where it reads as one line.
  const title = el("h1", { class: "title" }, "Run ", el("span", { class: "title__id mono" }, run.id));
  const bigSign = el("div", { class: "runhead__sign" });
  // The head is built once and updated in place: it holds the link to the pipeline, and a head
  // rebuilt every second drops your focus off it.
  const metaStamp = el("span", {});
  const metaStarted = el("span", {});
  const metaElapsed = el("span", {});
  const metaCancel = el("span", { hidden: true }, "cancel requested");
  // Where a run that cannot be read says so. The line under the log belongs to the log: a run whose
  // poll is lost is a stale state at the top of the page, and a log read that happened to get through
  // must not be allowed to hide it.
  const metaPoll = el("span", { class: "runhead__stale", hidden: true }, "lost the server, still trying");
  const meta = el(
    "div",
    { class: "runhead__meta" },
    metaStamp,
    el("a", { href: `/app/pipeline/${run.pipeline}`, "data-link": "" }, run.pipeline),
    metaStarted,
    metaElapsed,
    metaCancel,
    metaPoll,
  );
  const jump = el("input", {
    id: "run-jump",
    type: "text",
    value: run.id,
    spellcheck: "false",
    onkeydown: (event) => {
      if ((event as KeyboardEvent).key !== "Enter") return;
      event.preventDefault();
      const value = (event.target as HTMLInputElement).value.trim();
      if (value !== "") navigate(`/runs/${value}`);
    },
  });
  const cancelButton = el(
    "button",
    { class: "btn", type: "button", hidden: true, onclick: () => cancelDialog.showModal() },
    "Cancel run",
  );
  const resumeButton = el(
    "button",
    { class: "btn", type: "button", hidden: true, onclick: () => void act("resume") },
    "Resume",
  );
  const retryButton = el(
    "button",
    { class: "btn", type: "button", hidden: true, onclick: () => void act("retry") },
    "Retry",
  );
  const readOnly = el("span", { class: "stamp stamp--type", hidden: true }, "read only");
  // The alarm's own retry, built once for the same reason: it says how many steps it will reset, and
  // that number is what changes, not the button.
  const alarmRetry = el("button", { class: "btn btn--ink", type: "button", "data-action": "retry-all", onclick: () => void act("retry") });
  // Built once, for the reason the step rows give below: what you type in the jump box and the focus
  // on these buttons do not survive a rebuild, and renderHead runs every second.
  const tools = el(
    "div",
    { class: "runhead__tools" },
    el("div", { class: "field" }, el("label", { class: "label", for: "run-jump" }, "Run"), jump),
    el("a", { class: "btn", href: "/app/runs", "data-link": "" }, "All runs"),
    downloadLink(api.runArchiveUrl(run.id), "Download the run", () => void api.saveRunArchive(run.id)),
    downloadLink(api.runManifestUrl(run.id), "Download the manifest", () => void api.saveRunManifest(run.id)),
    cancelButton,
    resumeButton,
    retryButton,
    readOnly,
  );
  const params = el("dl", { class: "params", "aria-label": "Inputs of this run" });
  const alarm = el("section", { class: "alarm", "aria-labelledby": "alarm-title", hidden: true });
  const stepList = el("ul", { class: "steps", "aria-label": "Steps of this run, in the order the pipeline declares them" });
  const panelTitle = el("h2", { class: "h2", id: "panel-title" });
  const panelMeta = el("p", { class: "logpanel__meta" });
  const panelOutputs = el("dl", { class: "outputs" });
  const panelFiles = el("div", { class: "files", "aria-label": "Files of this attempt" });
  const noAttempt = el("span", { class: "help" }, "This step has never started, so there is no log yet.");
  const attemptPicker = el(
    "div",
    { class: "attempts", role: "group", "aria-label": "Attempt whose log this is" },
    el("span", { class: "label label--inline" }, "Attempt"),
    noAttempt,
  );
  // One button per attempt number, made the first time that number is seen and hidden when the step
  // on screen has no such attempt, because a rebuilt button loses your focus and a step gains
  // attempts while you watch it.
  const attemptButtons = new Map<number, HTMLButtonElement>();
  const followButton = el("button", { class: "btn", type: "button", "aria-pressed": "true", onclick: toggleFollow }, "Follow");
  const pauseButton = el("button", { class: "btn", type: "button", onclick: togglePause }, "Pause");
  const logStatus = el("p", { class: "logpanel__status", id: "log-status" });
  const logNote = el("p", { class: "logpanel__meta", id: "log-note", hidden: true });
  const logLinesNode = el("ol", { class: "log__lines" });
  // role=log would read every line aloud; the step's state change is announced on its own instead.
  const logBox = el(
    "div",
    { class: "log", tabindex: "0", "aria-label": "Log output. Arrow keys scroll it.", "aria-live": "off", "aria-describedby": "log-status log-note" },
    logLinesNode,
  );

  const cancelDialog = el(
    "dialog",
    { class: "dialog", "aria-labelledby": "cancel-title" },
    el(
      "div",
      { class: "dialog__body" },
      el("h2", { class: "dialog__title", id: "cancel-title" }, "Cancel this run?"),
      el("p", {}, "The running step gets SIGTERM and every pending step is cancelled. The work directories stay, so a retry carries on from them."),
      el(
        "div",
        { class: "row" },
        el("button", { class: "btn btn--ink", type: "button", onclick: () => { cancelDialog.close(); void act("cancel"); } }, "Cancel the run"),
        el("button", { class: "btn", type: "button", onclick: () => cancelDialog.close() }, "Keep it running"),
      ),
    ),
  );

  view.replaceChildren(
    el(
      "div",
      { class: "runhead" },
      bigSign,
      el("div", { class: "runhead__text" }, title, meta),
      tools,
    ),
    params,
    alarm,
    el("div", { class: "run" }, el("section", { "aria-label": "Steps" }, stepList), el(
      "section",
      { class: "logpanel", id: "log-panel" },
      el("div", { class: "bar" }, panelTitle, el("div", { class: "logpanel__tools" }, logStatus, followButton, pauseButton)),
      panelMeta,
      attemptPicker,
      panelOutputs,
      panelFiles,
      logNote,
      logBox,
    )),
    cancelDialog,
  );

  signal.addEventListener("abort", () => {
    unmake?.();
  });

  /**
   * Rebuild a node only when what it says has changed. This screen re-renders every second, and a
   * rebuilt node takes your focus and whatever you had typed in it with it; the step rows below are
   * the precedent.
   */
  const said = new WeakMap<HTMLElement, string>();
  function say(node: HTMLElement, key: string, build: () => Children): void {
    if (said.get(node) === key) return;
    said.set(node, key);
    fill(node, build());
  }

  function stepNote(step: RunStep): string {
    const runSteps = run.steps;
    // Whether the log panel is holding this step. Follow keeps a step there while it waits its turn or
    // its retry, and a row that only says "Waits for a free slot" reads like the panel is stuck on the
    // wrong step. Said once, in the row, where the state is.
    const onScreen = step.id === selected ? "On screen. " : "";
    if (step.status === "waiting_retry") {
      const due = step.next_attempt_at === null ? Number.NaN : Date.parse(step.next_attempt_at);
      // A retry time that cannot be read is not a countdown, and one that has gone past is not either:
      // the engine's clock and the browser's are two clocks, and counting backwards is never the truth.
      if (Number.isNaN(due)) return `${onScreen}Waiting to retry.`;
      if (due <= clock.now()) return `${onScreen}Another attempt is due now.`;
      // Rounded up, because "in 0 s" with a moment still to go reads as a timer that has stopped.
      return `${onScreen}Another attempt in ${duration(Math.ceil((due - clock.now()) / 1000))}.`;
    }
    if (step.status === "pending") {
      const open = step.needs.filter((need) => runSteps[need]?.status !== "succeeded");
      return `${onScreen}${open.length > 0 ? `Waits for ${open.join(", ")}.` : "Waits for a free slot."}`;
    }
    if (step.status === "running") return `Attempt ${step.attempts_used}, ${step.attempts.length} attempt${step.attempts.length === 1 ? "" : "s"} so far.`;
    if (step.status === "failed") return step.failure !== null ? `${step.failure.code}: ${step.failure.message}. ${step.attempts_used} attempt${step.attempts_used === 1 ? "" : "s"} used; the work directory is kept.` : "Failed.";
    if (step.status === "skipped") {
      const bad = step.needs.find((need) => ["failed", "cancelled", "skipped"].includes(runSteps[need]?.status ?? ""));
      return bad !== undefined ? `${bad} ${runSteps[bad]!.status}, so this never started.` : "A dependency did not succeed.";
    }
    if (step.status === "cancelled") return "Cancelled. The work directory is kept.";
    return step.attempts_used > 1 ? `Took ${step.attempts_used} attempts.` : "Done.";
  }

  function renderHead(): void {
    document.title = `Run ${run.id} — Bashreactor`;
    const stamp = state(run.status);
    say(bigSign, stamp, () => [sign(stamp, "sign sign--large")]);
    metaStamp.replaceChildren(stateStamp(stamp));
    const elapsed = ((run.finished_at !== null ? Date.parse(run.finished_at) : clock.now()) - Date.parse(run.created_at)) / 1000;
    // A time this build cannot read is not shown at all: "started NaN" is worse than the word with
    // nothing after it, and the exact instant is only worth putting up if it is a real instant.
    const stored = isoInstant(run.created_at);
    const printed = when(run.created_at);
    metaStarted.hidden = printed === "";
    metaStarted.textContent = printed === "" ? "started" : `started ${printed}`;
    metaStarted.title = stored;
    const counted = duration(elapsed);
    metaElapsed.hidden = counted === "";
    metaElapsed.textContent =
      counted === "" ? "" : run.finished_at !== null ? `took ${counted}` : `running for ${counted}`;
    metaCancel.hidden = run.cancel_requested_at === null;
    metaPoll.hidden = lastPollError === null;
    if (lastPollError !== null) metaPoll.setAttribute("title", lastPollError);

    // A run's inputs are fixed when it starts (SPEC 4.9), so this is built once and then left alone.
    say(params, JSON.stringify(run.inputs), () =>
      Object.entries(run.inputs).map(([key, value]) => el("div", {}, el("dt", {}, key), el("dd", {}, valueText(value)))),
    );

    // The controls already exist; only what they allow changes. Rebuilding them every second is what
    // made the jump box forget what you typed and dropped your focus off Cancel.
    //
    // Each one is offered only where it can work, because a button whose only answer is a refusal is
    // a trap. SPEC 4.6 allows a manual retry on a failed or cancelled run and on no other, so a
    // succeeded run gets no Retry. SPEC 4.7 refuses resume while an engine holds the run, and this
    // server holds every run it is driving, so a live claim gets no Resume; a stale claim does, since
    // that run is the one worth taking up. A response without `claim` says nobody, which is read as no
    // holder rather than a crash.
    const live = run.status === "running";
    const held = run.claim?.live === true;
    const writable = canWrite();
    cancelButton.hidden = !(writable && live);
    resumeButton.hidden = !(writable && live && !held);
    retryButton.hidden = !(writable && (run.status === "failed" || run.status === "cancelled"));
    readOnly.hidden = writable;
    cancelButton.disabled = busy;
    resumeButton.disabled = busy;
    retryButton.disabled = busy;
    alarmRetry.disabled = busy;

    renderAlarm();
  }

  /** Every step the run left failed, in the order the pipeline declares them. */
  function failedSteps(): string[] {
    return Object.keys(run.steps).filter((stepId) => run.steps[stepId]!.status === "failed");
  }

  /** What a manual retry sets back to pending, which is more than the steps that failed (4.6). */
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
    // The box says one thing at a time: a refusal outranks the failures it was about. Both are
    // rebuilt only when the words change, so the focus on a button inside it survives a poll.
    const key =
      refused !== null
        ? `refused ${refused.kind} ${refused.error.code}`
        : failed.map((stepId) => `${stepId} ${run.steps[stepId]!.failure?.code ?? ""}`).join(" · ");
    alarm.hidden = key === "";
    say(alarm, key, () => (refused !== null ? refusalBox(refused) : failed.length === 0 ? [] : failureBox(failed)));
  }

  /** The server said no to an action, and its own words stay up until they are dismissed or beaten. */
  function refusalBox(refusal: Refusal): Children {
    const kind = refusal.kind.charAt(0).toUpperCase() + refusal.kind.slice(1);
    return [
      el("h2", { class: "h2", id: "alarm-title" }, `${kind} refused`),
      errorBox(refusal.error),
      el("div", { class: "row" }, el("button", { class: "btn", type: "button", "data-action": "dismiss", onclick: dismissRefusal }, "Dismiss")),
    ];
  }

  function dismissRefusal(): void {
    refused = null;
    renderAlarm();
  }

  /** Every failed step by name, each one a way to its log, and a retry labelled with what it does. */
  function failureBox(failed: string[]): Children {
    const reset = Object.values(run.steps).filter((step) => ["failed", "skipped", "cancelled"].includes(step.status)).length;
    alarmRetry.textContent = `Retry ${reset} ${reset === 1 ? "step" : "steps"}`;
    return [
      el(
        "h2",
        { class: "h2", id: "alarm-title" },
        failed.length === 1 ? `${failed[0]} failed` : `${failed.length} steps failed`,
      ),
      ...failed.map((stepId) => {
        const step = run.steps[stepId]!;
        return el(
          "p",
          { class: "row" },
          el("button", { class: "btn", type: "button", "data-log-step": stepId, onclick: () => showLog(stepId) }, stepId),
          el("span", {}, step.failure !== null ? `${step.failure.code}: ${step.failure.message}` : "The step exited with an error."),
        );
      }),
      canWrite()
        ? el(
            "p",
            { class: "help" },
            `Retry sets ${retryScope()} back to pending and runs them again. The steps that succeeded keep their results, and the work directories are kept.`,
          )
        : null,
      el("div", { class: "row" }, canWrite() ? alarmRetry : el("span", { class: "stamp stamp--type" }, "read only")),
    ];
  }

  /** Point the pane at one step's log and put the focus on its row, which is where the alarm sends you. */
  function showLog(stepId: string): void {
    choose(stepId, true);
    stepList.querySelector<HTMLButtonElement>(`[data-step="${CSS.escape(stepId)}"]`)?.focus();
  }

  /** One row per step, built once: the run polls every second and a rebuilt row loses your focus. */
  interface Row {
    button: HTMLButtonElement;
    time: HTMLElement;
    stamp: HTMLElement;
    note: HTMLElement;
  }
  const rows: Record<string, Row> = {};
  for (const stepId of Object.keys(run.steps)) {
    const row: Row = {
      button: null as unknown as HTMLButtonElement,
      time: el("span", { class: "steprow__time" }),
      stamp: el("span", { class: "steprow__stamp" }),
      note: el("span", { class: "steprow__note" }),
    };
    row.button = el(
      "button",
      {
        class: "steprow",
        type: "button",
        "data-step": stepId,
        "aria-selected": "false",
        onclick: () => choose(stepId, true),
      },
      el("span", { class: "steprow__id" }, stepId),
      row.time,
      row.stamp,
      row.note,
    );
    rows[stepId] = row;
    stepList.append(el("li", {}, row.button));
  }

  function renderSteps(): void {
    for (const [stepId, row] of Object.entries(rows)) {
      const step = run.steps[stepId];
      if (step === undefined) continue;
      const last = lastAttempt(step);
      row.button.setAttribute("aria-selected", String(stepId === selected));
      row.time.textContent = last !== null ? duration(attemptDuration(last, clock.now())) : "";
      row.stamp.replaceChildren(stateStamp(state(step.status)));
      row.note.textContent = stepNote(step);
    }
  }

  function renderPanel(): void {
    const step = run.steps[selected];
    if (step === undefined) return;
    panelTitle.textContent = selected;
    say(panelMeta, `${step.name} ${step.block.name} ${step.block.uses} ${step.block.sha256}`, () => [
      step.name !== selected ? `${step.name}. ` : "",
      "Runs ",
      el("a", { href: `/app/blocks/${step.block.name}`, "data-link": "" }, `${step.block.name} (${step.block.uses})`),
      ". ",
      `sha256 ${step.block.sha256.slice(0, 12)}…`,
    ]);

    // One button per attempt number, made once and updated in place: renderPanel runs on every poll,
    // and a picker rebuilt under your cursor or your focus loses it.
    const attempts = attemptsOf(run, selected);
    noAttempt.hidden = attempts.length !== 0;
    for (const n of attempts) {
      const button = attemptButtons.get(n) ?? newAttemptButton(n);
      button.hidden = false;
      button.setAttribute("aria-pressed", String(n === attempt));
    }
    for (const [n, button] of attemptButtons) if (!attempts.includes(n)) button.hidden = true;

    const outputs = step.status === "succeeded" && step.outputs !== null ? Object.entries(step.outputs) : [];
    panelOutputs.hidden = outputs.length === 0;
    say(panelOutputs, outputs.map(([name, value]) => `${name}=${valueText(value)}`).join(","), () =>
      outputs.map(([name, value]) => el("div", {}, el("dt", {}, name), el("dd", { tabindex: "0" }, valueText(value)))),
    );

    // The files this attempt left, taken from the manifest rather than guessed at: the run record says
    // an output is called `report`, and only the tree says whether that is a file, how big it is, and
    // whether it is still being written.
    const listed = files?.steps[selected]?.attempts.find((entry) => entry.n === attempt);
    const downloadable = [...(listed?.outputs ?? []), ...(listed?.work ?? []), ...(listed?.log ? [listed.log] : [])];
    panelFiles.hidden = downloadable.length === 0;
    say(panelFiles, downloadable.map((entry) => `${entry.path}:${entry.size ?? "-"}`).join(","), () =>
      downloadable.length === 0
        ? []
        : [
            el(
              "span",
              { class: "label" },
              listed?.partial === true ? "Files, still being written" : "Files",
            ),
            ...downloadable.map((entry) =>
              downloadLink(
                api.runFileUrl(run.id, entry.path),
                entry.path,
                () => void api.saveRunFile(run.id, entry.path),
                entry.size,
              ),
            ),
            downloadLink(
              api.runArchiveUrl(run.id, { step: selected, attempt }),
              `Everything in ${selected} as one archive`,
              () => void api.saveRunArchive(run.id, { step: selected, attempt }),
            ),
          ],
    );

    renderLogStatus();
  }

  function newAttemptButton(n: number): HTMLButtonElement {
    const button = el(
      "button",
      {
        class: "btn",
        type: "button",
        "aria-pressed": "false",
        onclick: () => {
          attempt = n;
          log = emptyLog;
          shown = 0;
          renderPanel();
          void readLog(true);
        },
      },
      String(n),
    );
    attemptButtons.set(n, button);
    attemptPicker.append(button);
    return button;
  }

  /** The one line that says where the log cursor is, and whether anything can still arrive. */
  function renderLogStatus(): void {
    const step = run.steps[selected];
    const started = (step?.attempts.length ?? 0) > 0;
    // Nothing more can be written to a finished run's log, so offering to follow or pause it is a
    // button that does nothing.
    const finished = run.status !== "running";
    followButton.disabled = finished;
    // A pause made while the run was live still has to be undoable after it ends, or the pane is
    // stuck on half a log with the only way out of it greyed off.
    pauseButton.disabled = !started || (finished && !paused);
    followButton.setAttribute("aria-pressed", String(follow));
    pauseButton.textContent = paused ? "Resume reading" : "Pause";

    if (lastError !== null) logStatus.textContent = `Lost the server, still trying. ${lastError}`;
    else if (!started) logStatus.textContent = "Not started.";
    else if (paused) logStatus.textContent = `Paused. Last read at byte ${log.offset}.`;
    else if (!finished && step?.status === "running") logStatus.textContent = `Reading from byte ${log.offset}.`;
    else if (log.truncated) logStatus.textContent = `Read to byte ${log.offset}; more of the log is waiting.`;
    else logStatus.textContent = `Read to byte ${log.offset}.`;
  }

  function renderLog(reset: boolean): void {
    const lines = logLines(log);
    if (reset) shown = 0;
    if (lines.length === 0) {
      const step = run.steps[selected];
      const message =
        step === undefined || step.status === "pending"
          ? `${selected} has not started. ${step === undefined ? "" : stepNote(step)}`
          : step.status === "skipped"
            ? `${selected} was skipped. ${stepNote(step)}`
            : step.status === "cancelled"
              ? `${selected} was cancelled before it printed anything.`
              : "Waiting for the first line.";
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
    // The unfinished line is drawn again each time, because more of it may have arrived.
    partialNode?.remove();
    partialNode = null;

    // A log of many megabytes must not become hundreds of thousands of nodes: only the last
    // MAX_DRAWN_LINES are kept, and the note above the pane says how many are not.
    const fresh = log.lines.slice(shown);
    const drawn = fresh.slice(-MAX_DRAWN_LINES);
    notDrawn += fresh.length - drawn.length;
    for (const line of drawn) logLinesNode.append(lineNode(line));
    shown = log.lines.length;
    if (log.partial !== "") {
      partialNode = lineNode({ offset: log.partialOffset, text: log.partial });
      logLinesNode.append(partialNode);
    }
    while (logLinesNode.childElementCount > MAX_DRAWN_LINES) {
      logLinesNode.firstElementChild?.remove();
      notDrawn += 1;
    }

    const first = log.lines[notDrawn];
    logNote.hidden = notDrawn === 0;
    if (notDrawn > 0) {
      logNote.textContent =
        `Drawing the last ${MAX_DRAWN_LINES} lines. The first ${notDrawn} lines, bytes 0 to ${first?.offset ?? log.partialOffset}, are not drawn; ` +
        `read them with bashreactor runs logs ${run.id} ${selected}.`;
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

  // Scrolling up to read means you left the live edge; Follow says so rather than yanking you back.
  logBox.addEventListener("scroll", () => {
    if (programmaticScroll || !follow) return;
    if (logBox.scrollTop + logBox.clientHeight < logBox.scrollHeight - 8) {
      follow = false;
      renderPanel();
    }
  });

  function choose(stepId: string, byHand: boolean): void {
    if (run.steps[stepId] === undefined) return;
    const moved = stepId !== selected;
    selected = stepId;
    const attempts = attemptsOf(run, stepId);
    const newest = attempts.at(-1) ?? 0;
    // The pane holds one step's and one attempt's bytes, so pointing it at another step always starts
    // it again: the old offset belongs to a log that is no longer on screen.
    if (moved || newest !== attempt) {
      attempt = newest;
      log = emptyLog;
      shown = 0;
    }
    if (byHand && run.steps[stepId]!.status !== "running" && follow) follow = false;
    renderSteps();
    renderPanel();
    if (attempts.length > 0) void readLog(true);
    else renderLog(true);
  }

  function toggleFollow(): void {
    follow = !follow;
    if (follow) {
      const live = Object.keys(run.steps).find((step) => run.steps[step]!.status === "running");
      if (live !== undefined && live !== selected) choose(live, false);
      scrollToEnd();
    }
    renderPanel();
  }

  function togglePause(): void {
    paused = !paused;
    if (!paused) void readLog(false);
    renderPanel();
  }

  // One read is one capped chunk, so the pane reads on while the server says there is more: a finished
  // run stops polling, and its tail would otherwise never arrive. Only one loop runs at a time, because
  // two readers from the same offset would hand feedLog chunks that are not where it left off.
  function readLog(reset: boolean): Promise<void> {
    if (paused || attempt === 0) return Promise.resolve();
    const key = `${selected}/${attempt}`;
    // A loop reading another attempt's log has nothing to give this one.
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
        // A read that worked is the end of a bad stretch, and the line under the log is the place
        // that says how far the cursor has got, so both are said here and not only at the end.
        lastError = null;
        renderLogStatus();
        renderLog(first);
        first = false;
        if (!chunk.truncated || paused) break;
        // Let the browser paint and take input between megabytes.
        await new Promise((done) => setTimeout(done, 0));
      }
      renderPanel();
    } catch (error) {
      if (signal.aborted || generation !== readGeneration) return;
      // A log that is not there is an honest empty pane, not a stack of banners.
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

  async function act(kind: "cancel" | "retry" | "resume"): Promise<void> {
    busy = true;
    renderHead();
    try {
      const next = kind === "cancel" ? await api.cancelRun(run.id) : kind === "retry" ? await api.retryRun(run.id) : await api.resumeRun(run.id);
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
      renderSteps();
      renderPanel();
      // An action you just took is worth a read now rather than one from a second ago, and it is the
      // one thing that can make a finished run live again, so this is what starts the loop back up.
      void tick();
    } catch (error) {
      // run_not_active, run_claimed, run_not_retryable: the server's own words, on the run's own
      // page, and in state of their own, because the `finally` below renders the head and a head
      // render that only looks at the run would hide the box in the same tick the refusal arrived.
      refused = { kind, error: errorBody(error) };
    } finally {
      busy = false;
      renderHead();
    }
  }

  async function tick(): Promise<void> {
    unmake?.();
    unmake = null;
    // A hidden tab is not watching anybody, and browsers throttle its timers to about a minute
    // anyway, so it reads nothing while it is hidden. `whenShown` picks the loop back up.
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
      // The page goes on showing the last good poll, so it has to say that it stopped getting one.
      lastPollError = errorWords(error);
    } finally {
      polling = false;
    }

    if (follow && settled(run.steps[selected])) {
      // Follow means the live edge, so the pane moves when the step it is on finishes and another one
      // starts. It used to move only when a new attempt appeared, which left it sitting on a finished
      // log for the whole of a step that succeeded on its first try while the run went on elsewhere.
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
    renderSteps();
    renderPanel();
    for (const stepId of changed) {
      flash(stepList.querySelector(`[data-step="${CSS.escape(stepId)}"]`));
      if (stepId !== "run") announce(`${stepId} ${run.steps[stepId]?.status ?? ""}.`);
    }
    if (changed.includes("run")) {
      flash(bigSign);
      announce(`Run ${run.id} ${run.status}.`);
    }

    if (run.status === "running") {
      startPolling();
    } else {
      // One last read so the tail of the log is on screen, then the polling stops for good.
      await readLog(false);
    }
  }

  /**
   * The list of what this run can hand out, read once. If it will not come, the screen still shows the
   * run: a run whose files cannot be listed is a run you can still read the log of, and there is
   * nothing honest to say about files that would be better than the links simply not being there.
   */
  async function readFiles(): Promise<void> {
    try {
      files = await api.runFiles(run.id);
    } catch {
      files = null;
    }
    if (!signal.aborted) renderPanel();
  }

  /**
   * Arm the next poll, if one is owed. A finished run has nothing left to say and a hidden tab cannot
   * show what it reads, so neither gets a timer, and there is never one left behind: the loop is
   * either waiting or it is not, and this is the only place it waits.
   */
  function startPolling(): void {
    if (signal.aborted || document.hidden || unmake !== null || run.status !== "running") return;
    unmake = clock.after(POLL_MS, () => void tick());
  }

  // Coming back to the tab is the moment a run that moved while you were away turns up, so that is
  // when the reading starts again — now, not a second later.
  whenShown(signal, () => void tick());

  renderHead();
  renderSteps();
  renderPanel();
  renderLog(true);
  void readFiles();
  await readLog(true);
  if (signal.aborted) return;
  if (run.status === "running") startPolling();
  else void readLog(false);
}
