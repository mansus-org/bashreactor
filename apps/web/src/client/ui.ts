// The components every screen is made of. A screen arranges these; it does not restyle one or invent
// a second version of one. The doc comment on each export is the whole of the contract another screen
// needs: what it is for and how it is called.

import { clearAttribute, el, errorBox, flash, insertNode, removeNode, restamp, sign } from "./dom.js";
import type { Child } from "./dom.js";
import { state as stateOf } from "./run-shared.js";
import type { RunSummary } from "./api.js";

const SVG = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

// ---------- formatters ----------

const DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const EXACT = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const COUNT = new Intl.NumberFormat();
const pad = (n: number): string => String(n).padStart(2, "0");

/** A stored instant as `just now`, `45 s ago`, `3 min ago`, `2 h ago`, `4 d ago`, then `5 Nov`. */
export function relativeTime(iso: string, now: number | Date = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const current = now instanceof Date ? now.getTime() : now;
  const seconds = Math.max(0, Math.floor((current - at) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  const days = Math.floor(seconds / 86_400);
  if (days <= 7) return `${days} d ago`;
  return DATE.format(new Date(at));
}

/** The reader's own clock, to the second: `5 Nov 2026, 21:12:58`. */
export function exactTime(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? "" : EXACT.format(new Date(at));
}

/** A duration in milliseconds: `<1 s`, `12 s`, `4 m 05 s`, `1 h 02 m`, `2 d 03 h`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 1) return "<1 s";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d} d ${pad(h)} h`;
  if (h > 0) return `${h} h ${pad(m)} m`;
  if (m > 0) return `${m} m ${pad(s)} s`;
  return `${s} s`;
}

/** Bytes in base 1024: `834 B`, `1.6 KB`, `12 MB`, `1.2 GB`, one decimal under 10. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "";
  let value = Math.max(0, n);
  if (value < 1024) return `${Math.floor(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value < 10 ? value.toFixed(1) : value.toFixed(0)} ${units[unit]}`;
}

/** Counts with the reader's grouping: `1,204`. */
export function formatCount(n: number): string {
  return COUNT.format(n);
}

// ---------- page header and controls ----------

export interface Crumb {
  label: string;
  href?: string;
  /** The final crumb is an id or a version: it is set in the code face. */
  mono?: boolean;
}

export interface PageIdLine {
  id: string;
  href?: string;
  stamps?: Child[];
}

export interface PageHeaderOptions {
  crumbs?: (Crumb | string)[];
  title: string;
  actions?: Child[];
  idLine?: string | PageIdLine;
  meta?: [string, Child][];
}

/**
 * The one header a screen has: breadcrumbs, the Anybody title, actions on the same row, then the id
 * with its stamps and a meta line. `idLine` may be a string, or `{ id, href?, stamps? }` when a run or
 * pipeline adds its state next to the id. `meta` is `[label, value]` pairs, separated by ` · `.
 */
export function pageHeader(options: PageHeaderOptions): HTMLElement {
  const crumbs = options.crumbs ?? [];
  const crumbLine =
    crumbs.length === 0
      ? null
      : el(
          "nav",
          { class: "crumbs", "aria-label": "Breadcrumb" },
          ...crumbs.flatMap((entry, index) => {
            const crumb = typeof entry === "string" ? { label: entry } : entry;
            const current = index === crumbs.length - 1;
            const node =
              current || crumb.href === undefined
                ? el("span", { class: `crumbs__current${crumb.mono === true ? " mono" : ""}` }, crumb.label)
                : el("a", { class: crumb.mono === true ? "mono" : "", href: crumb.href, "data-link": "" }, crumb.label);
            return index === 0 ? [node] : [" / ", node];
          }),
        );

  const idLine =
    options.idLine === undefined
      ? null
      : typeof options.idLine === "string"
        ? el("p", { class: "id-line" }, el("code", { class: "mono" }, options.idLine))
        : el(
            "p",
            { class: "id-line" },
            options.idLine.href === undefined
              ? el("code", { class: "mono" }, options.idLine.id)
              : el("a", { class: "mono", href: options.idLine.href, "data-link": "" }, options.idLine.id),
            options.idLine.stamps ?? [],
          );

  const meta =
    options.meta === undefined || options.meta.length === 0
      ? null
      : el(
          "p",
          { class: "meta-line" },
          ...options.meta.flatMap(([label, value], index) => [
            index === 0 ? null : el("span", { class: "meta-line__sep" }, " · "),
            el("span", { class: "meta-line__label" }, label),
            " ",
            el("span", { class: "meta-line__value" }, value),
          ]),
        );

  return el(
    "header",
    { class: "page-header" },
    crumbLine,
    el(
      "div",
      { class: "page-header__title-row" },
      el("h1", { class: "title" }, options.title),
      options.actions === undefined || options.actions.length === 0
        ? null
        : el("div", { class: "page-header__actions" }, options.actions),
    ),
    idLine,
    meta,
  );
}

export interface ButtonOptions {
  primary?: boolean;
  disabled?: boolean;
  /** Written beside a switched-off control, in one 14 px line. */
  disabledReason?: string;
  type?: "button" | "submit";
  onClick?: (event: MouseEvent) => void;
  id?: string;
  title?: string;
  ariaLabel?: string;
}

/**
 * A button at `--control-h`. `primary` makes it ink; `disabledReason` switches it off and returns a
 * wrapper with that reason beside it. A plain button is the button itself, so a caller can keep a
 * reference to it. A disabled control is never grey: it keeps ink, gets a dashed rule and a faint tone.
 */
export function button(label: string, options: ButtonOptions = {}): HTMLElement {
  const disabled = options.disabled === true || options.disabledReason !== undefined;
  const node = el(
    "button",
    {
      class: `btn${options.primary === true ? " btn--ink" : ""}`,
      type: options.type ?? "button",
      disabled: disabled || false,
      id: options.id,
      title: options.title,
      "aria-label": options.ariaLabel,
      onclick: options.onClick as ((event: Event) => void) | undefined,
    },
    label,
  );
  if (options.disabledReason === undefined) return node;
  return el("span", { class: "control-off" }, node, el("span", { class: "control-off__reason" }, options.disabledReason));
}

export interface LinkButtonOptions {
  primary?: boolean;
  title?: string;
  ariaLabel?: string;
  /** True for an address inside the app, so the router handles it without a full page load. */
  dataLink?: boolean;
}

/** The same shape as `button`, for a real link. There is no button that navigates. */
export function linkButton(label: string, href: string, options: LinkButtonOptions = {}): HTMLAnchorElement {
  return el(
    "a",
    {
      class: `btn${options.primary === true ? " btn--ink" : ""}`,
      href,
      title: options.title,
      "aria-label": options.ariaLabel,
      "data-link": options.dataLink === false ? null : "",
    },
    label,
  );
}

export interface SegmentedOption {
  value: string;
  label: string;
  sign?: string;
}

/**
 * A radio group drawn as joined buttons, for time windows and attempt switchers. Arrow keys move and
 * choose inside it; `onChange` gets the newly chosen value. `name` is its accessible label.
 */
export function segmented(
  name: string,
  options: (string | SegmentedOption)[],
  value: string,
  onChange: (value: string) => void,
): HTMLElement {
  const entries = options.map((entry) => (typeof entry === "string" ? { value: entry, label: entry } : entry));
  const root = el("div", { class: "segmented", role: "radiogroup", "aria-label": name });
  let selected = value;
  const buttons: HTMLButtonElement[] = [];
  const paint = (): void => {
    buttons.forEach((node) => {
      const on = node.dataset.value === selected;
      node.setAttribute("aria-checked", on ? "true" : "false");
      node.tabIndex = on ? 0 : -1;
    });
  };
  const choose = (next: string): void => {
    if (next === selected) return;
    selected = next;
    paint();
    onChange(next);
  };
  entries.forEach((entry, index) => {
    const node = el(
      "button",
      {
        class: "segmented__btn",
        type: "button",
        role: "radio",
        "aria-checked": "false",
        "data-value": entry.value,
        tabindex: "-1",
        onclick: () => choose(entry.value),
      },
      entry.sign === undefined ? null : sign(stateOf(entry.sign)),
      entry.label,
    );
    node.dataset.value = entry.value;
    node.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
      let at = index;
      if (key === "Home") at = 0;
      else if (key === "End") at = entries.length - 1;
      else if (step !== 0) at = (index + step + entries.length) % entries.length;
      else return;
      (event as KeyboardEvent).preventDefault();
      buttons[at]?.focus();
      choose(entries[at]!.value);
    });
    buttons.push(node);
    root.append(node);
  });
  paint();
  return root;
}

