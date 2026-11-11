// The pipelines list. Each row is a stored pipeline, and its description and runs are read beside the
// row rather than before it, so one slow pipeline cannot hold up the other nineteen.

import { api, ApiError, canWrite } from "./api.js";
import type { LibraryName, RunSummary } from "./api.js";
import { el, errorBox, stateLine } from "./dom.js";
import type { Route } from "./app.js";
import { errorWords } from "./run-shared.js";
import {
  exactTime,
  historyStrip,
  linkButton,
  pageHeader,
  relativeTime,
  statusStamp,
  table,
} from "./ui.js";

interface RowCells {
  description: HTMLElement;
  lastRun: HTMLElement;
  recent: HTMLElement;
}

/**
 * Run `tasks` with at most `width` of them on the wire at once. The API is a local service, but a
 * list of a hundred pipelines still should not open a hundred sockets to draw itself.
 */
async function pool(tasks: (() => Promise<void>)[], width: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const task = tasks[index];
      if (task === undefined) return;
      await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, tasks.length) }, worker));
}

function lastRunCell(runs: RunSummary[]): HTMLElement {
  if (runs.length === 0) return el("span", { class: "pipelines-never" }, "never");
  const run = runs[0]!;
  const exact = exactTime(run.created_at);
  return el(
    "span",
    { class: "pipelines-last" },
    statusStamp(run.status),
    el("time", exact === "" ? {} : { datetime: run.created_at, title: exact }, relativeTime(run.created_at)),
  );
}

export async function renderPipelines(view: HTMLElement, _route: Route, signal: AbortSignal): Promise<void> {
  view.replaceChildren(stateLine("Loading the pipelines."));
  let names: LibraryName[];
  try {
    names = (await api.allPipelines()).pipelines;
  } catch (error) {
    if (signal.aborted) return;
    view.replaceChildren(
      errorBox(error instanceof ApiError ? error : { code: "internal_error", message: String(error) }),
    );
    return;
  }
  if (signal.aborted) return;

  const cells = new Map<string, RowCells>();
  for (const pipeline of names) {
    // The cells are made first and filled when their answer arrives, so the row exists as soon as
    // the names are known and an answer cannot rebuild the row it belongs to.
    cells.set(pipeline.name, {
      description: el("span", { class: "pipelines-pending" }, "…"),
      lastRun: el("span", { class: "pipelines-pending" }, "…"),
      recent: el("span", { class: "pipelines-pending" }, "…"),
    });
  }

  const newPipeline = canWrite() ? linkButton("New pipeline", "/app/pipelines-new", { primary: true }) : null;
  const header = pageHeader({
    title: "Pipelines",
    actions: newPipeline === null ? [] : [newPipeline],
  });

  const list = table<LibraryName>(
    [
      {
        header: "Name",
        cell: (pipeline) =>
          el(
            "a",
            {
              class: "pipelines-name",
              href: `/app/pipelines/${encodeURIComponent(pipeline.name)}`,
              "data-link": "",
            },
            pipeline.name,
          ),
      },
      {
        header: "Description",
        cell: (pipeline) => cells.get(pipeline.name)!.description,
      },
      {
        header: "Latest",
        cell: (pipeline) => el("span", { class: "mono" }, `v${pipeline.latest}`),
      },
      {
        header: "Last run",
        cell: (pipeline) => cells.get(pipeline.name)!.lastRun,
      },
      {
        header: "Recent runs",
        cell: (pipeline) => cells.get(pipeline.name)!.recent,
      },
    ],
    names,
    {
      empty: "No pipelines stored yet.",
      emptyAction: canWrite() ? linkButton("New pipeline", "/app/pipelines-new") : undefined,
    },
  );

  view.replaceChildren(header, el("section", { class: "pipelines-list", "aria-label": "Pipelines" }, list));

  const tasks: (() => Promise<void>)[] = [];
  for (const pipeline of names) {
    const row = cells.get(pipeline.name)!;
    tasks.push(async () => {
      try {
        const version = await api.pipelineVersion(pipeline.name, pipeline.latest);
        row.description.textContent = parsedDescription(version.parsed) || "—";
      } catch (error) {
        row.description.replaceChildren(el("span", { class: "pipelines-cell-error" }, errorWords(error)));
      }
    });
    tasks.push(async () => {
      try {
        const runs = await api.listRuns({ pipeline: pipeline.name, limit: 10 });
        row.lastRun.replaceChildren(lastRunCell(runs.runs));
        row.recent.replaceChildren(historyStrip(runs.runs, { limit: 10 }));
      } catch (error) {
        const words = el("span", { class: "pipelines-cell-error" }, errorWords(error));
        row.lastRun.replaceChildren(words);
        row.recent.replaceChildren(el("span", { class: "pipelines-cell-error" }, errorWords(error)));
      }
    });
  }
  await pool(tasks, 4);
}

/** The description of the stored document, when the API gave a parsed one this build can read. */
function parsedDescription(parsed: unknown): string {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const description = (parsed as { description?: unknown }).description;
  return typeof description === "string" ? description.replace(/\s+/g, " ").trim() : "";
}
