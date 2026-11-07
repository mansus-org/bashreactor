// Reading a run's own files back out (BASHR-47). One helper decides what a client-supplied
// run-relative path may name, and all three routes go through it, because a block is arbitrary bash
// and can leave anything at all inside its own run directory: a symlink at `passwd`, a symlinked
// directory under `work/`, a path that only looks like it escapes once it is percent-decoded.
//
// The rules, in one place: a path is run-relative and has no empty, `.` or `..` segment; it resolves
// inside the run directory; and no component of it, read with `lstat` from the run directory down, is
// a symlink. Nothing here follows a link, in a single download or in an archive.

import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { RunRecord } from "@bashreactor/engine";
import { ApiError } from "./errors.ts";

/** What one path inside a run directory turns out to be, from the `lstat` that proved it reachable. */
export interface RunTarget {
  absolute: string;
  /** The same place, relative to the run directory, with forward slashes. */
  relative: string;
  stat: Stats;
}

/** Why a path was refused. Everything but the two request mistakes is a 404. */
export type Refusal = "empty" | "absolute" | "nul" | "segment" | "outside" | "missing" | "link";

export type Checked = { ok: true; target: RunTarget } | { ok: false; reason: Refusal; supplied: string };

/**
 * The one path check. `supplied` is already percent-decoded, which is why the segment test catches
 * `%2e%2e%2f` and `..%2f` and a double encoding as surely as a plain `..`.
 */
export function checkRunPath(runDir: string, supplied: string): Checked {
  if (supplied === "") return { ok: false, reason: "empty", supplied };
  if (supplied.includes("\0")) return { ok: false, reason: "nul", supplied };
  if (supplied.startsWith("/")) return { ok: false, reason: "absolute", supplied };

  const segments = supplied.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return { ok: false, reason: "segment", supplied };
    }
  }

  const absolute = resolve(runDir, ...segments);
  if (absolute !== runDir && !absolute.startsWith(runDir + sep)) {
    return { ok: false, reason: "outside", supplied };
  }

  // Every component, the last one included, read without following links: this is what stops
  // `work/link/passwd` when a block made `work/link` a symlink to `/etc`.
  let current = runDir;
  let stat: Stats | null = null;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      stat = lstatSync(current);
    } catch {
      return { ok: false, reason: "missing", supplied };
    }
    if (stat.isSymbolicLink()) return { ok: false, reason: "link", supplied };
  }

  return { ok: true, target: { absolute, relative: segments.join("/"), stat: stat! } };
}

/** The checked path, or the error every route answers with. */
export function runPathOrThrow(runDir: string, supplied: string): RunTarget {
  const checked = checkRunPath(runDir, supplied);
  if (checked.ok) return checked.target;
  throw refusal(checked);
}

function refusal(checked: { ok: false; reason: Refusal; supplied: string }): ApiError {
  const path = checked.supplied === "" ? undefined : checked.supplied;
  switch (checked.reason) {
    case "link":
      return new ApiError("file_not_found", `"${checked.supplied}" is a symlink, and links are not served`, { path });
    case "missing":
      return new ApiError("file_not_found", `run file "${checked.supplied}" does not exist`, { path });
    case "empty":
      return new ApiError("bad_request", "give the file with ?path=", { path: "path" });
    default:
      // A traversal, an absolute path and a NUL all get the answer a missing file gets: telling them
      // apart would tell a caller which paths exist outside the run directory.
      return new ApiError("file_not_found", `"${checked.supplied}" is not a file inside this run's directory`, {
        path,
      });
  }
}

// --- walking ----------------------------------------------------------------

export type WalkKind = "file" | "directory" | "link" | "other";

export interface WalkEntry {
  /** Run-relative, forward slashes. */
  path: string;
  kind: WalkKind;
  size: number;
  mode: number;
  mtimeMs: number;
}

/**
 * Everything under `root` (a run-relative directory; `""` is the run directory itself), in name
 * order, with the directories themselves among the entries. A symlinked directory is reported and
 * never descended into, so a block cannot point the walk outside the run.
 */