/**
 * The multi-status filter: a toggle button per status, `aria-pressed` on when selected, drawn like a
 * stamp. `onChange` receives the selected statuses in the order the caller listed them.
 */
export function filterChips(
  statuses: string[],
  selected: readonly string[],
  onChange: (selected: string[]) => void,
): HTMLElement {
  const chosen = new Set(selected);
  const root = el("div", { class: "filter-chips", role: "group", "aria-label": "Status" });
  for (const status of statuses) {
    const node = el(
      "button",
      {
        class: "chip",
        type: "button",
        "aria-pressed": chosen.has(status) ? "true" : "false",
        "data-status": status,
        onclick: () => {
          if (chosen.has(status)) chosen.delete(status);
          else chosen.add(status);
          node.setAttribute("aria-pressed", chosen.has(status) ? "true" : "false");
          onChange(statuses.filter((entry) => chosen.has(entry)));
        },
      },
      sign(stateOf(status)),
      status,
    );
    root.append(node);
  }
  return root;
}

export interface TabItem {
  id: string;
  label: string;
  panel: Child;
}

let tabCount = 0;
const tabPrefix = (): string => `tabs-${++tabCount}`;

/**
 * A tablist on an ink rule, with its panels. Left/Right/Home/End move and choose; the panel with the
 * selected id is the only one shown. `onSelect` is called with the tab id after the screen changes.
 * Keep the selected id in `?tab=` with `readTab`/`writeTab`, so a reload and Back keep it.
 */
