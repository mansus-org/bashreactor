// Runs: start one, list them, read one, move one along, and follow a step's log. The API drives a
// run in the background and answers 201 as soon as the run exists (SPEC 4.3), so nothing here waits
// unless the person asked to.

import { parsePipeline } from "@bashreactor/core";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { CommandSpec, Ctx, FlagSpec } from "../args.ts";
import { usage } from "../errors.ts";
import { elapsed, localTime } from "../output.ts";
import { publishRelativeBlocks, readPipelineFile } from "../local.ts";
import { declaredTypes, readInputs } from "../inputs.ts";
import { INTERVAL_FLAG, VERSION_FLAG, versionOf } from "./flags.ts";
import type {
  LogChunk,
  PipelineVersion,
  RunFileManifest,
  RunRecord,
  RunStatus,
  RunSummary,
  StepRecord,
  StepStatus,
} from "../types.ts";
import { FINAL_STEP_STATUSES } from "../types.ts";
import type { Printer } from "../output.ts";

const SUMMARY: Record<"cancel" | "retry" | "resume", string> = {
  cancel: "ask for a cancel (SPEC 4.6)",
  retry: "retry a failed or cancelled run from where it stopped",
  resume: "take up a run left `running` by an engine that died",
};

/** Where a download goes, and whether an existing file may be replaced. */
const OUTPUT_FLAG = {
  name: "out",
  short: "-o",
  help: "where to write it (default: the name the server offered)",
  value: "string",
} as const satisfies FlagSpec;

const FORCE_FLAG = { name: "force", help: "overwrite the file if it is already there" } as const satisfies FlagSpec;

