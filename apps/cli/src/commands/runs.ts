// Runs: start one, list them, read one, move one along, and follow a step's log. The API drives a
// run in the background and answers 201 as soon as the run exists (SPEC 4.3), so nothing here waits
// unless the person asked to.

import { parsePipeline } from "@bashreactor/core";
import type { CommandSpec, Ctx } from "../args.ts";
import { usage } from "../errors.ts";
import { elapsed, localTime } from "../output.ts";
import { publishRelativeBlocks, readPipelineFile } from "../local.ts";
import { declaredTypes, readInputs } from "../inputs.ts";
import { INTERVAL_FLAG, VERSION_FLAG, versionOf } from "./flags.ts";
import type { LogChunk, PipelineVersion, RunRecord, RunStatus, RunSummary, StepRecord } from "../types.ts";
import { FINAL_STEP_STATUSES } from "../types.ts";
import type { Printer } from "../output.ts";

const SUMMARY: Record<"cancel" | "retry" | "resume", string> = {
  cancel: "ask for a cancel (SPEC 4.6)",
  retry: "retry a failed or cancelled run from where it stopped",
  resume: "take up a run left `running` by an engine that died",
};

export const runCommands: CommandSpec[] = [
  {
    group: "runs",
    name: "start",
    summary: "start a run of a stored pipeline or of a local file",
    args: [{ name: "<pipeline|file.yaml>" }],
    flags: [
      VERSION_FLAG,
      { name: "input", help: "a run input, as name=value; repeat it", value: "string", repeat: true },
      { name: "wait", help: "stay and poll until the run reaches a final status" },
      INTERVAL_FLAG,
    ],
    run: async (ctx) => {
      const target = ctx.args[0]!;
      const pairs = ctx.many("input");
      const version = versionOf(ctx);
      let body: Record<string, unknown>;
      let label: string;

      if (isFileTarget(target)) {
        if (ctx.flag("version") !== undefined) {
          throw usage(`"--version" chooses a stored pipeline's version; "${target}" is a file`);
        }
        const file = readPipelineFile(target);
        const prepared = await publishRelativeBlocks(ctx.client, file, (line) => ctx.printer.note(line));
        const inputs = readInputs(pairs, declaredTypes(quietlyParse(prepared.source)?.inputs), ctx.cwd);
        body = { yaml: prepared.yaml, inputs };
        label = prepared.path;
      } else {
        if (target.includes("/")) {
          throw usage(
            `"${target}" looks like a path and is not a pipeline name; a pipeline file ends in .yaml or .yml`,
          );
        }
        // The types come from the stored pipeline, so `--input lines=300` is the integer 300 and
        // not a string the engine has to guess at (SPEC 3.3).
        const detail =
          pairs.length === 0 ? undefined : await ctx.client.json<PipelineVersion>("GET", `/v1/pipelines/${encodeURIComponent(target)}/${version}`);
        const inputs = readInputs(pairs, declaredTypes(detail?.parsed?.inputs), ctx.cwd);
        body = { pipeline: target, inputs };
        if (version !== "latest") {
          if (!/^[1-9][0-9]*$/.test(version)) throw usage(`"--version" wants a version number or "latest"`);
          body.version = Number(version);
        }
        label = `${target}@${version}`;
      }

      const run = await ctx.client.json<RunRecord>("POST", "/v1/runs", { body });
      if (!ctx.has("wait")) {
        ctx.printer.emit(run, (p) => {
          renderRun(p, run);
          p.line("");
          p.line(`started ${label}`);
          p.line(`follow it: bashreactor runs logs ${run.id} ${firstStep(run)} --follow`);
        });
        return 0;
      }
      ctx.printer.note(`started ${run.id}; waiting for it`);
      const finished = await waitForRun(ctx, run.id);
      ctx.printer.emit(finished, (p) => renderRun(p, finished));
      return exitForRun(finished.status);
    },
  },
  {
    group: "runs",
    name: "ls",
    summary: "every run, newest first",
    run: async (ctx) => {
      const runs = await ctx.client.json<RunSummary[]>("GET", "/v1/runs");
      ctx.printer.emit(runs, (p) => {
        if (runs.length === 0) {
          p.line("no runs");
          return;
        }
        p.table(
          ["RUN", "PIPELINE", "STATUS", "CREATED", "FINISHED", "TOOK"],
          runs.map((run) => [
            run.id,
            run.pipeline,
            run.status,
            localTime(run.created_at),
            localTime(run.finished_at),
            elapsed(run.created_at, run.finished_at),
          ]),
        );
      });
      return 0;
    },
  },
  {
    group: "runs",
    name: "get",
    summary: "one run, the whole run.json",
    args: [{ name: "<run-id>" }],
    run: async (ctx) => {
      const run = await ctx.client.json<RunRecord>("GET", `/v1/runs/${encodeURIComponent(ctx.args[0]!)}`);
      ctx.printer.emit(run, (p) => renderRun(p, run));
      return 0;
    },
  },
  ...(["cancel", "retry", "resume"] as const).map((verb) => ({
    group: "runs",
    name: verb,
    summary: SUMMARY[verb],
    args: [{ name: "<run-id>" }],
    run: async (ctx: Ctx) => {
      const run = await ctx.client.json<RunRecord>("POST", `/v1/runs/${encodeURIComponent(ctx.args[0]!)}/${verb}`);
      ctx.printer.emit(run, (p) => {
        renderRun(p, run);
        p.line("");
        p.line(`${verb} asked for: ${run.id} is ${run.status}`);
      });
      return 0;
    },
  })),
  {
    group: "runs",
    name: "logs",
    summary: "print a step's log from an offset, and say the next offset",
    args: [{ name: "<run-id>" }, { name: "<step>" }],
    flags: [
      { name: "attempt", help: "which attempt to read (default: the step's last one)", value: "int", min: 1 },
      { name: "offset", help: "byte offset to start at (default 0)", value: "int", min: 0 },
      { name: "follow", help: "keep reading until the step is final, then exit with the run's status" },
      INTERVAL_FLAG,
    ],
    run: async (ctx) => {
      const id = ctx.args[0]!;
      const step = ctx.args[1]!;
      const attempt = ctx.flag("attempt") !== undefined ? Number(ctx.flag("attempt")) : await lastAttempt(ctx, id, step);
      let offset = ctx.int("offset", 0);

      // The log is bytes, written as they are: no newline added, nothing re-read. Under --json the
      // chunk object is the answer instead, and its `text` field holds the same bytes.
      let openLine = false;
      const write = (chunk: LogChunk): void => {
        offset = chunk.next_offset;
        if (ctx.printer.json) {
          ctx.printer.emit(chunk, () => {});
          return;
        }
        if (chunk.text === "") return;
        ctx.io.bytes(new TextEncoder().encode(chunk.text));
        openLine = !chunk.text.endsWith("\n");
      };
      const note = (text: string): void => {
        if (openLine) ctx.io.err("");
        openLine = false;
        ctx.printer.note(text);
      };

      if (!ctx.has("follow")) {
        write(await getLog(ctx, id, step, attempt, offset));
        if (!ctx.printer.json) note(`next offset ${offset}`);
        return 0;
      }

      const interval = ctx.int("interval", 1000);
      for (;;) {
        write(await getLog(ctx, id, step, attempt, offset));
        const run = await ctx.client.json<RunRecord>("GET", `/v1/runs/${encodeURIComponent(id)}`);
        const status = run.steps[step]?.status;
        if (status !== undefined && FINAL_STEP_STATUSES.includes(status)) {
          // Anything written between the two reads is still part of the answer.
          write(await getLog(ctx, id, step, attempt, offset));
          if (!ctx.printer.json) {
            note(`next offset ${offset}`);
            note(`run ${id} ${run.status}`);
          }
          return exitForRun(run.status);
        }
        await Bun.sleep(interval);
      }
    },
  },
];