export function tabs(list: TabItem[], selected: string, onSelect: (id: string) => void): HTMLElement {
  const prefix = tabPrefix();
  const tablist = el("div", { class: "tabs__list", role: "tablist" });
  const panels = el("div", { class: "tabs__panels" });
  const buttons: HTMLButtonElement[] = [];
  const roots: HTMLElement[] = [];
  let current = list.some((entry) => entry.id === selected) ? selected : (list[0]?.id ?? "");
  const paint = (): void => {
    list.forEach((entry, index) => {
      const on = entry.id === current;
      buttons[index]!.setAttribute("aria-selected", on ? "true" : "false");
      buttons[index]!.tabIndex = on ? 0 : -1;
      roots[index]!.hidden = !on;
    });
  };
  const choose = (id: string): void => {
    if (id === current) return;
    current = id;
    paint();
    onSelect(id);
  };
  list.forEach((entry, index) => {
    const node = el(
      "button",
      {
        class: "tab",
        type: "button",
        role: "tab",
        id: `${prefix}-tab-${entry.id}`,
        "aria-controls": `${prefix}-panel-${entry.id}`,
        "aria-selected": "false",
        tabindex: "-1",
        onclick: () => choose(entry.id),
      },
      entry.label,
    );
    node.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      let at = index;
      if (key === "ArrowRight") at = (index + 1) % list.length;
      else if (key === "ArrowLeft") at = (index - 1 + list.length) % list.length;
      else if (key === "Home") at = 0;
      else if (key === "End") at = list.length - 1;
      else return;
      (event as KeyboardEvent).preventDefault();
      buttons[at]?.focus();
      choose(list[at]!.id);
    });
    const panel = el(
      "section",
      {
        class: "tabpanel",
        role: "tabpanel",
        id: `${prefix}-panel-${entry.id}`,
        "aria-labelledby": `${prefix}-tab-${entry.id}`,
        tabindex: "0",
      },
      entry.panel,
    );
    buttons.push(node);
    roots.push(panel);
    tablist.append(node);
    panels.append(panel);
  });
  tablist.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Escape") (event.target as HTMLElement).blur();
  });
  paint();
  return el("div", { class: "tabs" }, tablist, panels);
}

/** The tab id in `?tab=`, or `fallback` when the address has none. */
export function readTab(fallback = "logs"): string {
  return new URL(location.href).searchParams.get("tab") ?? fallback;
}

