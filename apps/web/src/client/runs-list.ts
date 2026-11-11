// The runs list. `GET /v1/runs` is the whole of it: every run, newest first, with its state and the
// time it started. While anything on it is running it reads again every `POLL_MS`; when nothing is, it
// keeps a slow watch so a run started elsewhere still turns up.

import { api } from "./api.js";
import { el, errorBox, isoInstant, restamp, sign, stateStamp, when } from "./dom.js";
import type { RunSummary } from "./api.js";
import type { Route } from "./app.js";
import { IDLE_POLL_MS, POLL_MS, errorBody, errorWords, state, wallClock, whenShown } from "./run-shared.js";
import type { Clock } from "./run-shared.js";

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

/** The list screen the router draws for `/runs`. */
export function renderRunsList(view: HTMLElement, _route: Route, signal: AbortSignal, clock: Clock = wallClock): void {
  void renderList(view, signal, clock);
}