export function walkRunTree(runDir: string, root: string): WalkEntry[] {
  const start = root === "" ? runDir : runPathOrThrow(runDir, root).absolute;
  const entries: WalkEntry[] = [];
  if (root !== "") {
    const stat = lstatSync(start);
    if (!stat.isDirectory()) return [entryAt(root, stat)];
  }
  // The prefix is the root itself, so every entry names a run-relative path: the same string a
  // client puts in ?path= to download it.
  walkInto(runDir, start, root, entries);
  return entries;
}

function entryAt(relative: string, stat: Stats): WalkEntry {
  return {
    path: relative,
    kind: stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
    size: stat.size,
    mode: stat.mode & 0o777,
    mtimeMs: stat.mtimeMs,
  };
}

function walkInto(runDir: string, dir: string, prefix: string, out: WalkEntry[]): void {
  let names: string[];
  try {
    names = readdirSync(dir).toSorted();
  } catch {
    return; // a directory that is not there has nothing in it, which is not a thing to report
  }
  for (const name of names) {
    const absolute = join(dir, name);
    // The belt to the braces: nothing above this line may have followed a link, and this says so if
    // it did. It cannot happen today; it is here because the whole point of this file outlives today.
    if (!isInside(runDir, absolute)) continue;
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      continue; // it went away between the listing and the stat
    }
    const relative = prefix === "" ? name : `${prefix}/${name}`;
    out.push(entryAt(relative, stat));
    if (stat.isDirectory()) walkInto(runDir, absolute, relative, out);
  }
}

function isInside(runDir: string, absolute: string): boolean {
  return absolute === runDir || absolute.startsWith(runDir + sep);
}

// --- the manifest -----------------------------------------------------------

export type FileScope = "outputs" | "work" | "logs" | "all";

export interface ManifestOptions {
  step?: string;
  attempt?: number;
  scope: FileScope;
}

/** A file a client can ask for, with its size. A link is listed with no size and is not downloadable. */
function listed(entry: WalkEntry): Record<string, unknown> {
  if (entry.kind === "file") return { path: entry.path, size: entry.size };
  return { path: entry.path, kind: entry.kind === "link" ? "link" : "other" };
}

function sizeOf(runDir: string, relative: string): number | null {
  const checked = checkRunPath(runDir, relative);
  if (!checked.ok) return null;
  return checked.target.stat.isFile() ? checked.target.stat.size : null;
}

// SPEC 4.9: a `file` value in run.json is a path relative to the run directory, and SPEC 4.2 fixes
// where the engine puts one. That shape is how a declared output is recognised as a file.
const FILE_VALUE_RE = /^steps\/([^/]+)\/attempts\/([1-9][0-9]*)\/outputs\/(.+)$/;

/** The run's declared outputs that are files, by output name, with the attempt that made them. */
function declaredOutputs(record: RunRecord, runDir: string, options: ManifestOptions): Record<string, unknown>[] {
  const outputs = record.outputs;
  if (outputs === null) return [];
  const out: Record<string, unknown>[] = [];
  for (const [name, value] of Object.entries(outputs)) {
    if (typeof value !== "string") continue;
    const found = FILE_VALUE_RE.exec(value);
    if (found === null) continue;
    const attempt = Number(found[2]);
    if (options.step !== undefined && options.step !== found[1]) continue;
    if (options.attempt !== undefined && options.attempt !== attempt) continue;
    out.push({
      name,
      type: "file",
      step: found[1],
      attempt,
      path: value,
      // A declared output whose file is not on disk is listed with a null size rather than dropped,
      // so a missing file is something a client can see instead of something it has to notice.
      size: sizeOf(runDir, value),
    });
  }
  return out;
}

