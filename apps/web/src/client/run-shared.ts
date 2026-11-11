// What the runs list and one run's page both need: how often they read, the clock they read on, what
// to do when the tab comes back, the statuses this build can stamp, and the API's own words for a
// failure. The screens are separate modules because they are separate jobs.

import { ApiError } from "./api.js";
import type { State } from "./dom.js";

export const POLL_MS = 1000;

/**
 * How often the Runs list is re-read when nothing on it is running.
 *
 * Nothing running is not the end of the story: the run that starts next may be started from the CLI
 * or in another tab, and the page is the only place most people look. A second would be rude, so the
 * list goes quiet rather than stopping, and a run that turns up takes the fast loop back.
 */
export const IDLE_POLL_MS = 15_000;

/**
 * The time a live view runs on: what now is, and how to be woken later.
 *
 * Both live views are built on this instead of calling `setTimeout` and `Date.now()` themselves so
 * that a test can advance time and count requests instead of sleeping. That is what makes finding 45
 * testable at all: "the list polled twice and then stopped" is a count of reads against a clock the
 * test chose, not a wait, and "the elapsed time on screen is 4 m 07 s" is checked against a now the
 * test set rather than whatever the machine running the test thinks it is.
 */
export interface Clock {
  now(): number;
  /** Do `run` in `ms`, unless it is called off first. Hands back the calling-off. */
  after(ms: number, run: () => void): () => void;
}

/** The real one. */
export const wallClock: Clock = {
  now: () => Date.now(),
  after: (ms, run) => {
    const id = window.setTimeout(run, ms);
    return () => window.clearTimeout(id);
  },
};

/**
 * Start `again` whenever the tab is shown, so a view that stopped reading starts again.
 *
 * A tab in the background is not watching anybody, and browsers throttle its timers to about a minute
 * anyway, so neither live view reads while it is hidden. Coming back is the moment a run that started
 * somewhere else turns up, which is when the reading picks itself back up.
 */
export function whenShown(signal: AbortSignal, again: () => void): void {
  const onVisibility = (): void => {
    if (!document.hidden && !signal.aborted) again();
  };
  document.addEventListener("visibilitychange", onVisibility);
  signal.addEventListener("abort", () => document.removeEventListener("visibilitychange", onVisibility));
}
/** Bytes the way a person reads them, because a run that ingested URLs has gigabytes in it. */
export function bytes(count: number): string {
  if (count < 1024) return `${count} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = count / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * The statuses this screen can stamp: the seven step statuses of SPEC 4.4, the run statuses that
 * section's table ends with, and `interrupted` — SPEC 5 keeps that to an attempt, never a step or a
 * run, but `status` is an unvalidated string on the wire and dom.ts already draws the shape, so a
 * server that answers with it gets its own word rather than a guess.
 *
 * Everything else falls back to `pending`, which is a choice rather than a reflex. `stateStamp`
 * prints the word it is handed and `sign` substitutes the not-started shape for a name it does not
 * know, so handing an unknown status through would pair one state's word with another's shape. And
 * `pending` is the least wrong thing to say about a status from an older server: it claims nothing
 * about the outcome and is not final, so it cannot tell a reader a run is over when the UI has simply
 * never seen that state — and it always draws, so the stamp is never blank and nothing throws.
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

export function state(value: string): State {
  return (STAMPABLE.has(value) ? value : "pending") as State;
}

/** The SPEC 5 words for whatever went wrong, so one line reads the same wherever it came from. */
export function errorWords(error: unknown): string {
  return error instanceof ApiError ? `${error.code}: ${error.message}` : String(error);
}

/** The body `errorBox` draws, whether the server answered in an error or something else threw. */
export function errorBody(error: unknown): { code: string; message: string; path?: string; file?: string } {
  return error instanceof ApiError ? error : { code: "internal_error", message: String(error) };
}