/** Put the tab id in `?tab=` without a history entry, so Back leaves the screen rather than a tab. */
export function writeTab(tab: string): void {
  const url = new URL(location.href);
  url.searchParams.set("tab", tab);
  history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

// ---------- stamps ----------

/** A status as its filled stamp: the 7×7 sign and the word, in paper on ink. */
export function statusStamp(status: string): HTMLElement {
  return el("span", { class: "stamp stamp--status" }, sign(stateOf(status)), status);
}

/** A type as an outlined stamp: a runtime, an input type, or a token's access. */
export function typeStamp(text: string): HTMLElement {
  return el("span", { class: "stamp stamp--type" }, text);
}

// ---------- tables ----------

export interface TableColumn<T> {
  header: string;
  cell: (row: T) => Child;
  align?: "left" | "right";
  /** The label used in the stacked phone layout; `header` when it is not given. */
  label?: string;
}

export interface TableOptions<T> {
  empty?: string;
  emptyAction?: Child;
  /** A row that opens something: the first cell's content becomes the one stretched link. */
  rowHref?: (row: T) => string | null | undefined;
}

/**
 * The workhorse table. Columns carry a header, a cell renderer, an alignment and the label used in
 * the stacked layout below 640 px. A row can be a link with `rowHref`; the first cell holds the one
 * real link and the row's `::after` stretches it. An empty table is a single sentence and one action.
 */
export function table<T>(columns: TableColumn<T>[], rows: T[], options: TableOptions<T> = {}): HTMLElement {
  const head = el("thead", {}, el("tr", {}, ...columns.map((column) => el("th", { scope: "col", class: column.align === "right" ? "num" : "" }, column.header))));
  const body = el("tbody");
  if (rows.length === 0) {
    body.append(
      el(
        "tr",
        { class: "table__empty" },
        el("td", { colspan: String(columns.length) }, el("span", { class: "table__empty-text" }, options.empty ?? "Nothing here yet."), options.emptyAction ?? null),
      ),
    );
  } else {
    for (const row of rows) {
      const href = options.rowHref?.(row) ?? null;
      const tr = el("tr", { class: href === null ? "" : "table__row--link" });
      columns.forEach((column, index) => {
        const content = column.cell(row);
        const td = el("td", {
          "data-label": column.label ?? column.header,
          class: column.align === "right" ? "num" : "",
        });
        const holder = el("span", { class: "table__cell" }, content);
        if (index === 0 && href !== null) {
          const isLink =
            typeof content === "object" &&
            content !== null &&
            !Array.isArray(content) &&
            "tagName" in content &&
            (content as { tagName?: string }).tagName === "A";
          td.append(isLink ? holder : el("a", { class: "table__link table__link--name", href, "data-link": "" }, holder));
        } else {
          td.append(holder);
        }
        tr.append(td);
      });
      body.append(tr);
    }
  }
  return el("div", { class: "table-wrap" }, el("table", { class: "table" }, head, body));
}

export type RunColumn = "status" | "run" | "pipeline" | "version" | "started" | "duration" | "steps";

export interface RunsTableOptions {
  columns?: RunColumn[];
  empty?: string;
  emptyAction?: Child;
  /** A Retry button in the row, for a token that can write. */
  retry?: boolean;
  onRetry?: (run: RunSummary) => void;
}

const RUN_COLUMNS: Record<RunColumn, string> = {
  status: "Status",
  run: "Run",
  pipeline: "Pipeline",
  version: "Version",
  started: "Started",
  duration: "Duration",
  steps: "Steps",
};

interface RunRow {
  row: HTMLTableRowElement;
  status: string;
  cells: Partial<Record<RunColumn | "retry", HTMLTableCellElement>>;
  stamp: HTMLElement;
  runLink: HTMLAnchorElement;
  pipelineLink: HTMLAnchorElement;
  version: HTMLElement;
  started: HTMLTimeElement;
  duration: HTMLElement;
  steps: HTMLElement;
  retry: HTMLElement | null;
}

/**
 * The one way a list of runs is shown: Status, Run, Pipeline, Version, Started, Duration, Steps.
 * `columns` selects from that set; `retry` adds the per-row Retry button and `onRetry` is called with
 * the run. It returns `{ node, update }`; `update` is keyed by run id, inserts new rows in order and
 * patches existing ones in place, so a poll does not drop focus or the scroll position. A row whose
 * status changed flashes once.
 */
export function runsTable(options: RunsTableOptions = {}): { node: HTMLElement; update: (runs: RunSummary[]) => void } {
  const columns = options.columns ?? (Object.keys(RUN_COLUMNS) as RunColumn[]);
  const head = el(
    "thead",
    {},
    el(
      "tr",
      {},
      ...columns.map((column) => el("th", { scope: "col", class: column === "duration" || column === "steps" ? "num" : "" }, RUN_COLUMNS[column])),
      options.retry === true ? el("th", { scope: "col" }, el("span", { class: "sr" }, "Actions")) : null,
    ),
  );
  const body = el("tbody");
  const wrap = el("div", { class: "table-wrap" }, el("table", { class: "table runstable" }, head, body));
  const rows = new Map<string, RunRow>();
  let initialized = false;

  function emptyRow(): void {
    body.replaceChildren(
      el(
        "tr",
        { class: "table__empty" },
        el(
          "td",
          { colspan: String(columns.length + (options.retry === true ? 1 : 0)) },
          el("span", { class: "table__empty-text" }, options.empty ?? "No runs."),
          options.emptyAction ?? null,
        ),
      ),
    );
  }

  function makeRow(run: RunSummary): RunRow {
    const stamp = el("span", { class: "stamp stamp--status" });
    const runLink = el("a", { class: "table__link table__link--id", href: `/app/runs/${run.id}`, "data-link": "" }, run.id);
    const pipelineLink = el("a", { href: `/app/pipelines/${run.pipeline}`, "data-link": "" }, run.pipeline);
    const version = el("span", { class: "mono" });
    const started = el("time");
    const duration = el("span", { class: "num" });
    const steps = el("span", { class: "num" });
    const row = el("tr", { class: "table__row--link" });
    const cells: RunRow["cells"] = {};
    columns.forEach((column, index) => {
      const content =
        column === "status"
          ? stamp
          : column === "run"
            ? runLink
            : column === "pipeline"
              ? pipelineLink
              : column === "version"
                ? version
                : column === "started"
                  ? started
                  : column === "duration"
                    ? duration
                    : steps;
      const td = el("td", {
        "data-label": RUN_COLUMNS[column],
        class: column === "duration" || column === "steps" ? "num" : "",
      });
      td.append(content);
      cells[column] = td;
      row.append(td);
      if (index === 0 && column !== "run") row.classList.add("table__row--link");
    });
    let retry: HTMLElement | null = null;
    if (options.retry === true) {
      retry = el(
        "button",
        {
          class: "btn btn--small",
          type: "button",
          onclick: () => options.onRetry?.(run),
        },
        "Retry",
      );
      const td = el("td", { "data-label": "Actions", class: "num" }, retry);
      cells.retry = td;
      row.append(td);
    }
    return { row, status: run.status, cells, stamp, runLink, pipelineLink, version, started, duration, steps, retry };
  }

  // A fresh row is stamped whenever it appears, not only on the first update: the runs that matter most
  // are the ones that start while the reader watches, and they arrive after the table was first drawn.
  function paint(parts: RunRow, run: RunSummary, fresh: boolean): void {
    if (fresh || parts.status !== run.status) {
      restamp(parts.stamp, stateOf(run.status));
      if (!fresh) flash(parts.row);
      parts.status = run.status;
    }
    parts.runLink.textContent = run.id;
    parts.runLink.setAttribute("href", `/app/runs/${run.id}`);
    parts.pipelineLink.textContent = run.pipeline;
    parts.pipelineLink.setAttribute("href", `/app/pipelines/${run.pipeline}`);
    parts.version.textContent = run.pipeline_version === null || run.pipeline_version === undefined ? "—" : `v${run.pipeline_version}`;
    const exact = exactTime(run.created_at);
    parts.started.textContent = relativeTime(run.created_at);
    parts.started.setAttribute("datetime", run.created_at);
    if (exact !== "") parts.started.setAttribute("title", exact);
    else clearAttribute(parts.started, "title");
    const start = Date.parse(run.created_at);
    const end = run.finished_at === null ? Date.now() : Date.parse(run.finished_at);
    parts.duration.textContent =
      Number.isNaN(start) || Number.isNaN(end) ? "—" : formatDuration(Math.max(0, end - start));
    const counts = run.step_counts;
    if (counts === undefined) {
      parts.steps.textContent = "—";
    } else {
      parts.steps.textContent = `${counts.succeeded} / ${counts.total}${counts.failed > 0 ? ` · ${counts.failed} failed` : ""}`;
    }
    if (parts.retry !== null) {
      parts.retry.hidden = run.status !== "failed" && run.status !== "cancelled";
    }
  }

  function place(row: HTMLTableRowElement, index: number): void {
    if (body.children[index] === row) return;
    insertNode(body, row, body.children[index] ?? null);
  }

  function update(runs: RunSummary[]): void {
    if (runs.length === 0) {
      emptyRow();
    } else if (body.querySelector(".table__empty") !== null) {
      body.replaceChildren();
    }
    runs.forEach((run, index) => {
      let parts = rows.get(run.id);
      const fresh = parts === undefined;
      if (parts === undefined) {
        parts = makeRow(run);
        rows.set(run.id, parts);
      }
      paint(parts, run, fresh);
      place(parts.row, index);
      if (fresh && initialized) flash(parts.row);
    });
    const present = new Set(runs.map((run) => run.id));
    for (const [id, parts] of rows) {
      if (present.has(id)) continue;
      removeNode(parts.row);
      rows.delete(id);
    }
    initialized = true;
  }

  emptyRow();
  return { node: wrap, update };
}

/**
 * The last `limit` runs of something, newest on the right. Every sign links to its run and carries a
 * title of the id, the status and how long ago it was, so the strip is readable without its word.
 */
export function historyStrip(runs: RunSummary[], options: { limit?: number } = {}): HTMLElement {
  const limit = options.limit ?? 10;
  const shown = [...runs].toSorted((a, b) => a.id.localeCompare(b.id)).slice(-limit);
  return el(
    "ol",
    { class: "history-strip", "aria-label": "Recent runs" },
    ...shown.map((run) => {
      const label = `${run.id} · ${run.status} · ${relativeTime(run.created_at)}`;
      return el(
        "li",
        {},
        el(
          "a",
          {
            class: "history-strip__link",
            href: `/app/runs/${run.id}`,
            "data-link": "",
            title: label,
            "aria-label": label,
          },
          sign(stateOf(run.status)),
        ),
      );
    }),
  );
}

/** The thing that needs an answer now: a sign, a bold lead, the sentence, then its actions. */
export function alarm(options: { status: string; lead: Child; text?: Child; actions?: Child[] }): HTMLElement {
  return el(
    "section",
    { class: "alarm", role: "alert" },
    sign(stateOf(options.status)),
    el("p", { class: "alarm__text" }, el("strong", {}, options.lead), options.text === undefined ? null : [" ", options.text]),
    options.actions === undefined || options.actions.length === 0 ? null : el("div", { class: "alarm__actions" }, options.actions),
  );
}

/** A 160 × 10 px ink frame filled to `fraction`, with a label beside it. */
export function meter(fraction: number, label: Child): HTMLElement {
  const value = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const graphic = svg("svg", {
    class: "meter__bar",
    viewBox: "0 0 160 10",
    width: 160,
    height: 10,
    "shape-rendering": "crispEdges",
    "aria-hidden": "true",
    focusable: "false",
  });
  graphic.append(svg("rect", { x: 0.5, y: 0.5, width: 159, height: 9, fill: "none", stroke: "currentColor" }));
  if (value > 0) graphic.append(svg("rect", { x: 1, y: 1, width: (158 * value).toFixed(2), height: 8, fill: "currentColor" }));
  return el("span", { class: "meter" }, graphic, el("span", { class: "meter__label" }, label));
}

/** A native dialog with at most one help line. Resolves true for the confirm action, false otherwise. */
export function confirmDialog(options: { title: string; text?: string; confirmLabel: string }): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(answer);
      if (dialog.open) dialog.close(answer ? "confirm" : "cancel");
      removeNode(dialog);
    };
    const dialog = el(
      "dialog",
      { class: "dialog" },
      el(
        "div",
        { class: "dialog__body" },
        el("h2", { class: "dialog__title" }, options.title),
        options.text === undefined ? null : el("p", { class: "dialog__help" }, options.text),
        el(
          "div",
          { class: "dialog__actions" },
          el("button", { class: "btn", type: "button", onclick: () => finish(false) }, "Cancel"),
          el("button", { class: "btn btn--ink", type: "button", onclick: () => finish(true) }, options.confirmLabel),
        ),
      ),
    );
    dialog.addEventListener("close", () => finish(dialog.returnValue === "confirm"));
    document.body.append(dialog);
    dialog.showModal();
  });
}

