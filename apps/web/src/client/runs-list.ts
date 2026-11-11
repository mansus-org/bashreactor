// The Runs list: every run, newest first, cut by status, pipeline and window. The filters live in the
// URL so a reload, a bookmark and the back button all agree with what is on screen. The table itself
// is the shared runs table: a poll patches its rows by run id instead of rebuilding them, so the row
// under the reader's focus stays the row they were on.

import { api } from "./api.js";
import type { RunPage, RunSummary } from "./api.js";
import type { Route } from "./app.js";
import { el, errorBox, restamp } from "./dom.js";
import {
  button,
  filterChips,
  formatCount,
  linkButton,
  pageHeader,
  runsTable,
  segmented,
} from "./ui.js";
import type { RunsTableOptions } from "./ui.js";
import { IDLE_POLL_MS, POLL_MS, errorBody, errorWords, state, wallClock, whenShown } from "./run-shared.js";
import type { Clock } from "./run-shared.js";

const STATUSES = ["running", "succeeded", "failed", "cancelled"] as const;
type Status = (typeof STATUSES)[number];

const WINDOWS = [
  { value: "24h", label: "24 h", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "7 d", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "30 d", ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "all", label: "All", ms: null },
] as const;
type WindowValue = (typeof WINDOWS)[number]["value"];

const COLUMNS = ["status", "run", "pipeline", "version", "started", "duration", "steps"] as const;

interface Filters {
  statuses: Status[];
  pipeline: string | null;
  window: WindowValue;
}

function isWindow(value: string | null): value is WindowValue {
  return WINDOWS.some((entry) => entry.value === value);
}

/**
 * What the address says, with anything this build does not know read as "no such filter". A stale
 * bookmark from another version then shows the list rather than an error, which is the only useful
 * thing an unknown status or window can mean here.
 */
function readFilters(query: URLSearchParams): Filters {
  const wanted = new Set((query.get("status") ?? "").split(",").filter((entry) => entry !== ""));
  const rawWindow = query.get("window");
  const pipeline = query.get("pipeline");
  return {
    statuses: STATUSES.filter((status) => wanted.has(status)),
    pipeline: pipeline === null || pipeline === "" ? null : pipeline,
    window: isWindow(rawWindow) ? rawWindow : "all",
  };
}

function hasFilters(filters: Filters): boolean {
  return filters.statuses.length > 0 || filters.pipeline !== null || filters.window !== "all";
}

function windowMs(window: WindowValue): number | null {
  return WINDOWS.find((entry) => entry.value === window)?.ms ?? null;
}

function queryFor(filters: Filters, clock: Clock): {
  limit: number;
  status?: string[];
  pipeline?: string;
  since?: string;
} {
  const span = windowMs(filters.window);
  return {
    limit: 50,
    status: filters.statuses.length === 0 ? undefined : filters.statuses,
    pipeline: filters.pipeline ?? undefined,
    since: span === null ? undefined : new Date(clock.now() - span).toISOString(),
  };
}