/** The manifest: what may be downloaded from this run, and how big each thing is. */
export function buildManifest(record: RunRecord, runDir: string, options: ManifestOptions): unknown {
  const scope = options.scope;
  const steps: Record<string, unknown> = {};
  for (const [stepId, step] of Object.entries(record.steps)) {
    if (options.step !== undefined && options.step !== stepId) continue;
    const attempts: Record<string, unknown>[] = [];
    for (const attempt of step.attempts) {
      if (options.attempt !== undefined && options.attempt !== attempt.n) continue;
      const attemptDir = `steps/${stepId}/attempts/${attempt.n}`;
      const outputsDir = `${attemptDir}/outputs`;
      const entry: Record<string, unknown> = {
        n: attempt.n,
        status: attempt.status,
        // The "this file may be half-written" signal. `waiting_retry` is a step status, and the
        // attempt under it has already ended, so a running attempt is the only one still being
        // written (SPEC 4.9).
        partial: attempt.status === "running",
      };
      if (scope === "all" || scope === "logs") {
        const log = listUnder(runDir, `${attemptDir}/log`);
        if (log.length > 0) entry.log = listed(log[0]!);
      }
      if (scope === "all" || scope === "outputs") {
        entry.outputs = listUnder(runDir, outputsDir).map((file) => ({
          name: file.path.slice(outputsDir.length + 1),
          ...listed(file),
        }));
      }
      if (scope === "all" || scope === "work") {
        entry.work = listUnder(runDir, `steps/${stepId}/work`).map(listed);
      }
      attempts.push(entry);
    }
    steps[stepId] = { attempts };
  }

  return {
    run: record.id,
    status: record.status,
    partial: record.status === "running",
    outputs: declaredOutputs(record, runDir, options),
    steps,
  };
}

/** The files under one run-relative path, or the one file it names. Nothing when it is not there. */
function listUnder(runDir: string, relative: string): WalkEntry[] {
  const checked = checkRunPath(runDir, relative);
  if (!checked.ok) return [];
  if (!checked.target.stat.isDirectory()) {
    return [entryAt(relative, checked.target.stat)];
  }
  return walkRunTree(runDir, relative).filter((entry) => entry.kind !== "directory");
}

// --- one file ---------------------------------------------------------------

/** A filename that cannot break the header, whatever a block chose to call the file it wrote. */
function attachmentName(relative: string): string {
  const base = relative.split("/").pop() ?? "file";
  // A quote would end the quoted string, a CR or an LF would start a header line, and a control byte
  // is not a filename anywhere. eslint calls the second pattern a control regex; that is the point.
  const safe = base
    .replace(/["\\]/g, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "_")
    .slice(0, 120);
  return safe === "" ? "file" : safe;
}

/**
 * The headers every download carries. A block writes arbitrary bytes and an HTML file on the app's
 * own origin is a script that runs as the app, so: an attachment, a type nothing renders, and no
 * sniffing. `content-length` comes from the `lstat` that already proved the path reachable.
 */
function downloadHeaders(filename: string, size: number, partial: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "x-content-type-options": "nosniff",
    "content-disposition": `attachment; filename="${attachmentName(filename)}"`,
    "content-length": String(size),
  };
  if (partial) headers["x-run-partial"] = "true";
  return headers;
}

/** One file of a run, streamed. Nothing here reads the file: the body is the file. */
export function fileResponse(record: RunRecord, runDir: string, supplied: string): Response {
  const target = runPathOrThrow(runDir, supplied);
  if (target.stat.isDirectory()) {
    throw new ApiError("bad_request", `"${supplied}" is a directory; ask the archive route instead`, {
      path: supplied,
    });
  }
  if (!target.stat.isFile()) {
    throw new ApiError("file_not_found", `"${supplied}" is not a regular file`, { path: supplied });
  }
  return new Response(Bun.file(target.absolute), {
    status: 200,
    headers: downloadHeaders(target.relative, target.stat.size, record.status === "running"),
  });
}

// --- the archive ------------------------------------------------------------

export interface ArchiveChoice {
  step?: string;
  attempt?: number;
}

/** Which part of the run the archive holds, and what the file should be called. */
function archiveRoot(record: RunRecord, choice: ArchiveChoice): { root: string; filename: string } {
  if (choice.step === undefined) {
    if (choice.attempt !== undefined) {
      throw new ApiError("bad_request", "?attempt needs ?step to say whose attempt it is", { path: "attempt" });
    }
    return { root: "", filename: `${record.id}.tar.gz` };
  }
  const step = Object.hasOwn(record.steps, choice.step) ? record.steps[choice.step] : undefined;
  if (step === undefined) {
    throw new ApiError("step_not_found", `run "${record.id}" has no step "${choice.step}"`, {
      path: `steps.${choice.step}`,
    });
  }
  if (choice.attempt === undefined) {
    return { root: `steps/${choice.step}`, filename: `${record.id}-${choice.step}.tar.gz` };
  }
  if (!step.attempts.some((entry) => entry.n === choice.attempt)) {
    throw new ApiError(
      "attempt_not_found",
      `step "${choice.step}" of run "${record.id}" has no attempt ${choice.attempt}`,
      { path: `steps.${choice.step}.attempts` },
    );
  }
  return {
    root: `steps/${choice.step}/attempts/${choice.attempt}`,
    filename: `${record.id}-${choice.step}-attempt${choice.attempt}.tar.gz`,
  };
}

export interface ArchiveBody {
  body: ReadableStream<Uint8Array>;
  skipped: number;
  filename: string;
  partial: boolean;
}

/**
 * A tar.gz of a run, a step or an attempt, built as it streams: 512-byte ustar headers, the file's
 * own bytes piped through `CompressionStream("gzip")`, nothing held in memory. Symlinks and other
 * non-regular files are left out and counted, never followed.
 */
export function archiveBody(record: RunRecord, runDir: string, choice: ArchiveChoice): ArchiveBody {
  const { root, filename } = archiveRoot(record, choice);
  const found = walkRunTree(runDir, root);
  const keep = found.filter((entry) => entry.kind === "file" || entry.kind === "directory");
  const skipped = found.length - keep.length;

  const source = tarEntries(runDir, root, keep)[Symbol.asyncIterator]();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await source.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
  });

  return {
    body: stream.pipeThrough(new CompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>),
    skipped,
    filename,
    partial: record.status === "running",
  };
}