let dialogCount = 0;

export interface DialogOptions {
  title: Child;
  body?: Child;
  /** Called once, however the dialog was closed. */
  onClose?: () => void;
  /** Return false to keep Escape from taking the dialog away while it is busy. */
  canDismiss?: () => boolean;
}

export interface DialogHandle {
  node: HTMLDialogElement;
  body: HTMLElement;
  title: HTMLElement;
  setTitle(title: Child): void;
  setBody(...children: Child[]): void;
  close(): void;
}

/**
 * A modal dialog with a title and a body the caller can replace, for a screen whose dialog has more
 * than one face. It is appended and opened at once; `close` removes it and calls `onClose` exactly
 * once, whether it was closed from a button or with Escape.
 */
export function dialog(options: DialogOptions): DialogHandle {
  const id = `dialog-title-${++dialogCount}`;
  const title = el("h2", { class: "dialog__title", id }, options.title);
  const body = el("div", { class: "dialog__body" }, title, options.body ?? null);
  const node = el("dialog", { class: "dialog", "aria-labelledby": id }, body);
  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (node.open) node.close();
    removeNode(node);
    options.onClose?.();
  };
  node.addEventListener("close", finish);
  node.addEventListener("cancel", (event) => {
    if (options.canDismiss?.() === false) event.preventDefault();
  });
  const handle: DialogHandle = {
    node,
    body,
    title,
    setTitle(next) {
      title.replaceChildren(next);
    },
    setBody(...children) {
      body.replaceChildren(title, ...children);
    },
    close: finish,
  };
  document.body.append(node);
  node.showModal();
  return handle;
}