/** Rewrite the address in place: a filter is a change of what is shown, not a place to go back to. */
function writeFilters(filters: Filters): void {
  const url = new URL(location.href);
  if (filters.statuses.length === 0) url.searchParams.delete("status");
  else url.searchParams.set("status", filters.statuses.join(","));
  if (filters.pipeline === null) url.searchParams.delete("pipeline");
  else url.searchParams.set("pipeline", filters.pipeline);
  url.searchParams.set("window", filters.window);
  history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function countLabel(format: (value: number) => string, loaded: number, more: boolean): string {
  if (loaded === 1 && !more) return "1 run";
  return `${format(loaded)}${more ? "+" : ""} runs`;
}

/** The Runs screen. `clock` is the reader's clock, handed in by the test so polling is a count. */
export function renderRunsList(
  view: HTMLElement,
  route: Route,
  signal: AbortSignal,
  clock: Clock = wallClock,
): void {
  const filters = readFilters(route.query);

  const header = pageHeader({ title: "Runs" });
  const filterBar = el("div", { class: "runs-list__filters" });
  const filterHost = el("div", { class: "runs-list__filter-host" }, filterBar);
  const loading = el("p", { class: "runs-list__status", role: "status" }, "Loading the runs.");
  const errorHost = el("div", { class: "runs-list__error", hidden: true });
  const tableHost = el("div");
  const count = el("span", { class: "runs-list__count" });
  const more = button("Load more");
  more.hidden = true;
  const moreWrap = el("div", { class: "runs-list__more" }, more);
  const list = el("div", { class: "runs-list__body", hidden: true }, tableHost, moreWrap);
  view.replaceChildren(header, filterHost, loading, errorHost, list);

  /** The first page and every page Load more appended, kept apart so a poll can refresh page one. */
  const pages: RunSummary[][] = [];
  let next: string | null = null;
  /** A read is in the air. A tab coming back or a timer must not start a second one beside it. */
  let busy = false;
  let timer: (() => void) | null = null;
  /** A filter changed while a read was in the air, so that read's answer must not be painted. */
  let reloadAfter = false;
  let moreWanted = false;
  let generation = 0;
  let pipelineNames: string[] = [];
  let pipelineError: string | null = null;
  let pipelineSelect: HTMLSelectElement | null = null;
  let pipelineNote: HTMLElement | null = null;
  let clearButton: HTMLElement | null = null;
  let table = makeTable();

  function makeTable(): ReturnType<typeof runsTable> {
    const options: RunsTableOptions = {
      columns: [...COLUMNS],
      empty: hasFilters(filters) ? "No runs match these filters." : "No runs yet.",
      emptyAction: hasFilters(filters)
        ? button("Clear filters", { onClick: clearFilters })
        : linkButton("Pipelines", "/app/pipelines"),
    };
    return runsTable(options);
  }

  function fillPipelineSelect(select: HTMLSelectElement): void {
    const names = [...pipelineNames];
    if (filters.pipeline !== null && !names.includes(filters.pipeline)) names.push(filters.pipeline);
    select.replaceChildren(
      el("option", { value: "all" }, "All pipelines"),
      ...names.map((name) => el("option", { value: name }, name)),
    );
    select.value = filters.pipeline ?? "all";
  }

  function buildFilterBar(): void {
    pipelineSelect = el("select", {
      "aria-label": "Pipeline",
      onchange: () => {
        const chosen = pipelineSelect?.value ?? "all";
        filters.pipeline = chosen === "all" || chosen === "" ? null : chosen;
        applyFilters();
      },
    });
    fillPipelineSelect(pipelineSelect);

    pipelineNote = el("p", { class: "runs-list__note", role: "status" });
    pipelineNote.hidden = pipelineError === null;
    if (pipelineError !== null) pipelineNote.textContent = pipelineError;

    clearButton = button("Clear filters", { onClick: clearFilters });
    clearButton.hidden = !hasFilters(filters);

    const windows = segmented(
      "Window",
      WINDOWS.map((entry) => ({ value: entry.value, label: entry.label })),
      filters.window,
      (value) => {
        if (!isWindow(value)) return;
        filters.window = value;
        applyFilters();
      },
    );

    filterBar.replaceChildren(
      el("div", { class: "runs-list__statuses" }, filterChips([...STATUSES], filters.statuses, (selected) => {
        filters.statuses = STATUSES.filter((status) => selected.includes(status));
        applyFilters();
      })),
      el("label", { class: "runs-list__pipeline" }, el("span", { class: "sr" }, "Pipeline"), pipelineSelect),
      windows,
      clearButton,
      count,
      pipelineNote,
    );
    count.hidden = list.hidden;
  }

  function updateClear(): void {
    if (clearButton !== null) clearButton.hidden = !hasFilters(filters);
  }

  function rows(): RunSummary[] {
    const seen = new Set<string>();
    const out: RunSummary[] = [];
    for (const page of pages) {
      for (const run of page) {
        if (seen.has(run.id)) continue;
        seen.add(run.id);
        out.push(run);
      }
    }
    return out;
  }

  /**
   * `runsTable` paints a row it has seen before, but a row that first appears after the table's first
   * update is inserted with an empty status stamp. The list is where new rows appear all the time, so
   * it asks for their stamps here. BASHR-62: candidate for ui.ts, where the paint belongs.
   */
  function paintNewStamps(loaded: RunSummary[]): void {
    const body = table.node.querySelector("tbody");
    if (body === null) return;
    const bodyRows = [...body.querySelectorAll("tr")].filter((row) => !row.classList.contains("table__empty"));
    loaded.forEach((run, index) => {
      const stamp = bodyRows[index]?.querySelector<HTMLElement>(".stamp") ?? null;
      if (stamp !== null && stamp.textContent !== state(run.status)) restamp(stamp, state(run.status));
    });
  }

  function showData(): void {
    const loaded = rows();
    table.update(loaded);
    paintNewStamps(loaded);
    count.textContent = countLabel(formatCount, loaded.length, next !== null);
    count.hidden = false;
    loading.hidden = true;
    errorHost.replaceChildren();
    errorHost.hidden = true;
    list.hidden = false;
    more.hidden = next === null;
  }

  function showError(error: unknown): void {
    // A page that cannot read does not know what the list is any more, so the last good rows are not
    // left under the box pretending to be current.
    errorHost.replaceChildren(errorBox(errorBody(error)));
    errorHost.hidden = false;
    loading.hidden = true;
    count.hidden = true;
    list.hidden = true;
  }

  function stopTimer(): void {
    if (timer === null) return;
    timer();
    timer = null;
  }

  function arm(forceMs?: number): void {
    stopTimer();
    if (signal.aborted || document.hidden) return;
    const busyNow = rows().some((run) => run.status === "running");
    timer = clock.after(forceMs ?? (busyNow ? POLL_MS : IDLE_POLL_MS), () => {
      timer = null;
      void readFirst();
    });
  }

  /** Start the read that was waiting behind this one, if a filter or Load more asked for it. */
  function drain(): boolean {
    if (signal.aborted || document.hidden) {
      reloadAfter = false;
      moreWanted = false;
      return false;
    }
    if (reloadAfter) {
      reloadAfter = false;
      moreWanted = false;
      void readFirst();
      return true;
    }
    if (moreWanted) {
      moreWanted = false;
      void readMore();
      return true;
    }
    return false;
  }

  async function readFirst(): Promise<void> {
    stopTimer();
    if (signal.aborted || document.hidden || busy) return;
    busy = true;
    const mine = generation;
    let page: RunPage | null = null;
    let error: unknown = null;
    try {
      page = await api.listRuns(queryFor(filters, clock));
    } catch (cause) {
      error = cause;
    }
    busy = false;
    if (signal.aborted) return;
    if (mine !== generation) {
      drain();
      return;
    }
    if (page === null) {
      showError(error);
    } else {
      pages[0] = page.runs;
      // Once Load more has added pages, its cursor is the one that leads past what is on screen. A
      // first page that now says there is no next page is still the truth, so it wins.
      if (page.next === null || pages.length === 1) next = page.next;
      showData();
    }
    if (!drain()) arm(page === null ? POLL_MS : undefined);
  }

  async function readMore(): Promise<void> {
    stopTimer();
    if (signal.aborted || document.hidden) return;
    if (busy) {
      moreWanted = true;
      return;
    }
    if (next === null) return;
    busy = true;
    const mine = generation;
    const cursor = next;
    let page: RunPage | null = null;
    let error: unknown = null;
    try {
      page = await api.listRuns({ ...queryFor(filters, clock), cursor });
    } catch (cause) {
      error = cause;
    }
    busy = false;
    if (signal.aborted) return;
    if (mine !== generation) {
      drain();
      return;
    }
    if (page === null) {
      showError(error);
    } else {
      pages.push(page.runs);
      next = page.next;
      showData();
    }
    if (!drain()) arm(page === null ? POLL_MS : undefined);
  }

  function loadMore(): void {
    if (next === null) return;
    if (busy) {
      moreWanted = true;
      return;
    }
    void readMore();
  }

  function applyFilters(): void {
    generation += 1;
    pages.length = 0;
    next = null;
    reloadAfter = false;
    moreWanted = false;
    errorHost.replaceChildren();
    errorHost.hidden = true;
    list.hidden = true;
    loading.hidden = false;
    count.hidden = true;
    table = makeTable();
    tableHost.replaceChildren(table.node);
    updateClear();
    writeFilters(filters);
    if (busy) {
      reloadAfter = true;
      return;
    }
    void readFirst();
  }

  function clearFilters(): void {
    filters.statuses = [];
    filters.pipeline = null;
    filters.window = "all";
    // The chip group keeps its own set of what is pressed, so a cleared filter is a new group. The
    // focus goes to the first chip rather than to the body, because the button that was pressed has
    // just been replaced.
    buildFilterBar();
    applyFilters();
    filterBar.querySelector<HTMLButtonElement>(".chip")?.focus();
  }

  async function readPipelineNames(): Promise<void> {
    try {
      const answer = await api.allPipelines();
      pipelineNames = answer.pipelines.map((entry) => entry.name);
      pipelineError = null;
    } catch (error) {
      pipelineError = errorWords(error);
    }
    if (signal.aborted) return;
    if (pipelineSelect !== null) fillPipelineSelect(pipelineSelect);
    if (pipelineNote !== null) {
      pipelineNote.textContent = pipelineError ?? "";
      pipelineNote.hidden = pipelineError === null;
    }
  }

  more.addEventListener("click", loadMore);
  buildFilterBar();
  tableHost.replaceChildren(table.node);
  whenShown(signal, () => void readFirst());
  signal.addEventListener("abort", stopTimer);
  void readPipelineNames();
  void readFirst();
}
