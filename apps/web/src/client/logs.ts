// The log cursor. SPEC 4.8 says a reader follows a step attempt's log by byte offset, and the API
// hands back the offset to come back with, so all the state a log pane has is: how far we got, the
// line that has not finished yet, and where that line started. That is small enough to be a
// function, and it is tested as one.
//
// The log is the bytes the block wrote, stdout and stderr interleaved, with nothing added (SPEC 4.8).
// So a chunk can end in the middle of a line, and the pane must not pretend that half line is one.

export interface LogLine {
  /** The byte the line starts at. This is the cursor the reader is looking at. */
  offset: number;
  text: string;
}

export interface LogState {
  /** The byte offset of the first byte not yet shown. This is what goes back as `?offset=`. */
  offset: number;
  lines: LogLine[];
  /** The text after the last newline, which may still grow, and the byte it started at. */
  partial: string;
  partialOffset: number;
  /** Set when the server cut its answer short; what came after the cut is not shown. */
  truncated: boolean;
}

export const emptyLog: LogState = { offset: 0, lines: [], partial: "", partialOffset: 0, truncated: false };

export interface LogChunk {
  offset: number;
  next_offset: number;
  text: string;
  truncated: boolean;
}

const utf8 = new TextEncoder();

/**
 * Applies one `GET /v1/runs/:id/logs/:step/:attempt` answer to the cursor.
 *
 * A chunk whose `offset` is not where we left off means the cursor is no longer ours — the pane was
 * pointed at another attempt, or the server started over — so this chunk becomes the whole of what
 * we show rather than a piece appended to something stale.
 */
export function feedLog(state: LogState, chunk: LogChunk): LogState {
  const ours = chunk.offset === state.offset;
  const text = (ours ? state.partial : "") + chunk.text;
  const parts = text.split("\n");
  const lines = ours ? [...state.lines] : [];
  // Offsets are bytes, not characters: a block that prints an em dash moves the cursor by three.
  let at = ours ? state.partialOffset : chunk.offset;
  for (const part of parts.slice(0, -1)) {
    lines.push({ offset: at, text: part });
    at += utf8.encode(part).length + 1;
  }
  return {
    offset: chunk.next_offset,
    lines,
    partial: parts[parts.length - 1] ?? "",
    partialOffset: at,
    truncated: chunk.truncated,
  };
}

/** What the pane shows: the finished lines, plus the half line if there is one. */
export function logLines(state: LogState): LogLine[] {
  return state.partial === "" ? state.lines : [...state.lines, { offset: state.partialOffset, text: state.partial }];
}