/** The step and attempt a manifest or an archive may be narrowed to. */
const STEP_FLAGS: readonly FlagSpec[] = [
  { name: "step", help: "only this step", value: "string" },
  { name: "attempt", help: "only this attempt of that step", value: "int", min: 1 },
];

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
        // The whole command line is read before anything is published: a typo in `--input` must not
        // leave blocks in the library behind, because the run it was asked for never happened.
        const inputs = readInputs(pairs, declaredTypes(quietlyParse(file.source)?.inputs), ctx.cwd);
        const prepared = await publishRelativeBlocks(ctx.client, file, (line) => ctx.printer.note(line));
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
          pairs.length === 0
            ? undefined
            : await ctx.client.json<PipelineVersion>(
                "GET",
                `/v1/pipelines/${encodeURIComponent(target)}/${version}`,
              );
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
    summary: "runs, newest first, optionally filtered",
    flags: [
      { name: "pipeline", help: "only runs of this pipeline", value: "string" },
      { name: "status", help: "only these statuses, comma-separated", value: "string" },
      { name: "since", help: "only runs created at or after this UTC instant", value: "string" },
      { name: "limit", help: "how many runs to show (default 100, at most 500)", value: "string" },
    ],
    run: async (ctx) => {
      const runs = await ctx.client.json<RunSummary[]>("GET", "/v1/runs", {
        query: {
          pipeline: ctx.flag("pipeline"),
          status: ctx.flag("status"),
          since: ctx.flag("since"),
          limit: ctx.flag("limit"),
        },
      });
      ctx.printer.emit(runs, (p) => {
        if (runs.length === 0) {
          p.line("no runs");
          return;
        }
        p.table(
          ["RUN", "PIPELINE", "VERSION", "STATUS", "STEPS", "CREATED", "FINISHED", "TOOK"],
          runs.map((run) => [
            run.id,
            run.pipeline,
            run.pipeline_version === null ? "-" : `v${run.pipeline_version}`,
            run.status,
            `${run.step_counts.succeeded}/${run.step_counts.total}`,
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
    name: "rm",
    summary: "delete a run and everything it wrote",
    args: [{ name: "<run-id>" }],
    run: async (ctx) => {
      // One call: the API owns the directory and says what it removed. A run that is still running
      // answers 409 `run_claimed` with the pid that holds it, which is a better answer than this
      // command guessing by reading the record first.
      const answer = await ctx.client.json<{ deleted: string }>("DELETE", `/v1/runs/${encodeURIComponent(ctx.args[0]!)}`);
      ctx.printer.emit(answer, (p) => {
        p.line(`deleted ${answer.deleted}`);
      });
      return 0;
    },
  },
  {
    group: "runs",
    name: "logs",
    summary: "print a step's log from an offset, and say the next offset",
    args: [{ name: "<run-id>" }, { name: "<step>" }],
    flags: [
      {
        name: "attempt",
        help: "which attempt to read (default: the last one; --follow reads them all, in order)",
        value: "int",
        min: 1,
      },
      { name: "offset", help: "byte offset to start at (default 0)", value: "int", min: 0 },
      {
        name: "follow",
        help: "keep reading until the step or the run is final; exit 1 unless the step succeeded",
      },
      INTERVAL_FLAG,
    ],
    run: async (ctx) => {
      const id = ctx.args[0]!;
      const step = ctx.args[1]!;
      const pinned = ctx.flag("attempt");
      let offset = ctx.int("offset", 0);
      let openLine = false;

      // The log is bytes, written as they are: no newline added, nothing re-read. Under --json the
      // chunk object is the answer instead, and its `text` field holds the same bytes.
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
      // The server cuts an answer at its own size and says so with `truncated`; one read is not the log.
      // Under --json that means one chunk object per read.
      const drain = async (attempt: number): Promise<void> => {
        for (;;) {
          const chunk = await getLog(ctx, id, step, attempt, offset);
          write(chunk);
          if (!chunk.truncated) return;
        }
      };
      // Everything that is not the log goes to stderr, and nothing at all goes there under --json,
      // where the chunk objects already say which attempt and which bytes they are.
      const note = (text: string): void => {
        if (ctx.printer.json) return;
        if (openLine) ctx.io.err("");
        openLine = false;
        ctx.printer.note(text);
      };
      const getRun = (): Promise<RunRecord> => ctx.client.json<RunRecord>("GET", `/v1/runs/${encodeURIComponent(id)}`);

      if (!ctx.has("follow")) {
        await drain(pinned === undefined ? await lastAttempt(ctx, id, step) : Number(pinned));
        note(`next offset ${offset}`);
        return 0;
      }

      // SPEC 4.8: a step's log is its attempts' logs in order, so --follow reads them that way and
      // marks each boundary on stderr. `--attempt` pins one attempt and reads only that one.
      let attempt: number | undefined = pinned === undefined ? undefined : Number(pinned);
      const interval = ctx.int("interval", 1000);
      for (;;) {
        const run = await getRun();
        const record = run.steps[step];
        // A step the run never had is the API's answer, --follow or not, so ask for its log and let
        // the 404 come back rather than inventing one here.
        if (record === undefined) await drain(1);

        // Walk every attempt the step has, in order, before deciding whether the wait is over: a
        // step that was already final when --follow started still has all of its attempts to print.
        // `nextAttempt` answers undefined for a step that has no attempt yet (SPEC 4.4: it has not
        // started), which is a wait and not the API's `attempt_not_found`.
        for (;;) {
          const next = pinned === undefined ? nextAttempt(record, attempt) : undefined;
          if (next === undefined) break;
          // Read the tail of the attempt being left before anything of the new one is printed.
          if (attempt !== undefined) await drain(attempt);
          attempt = next;
          offset = 0;
          note(`==> attempt ${next} <==`);
          await drain(next);
        }

        const status = record?.status;
        const stepIsFinal = status !== undefined && FINAL_STEP_STATUSES.includes(status);
        if (!stepIsFinal && run.status === "running") {
          await Bun.sleep(interval);
          continue;
        }
        // Anything written between the two reads is still part of the answer.
        if (attempt !== undefined) await drain(attempt);
        note(`next offset ${offset}`);
        note(`run ${id} ${run.status}`);
        if (stepIsFinal && status !== "succeeded") note(`step ${step} ${status}${why(record)}`);
        return exitFor(run.status, status);
      }
    },
  },
  {
    group: "runs",
    name: "files",
    summary: "what a run wrote, and how big each file is",
    args: [{ name: "<run-id>" }],
    flags: [
      ...STEP_FLAGS,
      {
        name: "scope",
        help: "which parts to list",
        value: "string",
        choices: ["outputs", "work", "logs", "all"],
      },
    ],
    run: async (ctx) => {
      const manifest = await ctx.client.json<RunFileManifest>("GET", `/v1/runs/${encodeURIComponent(ctx.args[0]!)}/files`, {
        query: { step: ctx.flag("step"), attempt: ctx.flag("attempt"), scope: ctx.flag("scope") },
      });
      ctx.printer.emit(manifest, (p) => renderManifest(p, manifest));
      return 0;
    },
  },
  {
    group: "runs",
    name: "download",
    summary: "save one file a run wrote",
    args: [{ name: "<run-id>" }, { name: "<path>" }],
    flags: [OUTPUT_FLAG, FORCE_FLAG],
    run: async (ctx) => {
      const id = ctx.args[0]!;
      const path = ctx.args[1]!;
      const response = await ctx.client.bytes("GET", `/v1/runs/${encodeURIComponent(id)}/file`, {
        query: { path },
      });
      const destination = resolve(ctx.cwd, ctx.flag("out") ?? basename(path));
      const saved = await save(ctx, response, destination);
      ctx.printer.emit(saved, (p) => p.line(`${path}  ${sizeText(saved.bytes)}  ${saved.file}`));
      return 0;
    },
  },
  {
    group: "runs",
    name: "archive",
    summary: "save a run, a step or an attempt as one tar.gz",
    args: [{ name: "<run-id>" }],
    flags: [OUTPUT_FLAG, FORCE_FLAG, ...STEP_FLAGS],
    run: async (ctx) => {
      const id = ctx.args[0]!;
      const response = await ctx.client.bytes("GET", `/v1/runs/${encodeURIComponent(id)}/archive`, {
        query: { step: ctx.flag("step"), attempt: ctx.flag("attempt") },
      });
      // The server names the archive after what it holds; only a name it did not offer is invented here.
      const offered = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1];
      const destination = resolve(ctx.cwd, ctx.flag("out") ?? offered ?? `${id}.tar.gz`);
      const saved = await save(ctx, response, destination);
      const skipped = Number(response.headers.get("x-run-skipped") ?? "0");
      ctx.printer.emit(saved, (p) => {
        p.line(`${id}  ${sizeText(saved.bytes)}  ${saved.file}`);
        // A link a block planted is left out rather than followed, and the person saving this should
        // know something was left out rather than find a smaller tree than the run has.
        if (skipped > 0) p.line(`${skipped} link or special file(s) skipped: a run file is never followed through a link`);
      });
      return 0;
    },
  },
];

/** Where a download went, as the answer to a download command. */
interface Saved {
  file: string;
  bytes: number;
  run: string;
}

/**
 * Write the response to a file without holding it. An existing file is not touched unless `--force`,
 * because a half-written download is worse than no download and a person's own file is not ours to
 * replace on a guess.
 */
async function save(ctx: Ctx, response: Response, destination: string): Promise<Saved> {
  if (existsSync(destination) && !ctx.has("force")) {
    throw usage(`"${destination}" already exists; give --force to overwrite it`, { file: destination });
  }
  const directory = dirname(destination);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  // The Response, not `response.body`: Bun.write handed a web ReadableStream writes the 23-byte
  // string "[object ReadableStream]" and reports success. Handed the Response it streams the body.
  const written = await Bun.write(destination, response);
  return { file: destination, bytes: Number(written), run: ctx.args[0]! };
}

/** Exported for `bashreactor disk`, which counts bytes the same way a run's files do. */
export function sizeText(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

function renderManifest(p: Printer, manifest: RunFileManifest): void {
  p.fields([
    ["run", manifest.run],
    ["status", manifest.status],
    ["partial", manifest.partial ? "yes: the run is still writing" : "no"],
  ]);

  if (manifest.outputs.length > 0) {
    p.line("");
    p.line("outputs");
    p.table(
      ["NAME", "SIZE", "STEP", "ATTEMPT", "PATH"],
      manifest.outputs.map((entry) => [
        entry.name,
        entry.size === null ? "missing" : sizeText(entry.size),
        entry.step,
        String(entry.attempt),
        entry.path,
      ]),
    );
  }

  for (const [stepId, step] of Object.entries(manifest.steps)) {
    for (const attempt of step.attempts) {
      p.line("");
      p.line(`${stepId} attempt ${attempt.n} — ${attempt.status}${attempt.partial ? ", partial" : ""}`);
      const rows: (readonly string[])[] = [];
      if (attempt.log !== undefined) rows.push(["log", sizeText(attempt.log.size), attempt.log.path]);
      for (const entry of attempt.outputs ?? []) {
        rows.push(["output", entry.kind === undefined ? sizeText(entry.size) : entry.kind, entry.path]);
      }
      for (const entry of attempt.work ?? []) {
        rows.push(["work", entry.kind === undefined ? sizeText(entry.size) : entry.kind, entry.path]);
      }
      if (rows.length === 0) {
        p.line("  nothing on disk");
        continue;
      }
      p.table(["", "SIZE", "PATH"], rows);
    }
  }
}

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

/**
 * The exit code for a followed step. A step that ended any other way than `succeeded` is a failure
 * for the person who was watching it, even when the run around it is still going and has not
 * decided anything yet.
 */
function exitFor(run: RunStatus, step: StepStatus | undefined): number {
  if (step !== undefined && step !== "succeeded") return 1;
  return exitForRun(run);
}

/** Why a step ended the way it did, from its own `failure` (SPEC 4.9), when it has one. The engine
 * sets `message` to the code itself for a plain exit, so do not print the same word twice. */
function why(record: StepRecord | undefined): string {
  const failure = record?.failure;
  if (failure === null || failure === undefined) return "";
  return failure.message === failure.code
    ? ` (${failure.code})`
    : ` (${failure.code}: ${failure.message})`;
}

/**
 * The attempt to start reading next, once --follow has moved past the ones before it: the first one
 * the step has, or the one after the attempt being read as soon as that one has ended. `undefined`
 * means there is nothing new yet, which while the step is not final is a wait and not an error.
 */
function nextAttempt(record: StepRecord | undefined, current: number | undefined): number | undefined {
  const attempts = record?.attempts ?? [];
  if (current === undefined) return attempts[0]?.n;
  // Never leave an attempt that is still being written: its bytes are not all there yet.
  if (attempts.some((entry) => entry.n === current && entry.status === "running")) return undefined;
  return attempts.find((entry) => entry.n > current)?.n;
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