const BLOCK = 512;
const ZERO_BLOCK = new Uint8Array(BLOCK);

/** tar's numbers: octal, zero-padded, NUL-terminated, in a field of exactly `length` bytes. */
function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

/** A tar name, split into ustar's name and prefix fields when it is too long for one. */
function tarName(name: string): { name: string; prefix: string } | null {
  if (name.length <= 100) return { name, prefix: "" };
  const cut = name.lastIndexOf("/", 155 + 100);
  if (cut === -1) return null;
  const prefix = name.slice(0, cut);
  const rest = name.slice(cut + 1);
  if (prefix.length > 155 || rest.length > 100) return null;
  return { name: rest, prefix };
}

async function* tarEntries(
  runDir: string,
  root: string,
  entries: readonly WalkEntry[],
): AsyncGenerator<Uint8Array> {
  const strip = root === "" ? "" : `${root}/`;
  for (const entry of entries) {
    // The name in the archive is relative to what was asked for, so a step archive unpacks to a
    // step's own tree rather than to a path nobody would type.
    const name = strip !== "" && entry.path.startsWith(strip) ? entry.path.slice(strip.length) : entry.path;
    if (name === "") continue;
    const directory = entry.kind === "directory";
    const size = directory ? 0 : entry.size;
    yield tarHeader(directory ? `${name}/` : name, size, entry.mode, entry.mtimeMs, directory ? "5" : "0");
    if (directory) continue;
    const absolute = join(runDir, entry.path);
    if (!isInside(runDir, absolute)) continue;
    for await (const chunk of Bun.file(absolute).stream()) {
      yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
    }
    const padding = size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK);
    if (padding > 0) yield ZERO_BLOCK.subarray(0, padding);
  }
  // Two zero blocks end a tar file; gzip closes the stream after them.
  yield ZERO_BLOCK;
  yield ZERO_BLOCK;
}

/** A ustar header: the fields tar reads, padded to 512 bytes, with the checksum computed last. */
function tarHeader(name: string, size: number, mode: number, mtimeMs: number, typeflag: string): Uint8Array {
  const header = new Uint8Array(BLOCK);
  const encoder = new TextEncoder();
  const write = (text: string, offset: number, length: number) =>
    header.set(encoder.encode(text).subarray(0, length), offset);

  const split = tarName(name);
  const fields = split ?? { name: name.slice(0, 100), prefix: "" };
  write(fields.name, 0, 100);
  write(octal(mode, 8), 100, 8);
  write(octal(0, 8), 108, 8);
  write(octal(0, 8), 116, 8);
  write(octal(size, 12), 124, 12);
  write(octal(Math.floor(mtimeMs / 1000), 12), 136, 12);
  header.fill(0x20, 148, 156); // the checksum field, read as spaces until the sum is known
  write(typeflag, 156, 1);
  write("ustar\0", 257, 6);
  write("00", 263, 2);
  write(fields.prefix, 345, 155);

  let sum = 0;
  for (const byte of header) sum += byte;
  write(octal(sum, 8), 148, 8);
  return header;
}