/** One 15 px sentence and, at most, one action. */
export function emptyState(text: string, action?: Child): HTMLElement {
  return el("section", { class: "empty-state" }, el("p", {}, text), action ?? null);
}

/** Read-only code with a line-number gutter. Long lines scroll inside the pane, not the page. */
export function codeView(text: string, options: { lineNumbers?: boolean } = {}): HTMLElement {
  const lines = text === "" ? [""] : text.replace(/\n$/, "").split("\n");
  const code = el("pre", { class: "codeview__code" }, text);
  if (options.lineNumbers === false) return el("div", { class: "codeview codeview--plain" }, code);
  return el(
    "div",
    { class: "codeview" },
    el("pre", { class: "codeview__gutter", "aria-hidden": "true" }, lines.map((_, index) => String(index + 1)).join("\n")),
    code,
  );
}

// ---------- charts ----------

/** The SVG `<pattern>` definitions for the status tones. Append them once per chart. */
export function tonePatterns(): SVGDefsElement {
  const defs = svg("defs", { class: "tone-defs" });
  const pattern = (name: string, size: number, draw: (node: SVGPatternElement) => void): void => {
    const node = svg("pattern", {
      id: `tone-${name}`,
      width: size,
      height: size,
      patternUnits: "userSpaceOnUse",
      "shape-rendering": "crispEdges",
    });
    draw(node);
    defs.append(node);
  };
  pattern("checker", 4, (node) => {
    node.append(
      svg("rect", { width: 2, height: 2, fill: "#141414" }),
      svg("rect", { x: 2, y: 2, width: 2, height: 2, fill: "#141414" }),
    );
  });
  pattern("crosshatch", 4, (node) => {
    node.append(svg("path", { d: "M0 0L4 4M4 0L0 4", fill: "none", stroke: "#141414", "stroke-width": 1 }));
  });
  pattern("hatch", 4, (node) => {
    node.append(svg("path", { d: "M0 4L4 0", fill: "none", stroke: "#141414", "stroke-width": 1 }));
  });
  pattern("sparse", 4, (node) => {
    node.append(svg("rect", { width: 2, height: 2, fill: "#141414" }));
  });
  return defs;
}