function isFileTarget(target: string): boolean {
  return /\.(ya?ml)$/i.test(target);
}

/** A file the user pointed at may be anything; a bad one is the API's to complain about, not ours. */
function quietlyParse(source: string) {
  try {
    return parsePipeline(source);
  } catch {
    return null;
  }
}

function firstStep(run: RunRecord): string {
  return Object.keys(run.steps)[0] ?? "<step>";
}

/** A run that is still going is not a failure; one that ended badly is, whatever the HTTP said. */
function exitForRun(status: RunStatus): number {
  return status === "failed" || status === "cancelled" ? 1 : 0;
}

async function waitForRun(ctx: Ctx, id: string): Promise<RunRecord> {
  const interval = ctx.int("interval", 1000);
  let run = await ctx.client.json<RunRecord>("GET", `/v1/runs/${encodeURIComponent(id)}`);
  while (run.status === "running") {
    await Bun.sleep(interval);
    run = await ctx.client.json<RunRecord>("GET", `/v1/runs/${encodeURIComponent(id)}`);
  }
  return run;
}

async function getLog(
  ctx: Ctx,
  id: string,
  step: string,
  attempt: number,
  offset: number,
): Promise<LogChunk> {
  return await ctx.client.json<LogChunk>(
    "GET",
    `/v1/runs/${encodeURIComponent(id)}/logs/${encodeURIComponent(step)}/${attempt}`,
    { query: { offset } },
  );
}

/** `--attempt` is there for the old ones; the interesting default is the attempt running now. */
async function lastAttempt(
  ctx: Ctx,
  id: string,
  step: string,
): Promise<number> {
  const run = await ctx.client.json<RunRecord>("GET", `/v1/runs/${encodeURIComponent(id)}`);
  const record: StepRecord | undefined = run.steps[step];
  return record?.attempts[record.attempts.length - 1]?.n ?? 1;
}

function renderRun(p: Printer, run: RunRecord): void {
  p.fields([
    ["run", run.id],
    ["pipeline", run.pipeline],
    ["status", run.status],
    ["created", localTime(run.created_at)],
    ["finished", localTime(run.finished_at)],
    ["took", elapsed(run.created_at, run.finished_at)],
  ]);
  if (run.cancel_requested_at !== null) p.fields([["cancel requested", localTime(run.cancel_requested_at)]]);

  p.line("");
  p.table(
    ["STEP", "STATUS", "ATTEMPTS", "NEEDS", "FAILURE"],
    Object.entries(run.steps).map(([id, step]) => [
      id,
      step.status,
      String(step.attempts_used),
      step.needs.length > 0 ? step.needs.join(",") : "-",
      step.failure === null ? "-" : `${step.failure.code}: ${step.failure.message}`,
    ]),
  );

  if (run.inputs !== null && Object.keys(run.inputs).length > 0) {
    p.line("");
    p.line("inputs");
    p.fields(Object.entries(run.inputs).map(([key, value]) => [key, stringify(value)]));
  }
  if (run.outputs !== null && Object.keys(run.outputs).length > 0) {
    p.line("");
    p.line("outputs");
    p.fields(Object.entries(run.outputs).map(([key, value]) => [key, stringify(value)]));
  }
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
