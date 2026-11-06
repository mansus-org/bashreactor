// The run screen. The list is `GET /v1/runs`; one run is rendered from its own `run.json` and
// nothing else — steps in declaration order, their statuses, attempt counts and durations, and a log
// pane that follows one attempt by byte offset. Ported from mockup/run.js with the simulator
// replaced by polling, because the engine is the only thing that knows what a step is doing.

import { api, ApiError, canWrite } from "./api.js";
import { announce, duration, el, errorBox, fill, flash, sign, stateLine, stateStamp, when } from "./dom.js";
import type { State } from "./dom.js";
import { emptyLog, feedLog, logLines } from "./logs.js";
import type { LogState } from "./logs.js";
import type { Route } from "./app.js";
import { navigate } from "./app.js";
import type { Attempt, LogChunk, Run, RunStep, RunSummary } from "./api.js";

/** How often a live run is re-read. The log is a byte offset, so this is a cursor, not a stream. */
const POLL_MS = 1000;

/**
 * The words this screen has a sign and a stamp for: the seven step statuses of SPEC 4.4, the four run
 * statuses that section's table ends with, and `interrupted` — SPEC 5 puts that on an attempt and
 * never on a step or a run, but `status` is an unvalidated string on the wire and dom.ts already
 * draws the shape, so a server that answers with it gets its own word shown rather than a guess.
 *
 * Anything else falls back to `pending`, and that is a choice rather than a reflex. `stateStamp`
 * prints the word it is handed while `sign` quietly substitutes the not-started shape for a name it
 * does not know, so passing an unknown status through would pair one state's word with another's
 * shape; and `sign` is typed, so an unknown string is a type error rather than a runtime one.
 * `pending` is the least wrong thing to say about a status from an older server: it claims nothing
 * about the outcome and is not final, so it cannot tell someone a run is over when the UI simply has
 * never seen that state — and it always draws, so the stamp is never empty and nothing throws.
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

export function renderRuns(view: HTMLElement, route: Route, signal: AbortSignal): void {
  const id = route.parts[1];
  if (id === undefined) {
    void renderList(view, signal);
    return;
  }
  void renderOne(view, id, signal);
}

// ---------- the list ----------

async function renderList(view: HTMLElement, signal: AbortSignal): Promise<void> {
  view.replaceChildren(stateLine("Loading the runs."));
  const runs = await api.runs();
  if (signal.aborted) return;

  if (runs.length === 0) {
    view.replaceChildren(
      el("h1", { class: "title" }, "Runs"),
      el(
        "div",
        { class: "stage__empty" },
        sign("queued", "sign sign--large"),
        el("p", {}, "Nothing has run here yet. Start a pipeline from the editor and it shows up while it works."),
        el("a", { class: "btn btn--ink", href: "/app/pipeline", "data-link": "" }, "Open the editor"),
      ),
    );
    return;
  }

  view.replaceChildren(
    el(
      "div",
      { class: "head" },
      el(
        "div",
        { class: "head__text" },
        el("h1", { class: "title" }, "Runs"),
        el("p", { class: "lead" }, `${runs.length} ${runs.length === 1 ? "run" : "runs"}, newest first. A run is a directory; this is its ${"run.json"}.`),
      ),
    ),
    el(
      "ul",
      { class: "blocklist" },
      runs.map((run) => el("li", {}, runRow(run))),
    ),
  );
}

function runRow(run: RunSummary): HTMLElement {
  return el(
    "a",
    { class: "runrow", href: `/app/runs/${run.id}`, "data-link": "" },
    el("span", {}, sign(state(run.status), "sign sign--large")),
    el(
      "span",
      {},
      el("span", { class: "runrow__id" }, run.id),
      el("span", { class: "runrow__meta" }, ` · ${run.pipeline}, started ${when(run.created_at)}`),
    ),
    stateStamp(state(run.status)),
  );
}

function attemptsOf(run_: Run, step: string): number[] {
  return (run_.steps[step]?.attempts ?? []).map((entry) => entry.n);
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

async function renderOne(view: HTMLElement, id: string, signal: AbortSignal): Promise<void> {
  view.replaceChildren(stateLine(`Loading run ${id}.`));
  let run: Run;
  try {
    run = await api.run(id);
  } catch (error) {
    if (signal.aborted) return;
    view.replaceChildren(
      errorBox(
        error instanceof ApiError ? error : { code: "internal_error", message: String(error) },
        el("a", { class: "btn btn--ink", href: "/app/runs", "data-link": "" }, "All runs"),
      ),
    );
    return;
  }
  if (signal.aborted) return;

  let selected = pickStep(run);
  let attempt = attemptsOf(run, selected).at(-1) ?? 0;
  let log: LogState = emptyLog;
  let follow = true;
  let paused = false;
  let busy = false;
  let programmaticScroll = false;
  let shown = 0;
  let timer: number | undefined;

  const title = el("h1", { class: "title" });
  const bigSign = el("div", { class: "runhead__sign" });
  const meta = el("div", { class: "runhead__meta" });
  const tools = el("div", { class: "runhead__tools" });
  const params = el("dl", { class: "params", "aria-label": "Inputs of this run" });
  const alarm = el("section", { class: "alarm", "aria-labelledby": "alarm-title", hidden: true });
  const stepList = el("ul", { class: "steps", "aria-label": "Steps of this run, in the order the pipeline declares them" });
  const panelTitle = el("h2", { class: "h2", id: "panel-title" });
  const panelMeta = el("p", { class: "logpanel__meta" });
  const panelOutputs = el("dl", { class: "outputs" });
  const attemptPicker = el("div", { class: "attempts", role: "group", "aria-label": "Attempt whose log this is" });
  const followButton = el("button", { class: "btn", type: "button", "aria-pressed": "true", onclick: toggleFollow }, "Follow");
  const pauseButton = el("button", { class: "btn", type: "button", onclick: togglePause }, "Pause");
  const logStatus = el("p", { class: "logpanel__status", id: "log-status" });
  const logLinesNode = el("ol", { class: "log__lines" });
  // role=log would read every line aloud; the step's state change is announced on its own instead.
  const logBox = el(
    "div",
    { class: "log", tabindex: "0", "aria-label": "Log output. Arrow keys scroll it.", "aria-live": "off", "aria-describedby": "log-status" },
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
      logBox,
    )),
    cancelDialog,
  );

  signal.addEventListener("abort", () => {
    if (timer !== undefined) window.clearTimeout(timer);
  });

  function stepNote(step: RunStep): string {
    const runSteps = run.steps;
    if (step.status === "waiting_retry") {
      if (step.next_attempt_at !== null) {
        return `Retries in ${duration((Date.parse(step.next_attempt_at) - Date.now()) / 1000)}.`;
      }
      return "Waiting to retry.";
    }
    if (step.status === "pending") {
      const open = step.needs.filter((need) => runSteps[need]?.status !== "succeeded");
      return open.length > 0 ? `Waits for ${open.join(", ")}.` : "Waits for a free slot.";
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
    title.textContent = `Run ${run.id}`;
    document.title = `Run ${run.id} — Bashreactor`;
    bigSign.replaceChildren(sign(state(run.status), "sign sign--large"));
    const elapsed = ((run.finished_at !== null ? Date.parse(run.finished_at) : Date.now()) - Date.parse(run.created_at)) / 1000;
    fill(meta, [
      stateStamp(state(run.status)),
      el("a", { href: `/app/pipeline/${run.pipeline}`, "data-link": "" }, run.pipeline),
      el("span", {}, `started ${when(run.created_at)}`),
      el("span", {}, run.finished_at !== null ? `took ${duration(elapsed)}` : `running for ${duration(elapsed)}`),
      run.cancel_requested_at !== null ? el("span", {}, "cancel requested") : null,
    ]);
    params.replaceChildren(
      ...Object.entries(run.inputs).map(([key, value]) => el("div", {}, el("dt", {}, key), el("dd", {}, valueText(value)))),
    );

    tools.replaceChildren(
      el(
        "div",
        { class: "field" },
        el("label", { class: "label", for: "run-jump" }, "Run"),
        el("input", {
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
        }),
      ),
      el("a", { class: "btn", href: "/app/runs", "data-link": "" }, "All runs"),
    );
    if (canWrite()) {
      if (run.status === "running") {
        tools.append(
          el("button", { class: "btn", type: "button", disabled: busy, onclick: () => cancelDialog.showModal() }, "Cancel run"),
          el("button", { class: "btn", type: "button", disabled: busy, onclick: () => void act("resume") }, "Resume"),
        );
      } else {
        tools.append(el("button", { class: "btn", type: "button", disabled: busy, onclick: () => void act("retry") }, "Retry"));
      }
    } else {
      tools.append(
        el("span", { class: "stamp stamp--type" }, "read only"),
      );
    }

    const failed = Object.keys(run.steps).find((step) => run.steps[step]!.status === "failed");
    alarm.hidden = failed === undefined;
    if (failed !== undefined) {
      const step = run.steps[failed]!;
      alarm.replaceChildren(
        el("h2", { class: "h2", id: "alarm-title" }, `${failed} failed`),
        el("p", {}, step.failure !== null ? `${step.failure.code}: ${step.failure.message}` : "The step exited with an error."),
        el(
          "div",
          { class: "row" },
          canWrite()
            ? el("button", { class: "btn btn--ink", type: "button", onclick: () => void act("retry") }, `Retry from ${failed}`)
            : el("span", { class: "stamp stamp--type" }, "read only"),
          el(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: () => {
                choose(failed, true);
                stepList.querySelector<HTMLButtonElement>(`[data-step="${CSS.escape(failed)}"]`)?.focus();
              },
            },
            "Read its log",
          ),
        ),
      );
    }
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
      row.time.textContent = last !== null ? duration(attemptDuration(last, Date.now())) : "";
      row.stamp.replaceChildren(stateStamp(state(step.status)));
      row.note.textContent = stepNote(step);
    }
  }

  function renderPanel(): void {
    const step = run.steps[selected];
    if (step === undefined) return;
    panelTitle.textContent = selected;
    panelMeta.replaceChildren(
      step.name !== selected ? `${step.name}. ` : "",
      "Runs ",
      el("a", { href: `/app/blocks/${step.block.name}`, "data-link": "" }, `${step.block.name} (${step.block.uses})`),
      ". ",
      `sha256 ${step.block.sha256.slice(0, 12)}…`,
    );

    const attempts = attemptsOf(run, selected);
    fill(attemptPicker, [
      el("span", { class: "label", style: "margin:0" }, "Attempt"),
      ...attempts.map((n) =>
        el(
          "button",
          {
            class: "btn",
            type: "button",
            "aria-pressed": String(n === attempt),
            onclick: () => {
              attempt = n;
              log = emptyLog;
              shown = 0;
              renderPanel();
              void readLog(true);
            },
          },
          String(n),
        ),
      ),
      attempts.length === 0 ? el("span", { class: "help" }, "This step has never started, so there is no log yet.") : null,
    ]);

    const outputs = step.status === "succeeded" && step.outputs !== null ? Object.entries(step.outputs) : [];
    panelOutputs.hidden = outputs.length === 0;
    panelOutputs.replaceChildren(
      ...outputs.map(([name, value]) => el("div", {}, el("dt", {}, name), el("dd", { tabindex: "0" }, valueText(value)))),
    );

    followButton.setAttribute("aria-pressed", String(follow));
    pauseButton.textContent = paused ? "Resume reading" : "Pause";
    pauseButton.disabled = attempts.length === 0;
    if (attempts.length === 0) logStatus.textContent = "Not started.";
    else if (paused) logStatus.textContent = `Paused. Last read at byte ${log.offset}.`;
    else if (run.status === "running" && step.status === "running") logStatus.textContent = `Reading from byte ${log.offset}.`;
    else if (log.truncated) logStatus.textContent = "The server cut its answer at 1 MB; what came after is not shown.";
    else logStatus.textContent = `Read to byte ${log.offset}.`;
  }

  function renderLog(reset: boolean): void {
    const lines = logLines(log);
    if (reset) {
      logLinesNode.replaceChildren();
      shown = 0;
    }
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
      shown = 0;
      return;
    }
    if (shown === 0) logLinesNode.replaceChildren();
    for (const line of lines.slice(shown)) {
      logLinesNode.append(
        el(
          "li",
          { class: "log__line" },
          el("span", { class: "log__offset" }, String(line.offset)),
          el("span", { class: "log__text" }, line.text === "" ? " " : line.text),
        ),
      );
    }
    shown = lines.length;
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
    selected = stepId;
    const attempts = attemptsOf(run, stepId);
    const newest = attempts.at(-1) ?? 0;
    if (newest !== attempt) {
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

  async function readLog(reset: boolean): Promise<void> {
    if (paused || attempt === 0) return;
    try {
      const chunk: LogChunk = await api.log(run.id, selected, attempt, reset ? 0 : log.offset);
      if (signal.aborted) return;
      log = feedLog(reset ? emptyLog : log, chunk);
      renderLog(reset);
    } catch (error) {
      if (signal.aborted) return;
      // A log that is not there is an honest empty pane, not a stack of banners.
      if (error instanceof ApiError && (error.code === "attempt_not_found" || error.code === "step_not_found")) {
        log = emptyLog;
        renderLog(true);
        return;
      }
      logStatus.textContent = error instanceof ApiError ? `${error.code}: ${error.message}` : String(error);
    }
  }

  async function act(kind: "cancel" | "retry" | "resume"): Promise<void> {
    busy = true;
    renderHead();
    try {
      const next = kind === "cancel" ? await api.cancelRun(run.id) : kind === "retry" ? await api.retryRun(run.id) : await api.resumeRun(run.id);
      run = next;
      announce(`${run.id} ${kind} requested.`);
      if (kind === "retry") {
        log = emptyLog;
        shown = 0;
        follow = true;
      }
      renderHead();
      renderSteps();
      renderPanel();
      startPolling();
    } catch (error) {
      // run_not_active, run_claimed, run_not_retryable: the server's own words, on the run's own page.
      alarm.hidden = false;
      alarm.replaceChildren(
        el("h2", { class: "h2", id: "alarm-title" }, `${kind} refused`),
        errorBox(error instanceof ApiError ? error : { code: "internal_error", message: String(error) }),
      );
    } finally {
      busy = false;
      renderHead();
    }
  }

  async function tick(): Promise<void> {
    if (signal.aborted) return;
    let changed: string[] = [];
    try {
      const next = await api.run(run.id);
      if (signal.aborted) return;
      changed = stateChanged(run, next);
      run = next;
    } catch (error) {
      if (error instanceof ApiError) logStatus.textContent = `${error.code}: ${error.message}`;
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
      timer = window.setTimeout(() => void tick(), POLL_MS);
    } else {
      // One last read so the tail of the log is on screen, then the polling stops for good.
      await readLog(false);
    }
  }

  function startPolling(): void {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => void tick(), POLL_MS);
  }

  renderHead();
  renderSteps();
  renderPanel();
  renderLog(true);
  await readLog(true);
  if (signal.aborted) return;
  if (run.status === "running") startPolling();
  else void readLog(false);
}