export interface BarSegment {
  status: string;
  value: number;
}

export interface Bar {
  key: string;
  label: string;
  title: string;
  href?: string;
  segments: BarSegment[];
}

export interface BarChartOptions {
  bars: Bar[];
  height?: number;
  yLabel?: string;
  yFormat?: (value: number) => string;
  /** Set false to leave the legend off. The hidden table is always there. */
  legend?: boolean;
}

/** The fill for a bar segment, from the same tones the signs use. */
function segmentFill(status: string): { fill: string; stroke: string | null; dash: string | null } {
  switch (status) {
    case "succeeded":
      return { fill: "currentColor", stroke: null, dash: null };
    case "running":
      return { fill: "url(#tone-checker)", stroke: "currentColor", dash: null };
    case "failed":
      return { fill: "url(#tone-crosshatch)", stroke: "currentColor", dash: null };
    case "cancelled":
      return { fill: "url(#tone-hatch)", stroke: "currentColor", dash: null };
    case "interrupted":
      return { fill: "url(#tone-sparse)", stroke: "currentColor", dash: null };
    case "waiting_retry":
      return { fill: "none", stroke: "currentColor", dash: "2 2" };
    default:
      return { fill: "none", stroke: null, dash: null };
  }
}

const CHART_TONES = ["succeeded", "running", "failed", "cancelled", "interrupted", "waiting_retry"];
/** The four states a run can be in, whether or not this window has one in it. */
const CHART_LEGEND = ["succeeded", "running", "failed", "cancelled"] as const;

/**
 * Inline SVG bars, stacked from the baseline in the order each bar's segments are given. Each bar is a
 * `<g>` with a `<title>`; a bar with `href` is a link. `yFormat` formats the three y ticks, and the
 * numbers are repeated in a visually hidden table. `height` is the whole chart's height.
 */
