// The two output modes, chosen once at the top of a command and never mixed. `--json` hands back the
// API's own bytes; the human mode is aligned columns, no colour, no spinner, dates in local time.

import type { ErrorBody } from "./errors.ts";

/** Where a command writes. Replaced in tests only for the in-process entry point. */
export interface Io {
  /** One line to stdout, newline included by the caller-free implementation. */
  out(line: string): void;
  /** One line to stderr. */
  err(line: string): void;
  /** Raw bytes to stdout, for a route whose answer is a file and not a document. */
  bytes(data: Uint8Array): void;
}

export function stdoutIo(): Io {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    bytes: (data) => process.stdout.write(data),
  };
}

export class Printer {
  readonly json: boolean;
  readonly io: Io;

  constructor(io: Io, json: boolean) {
    this.io = io;
    this.json = json;
  }

  /**
   * The only way a command answers: either the API's JSON, verbatim, or the human rendering. A
   * command cannot print both, because it does not hold the choice.
   */
  emit(value: unknown, human: (p: Printer) => void): void {
    if (this.json) this.io.out(JSON.stringify(value));
    else human(this);
  }

  line(text: string): void {
    this.io.out(text);
  }

  /** A note beside the answer: stderr, so a pipe or a redirect keeps only the answer. */
  note(text: string): void {
    this.io.err(text);
  }

  fields(pairs: readonly (readonly [string, string])[]): void {
    const width = Math.max(...pairs.map(([key]) => key.length));
    for (const [key, value] of pairs) {
      this.io.out(`${key.padEnd(width)}  ${value}`);
    }
  }

  table(headers: readonly string[], rows: readonly (readonly string[])[]): void {
    const columns = headers.length;
    const widths: number[] = headers.map((header) => header.length);
    for (const row of rows) {
      for (let i = 0; i < columns; i += 1) {
        widths[i] = Math.max(widths[i]!, (row[i] ?? "").length);
      }
    }
    const render = (cells: readonly string[]): string =>
      cells
        .map((cell, index) => (index === columns - 1 ? cell : cell.padEnd(widths[index]!)))
        .join("  ")
        .trimEnd();
    this.io.out(render(headers));
    for (const row of rows) this.io.out(render(row));
  }

  /** The SPEC 5 error object, under --json on stdout and otherwise on stderr. */
  error(body: ErrorBody): void {
    if (this.json) this.io.out(JSON.stringify(body));
    else this.io.err(JSON.stringify(body));
  }
}

/**
 * A timestamp from run.json, in the reader's own time zone. The run id is never shortened to make a
 * column fit: it is the only thing a person can copy into the next command.
 */
export function localTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** How long a run took, from its own two timestamps; "-" while it is still going. */
export function elapsed(startIso: string | null, endIso: string | null): string {
  if (startIso === null || endIso === null) return "-";
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