export function barChart(options: BarChartOptions): HTMLElement {
  const bars = options.bars;
  const height = options.height ?? 160;
  const width = 720;
  const left = 48;
  const right = 8;
  const top = 8;
  const bottom = 22;
  const plotWidth = Math.max(1, width - left - right);
  const plotHeight = Math.max(1, height - top - bottom);
  const yFormat = options.yFormat ?? formatCount;
  const totals = bars.map((bar) => bar.segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0));
  const max = Math.max(1, ...totals);
  const present = CHART_TONES.filter((status) => bars.some((bar) => bar.segments.some((segment) => segment.status === status && segment.value > 0)));

  const graphic = svg("svg", {
    class: "chart__svg",
    viewBox: `0 0 ${width} ${height}`,
    width: "100%",
    height,
    role: "img",
    "aria-label": options.yLabel ?? "Chart",
    "shape-rendering": "crispEdges",
  });
  graphic.append(tonePatterns());
  const axis = svg("g", { class: "chart__axis", fill: "currentColor", stroke: "currentColor" });
  axis.append(svg("line", { x1: left, y1: top, x2: left, y2: top + plotHeight, "stroke-width": 1 }));
  axis.append(svg("line", { x1: left, y1: top + plotHeight, x2: left + plotWidth, y2: top + plotHeight, "stroke-width": 1 }));
  const ticks = [...new Set([0, max / 2, max])];
  for (const tick of ticks) {
    const y = top + plotHeight - (tick / max) * plotHeight;
    axis.append(svg("line", { x1: left - 4, y1: y, x2: left, y2: y, "stroke-width": 1 }));
    const label = svg("text", {
      x: left - 8,
      y: y + 4,
      "text-anchor": "end",
      "font-size": 12,
      stroke: "none",
      fill: "currentColor",
    });
    label.textContent = yFormat(tick);
    axis.append(label);
  }
  graphic.append(axis);

  const slot = plotWidth / Math.max(1, bars.length);
  const barWidth = Math.max(2, Math.min(40, slot * 0.72));
  bars.forEach((bar, index) => {
    const x = left + index * slot + (slot - barWidth) / 2;
    const group = svg("g", { class: "chart__bar", "data-key": bar.key });
    const title = svg("title");
    title.textContent = bar.title;
    group.append(title);
    let baseline = top + plotHeight;
    for (const segment of bar.segments) {
      if (segment.value <= 0 || segment.status === "pending" || segment.status === "skipped") continue;
      const segmentHeight = (Math.max(0, segment.value) / max) * plotHeight;
      baseline -= segmentHeight;
      const fill = segmentFill(segment.status);
      group.append(
        svg("rect", {
          x,
          y: baseline,
          width: barWidth,
          height: segmentHeight,
          fill: fill.fill,
          stroke: fill.stroke ?? "none",
          "stroke-width": fill.stroke === null ? 0 : 1,
          ...(fill.dash === null ? {} : { "stroke-dasharray": fill.dash }),
        }),
      );
    }
    if (bar.href !== undefined) {
      group.setAttribute("data-href", bar.href);
      group.setAttribute("role", "link");
      group.setAttribute("tabindex", "0");
      const open = (): void => {
        location.href = bar.href!;
      };
      group.addEventListener("click", open);
      group.addEventListener("keydown", (event) => {
        const key = (event as KeyboardEvent).key;
        if (key === "Enter" || key === " ") {
          (event as KeyboardEvent).preventDefault();
          open();
        }
      });
    }
    graphic.append(group);
  });

  const legend =
    options.legend === false
      ? null
      : el(
          "figcaption",
          { class: "chart__legend" },
          ...CHART_LEGEND.map((status) =>
            el(
              "span",
              { class: `chart__legend-entry chart__legend-entry--${status}` },
              el("span", { class: `swatch swatch--${status}`, "aria-hidden": "true" }),
              sign(stateOf(status)),
              status,
            ),
          ),
        );

  const tableHead = [options.yLabel ?? "Bucket", ...present, "Total"];
  const data = el(
    "table",
    { class: "sr chart__data" },
    el("caption", {}, options.yLabel ?? "Chart data"),
    el("thead", {}, el("tr", {}, ...tableHead.map((head) => el("th", { scope: "col" }, head)))),
    el(
      "tbody",
      {},
      ...bars.map((bar, index) =>
        el(
          "tr",
          {},
          el("th", { scope: "row" }, bar.label),
          ...present.map((status) => el("td", {}, String(bar.segments.find((segment) => segment.status === status)?.value ?? 0))),
          el("td", {}, String(totals[index] ?? 0)),
        ),
      ),
    ),
  );

  return el("figure", { class: "chart" }, graphic, legend, data);
}

/** The honest answer for a screen that its own ticket has not built yet. */
export function notImplemented(view: HTMLElement, screen: string, ticket: string): void {
  view.replaceChildren(
    errorBox(
      { code: "not_implemented", message: `This screen is being redesigned (${ticket}).` },
      el("p", { class: "help" }, `${screen} is not built yet.`),
    ),
  );
}
