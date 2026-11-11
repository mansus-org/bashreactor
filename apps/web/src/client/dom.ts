// The DOM helpers every screen shares: one element factory, the 7x7 state signs, the two formatters,
// the status region and the error box. An error here is always the SPEC 5 object, because that is
// all the API ever answers with.

/** Each state has a shape as well as a word, so a row reads at a glance in two inks. */
const SIGNS: Record<string, readonly string[]> = {
  pending: ["#######", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#######"],
  running: ["#.#.#.#", ".#.#.#.", "#.#.#.#", ".#.#.#.", "#.#.#.#", ".#.#.#.", "#.#.#.#"],
  succeeded: ["#######", "#######", "#######", "#######", "#######", "#######", "#######"],
  failed: ["#.....#", ".#...#.", "..#.#..", "...#...", "..#.#..", ".#...#.", "#.....#"],
  waiting_retry: ["#######", "#.....#", "#.#.#.#", "#.#.#.#", "#.#.#.#", "#.....#", "#######"],
  skipped: ["##.....", "###....", "####...", "#####..", "####...", "###....", "##....."],
  cancelled: ["#######", "#....##", "#...#.#", "#..#..#", "#.#...#", "##....#", "#######"],
  // Not a run state: the not-started sign the empty screens use when there is nothing to show yet.
  queued: ["#######", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#######"],
  // A run's own status, which is the step vocabulary minus the step-only states.
  interrupted: ["#######", "#.....#", "#..#..#", "#.#.#.#", "#..#..#", "#.....#", "#######"],
};

export type State = keyof typeof SIGNS;

export type Child = Node | string | null | false | undefined | Child[];
type AttrValue = string | number | boolean | null | undefined | ((event: Event) => void);
type Attrs = Record<string, AttrValue>;

/** Children may be nested lists, because a map over data reads better than a loop that appends. */
function flatten(children: Child[]): (Node | string)[] {
  const out: (Node | string)[] = [];
  for (const child of children) {
    if (child === null || child === false || child === undefined) continue;
    if (Array.isArray(child)) out.push(...flatten(child));
    else out.push(child);
  }
  return out;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key === "class") node.className = String(value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value as (event: Event) => void);
    else if (key === "value") (node as HTMLInputElement).value = String(value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of flatten(children)) {
    node.append(child);
  }
  return node as HTMLElementTagNameMap[K];
}

/**
 * A 7x7 bitmap as one crisp SVG path. `#` is ink and every other character is paper.
 *
 * The signs and the shell's nav glyphs are the same drawing, so they share this instead of each
 * growing its own cell loop.
 */
export function bitmap(rows: readonly string[], className = "sign"): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 7 7");
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", className);
  let d = "";
  rows.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      if (cell === "#") d += `M${x} ${y}h1v1h-1z`;
    });
  });
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

/** A 7x7 sign, drawn cell by cell so it stays crisp in two inks at any zoom. */
export function sign(state: State, className?: string): SVGElement {
  return bitmap(SIGNS[state] ?? SIGNS.queued!, className ?? "sign");
}

export function stateStamp(state: State): HTMLElement {
  return el("span", { class: "stamp" }, sign(state), state);
}

/**
 * Remove an attribute, including in the test DOM, whose elements expose attributes as a Map rather
 * than the full Element interface. The real browser takes the first branch.
 */
export function clearAttribute(node: Element, name: string): void {
  const maybe = node as unknown as { removeAttribute?: (name: string) => void; attrs?: Map<string, string> };
  if (typeof maybe.removeAttribute === "function") maybe.removeAttribute(name);
  else maybe.attrs?.delete(name);
}

/** Insert a node, including in the test DOM, which has no `insertBefore()` of its own. */
export function insertNode(parent: Element, node: Element, before: Element | null): void {
  const real = parent as unknown as { insertBefore?: (node: Element, before: Element | null) => void };
  if (typeof real.insertBefore === "function") {
    real.insertBefore(node, before);
    return;
  }
  const fakeParent = parent as unknown as { children: Element[] };
  const fakeNode = node as unknown as { parent?: { children: Element[] } | null };
  if (fakeNode.parent !== null && fakeNode.parent !== undefined) {
    const at = fakeNode.parent.children.indexOf(node);
    if (at !== -1) fakeNode.parent.children.splice(at, 1);
  }
  const at = before === null ? fakeParent.children.length : fakeParent.children.indexOf(before);
  fakeParent.children.splice(at === -1 ? fakeParent.children.length : at, 0, node);
  fakeNode.parent = fakeParent;
}

/** Remove a node, including in the test DOM, which has no `remove()` of its own. */
export function removeNode(node: Element): void {
  const maybe = node as unknown as {
    remove?: () => void;
    parent?: { children: Element[] } | null;
  };
  if (typeof maybe.remove === "function") maybe.remove();
  else if (maybe.parent !== null && maybe.parent !== undefined) {
    const at = maybe.parent.children.indexOf(node);
    if (at !== -1) maybe.parent.children.splice(at, 1);
  }
}

/**
 * Write a new state into a stamp already on the page.
 *
 * A live view redraws itself while you are looking at it, and a stamp rebuilt from scratch takes the
 * focus off anything inside it. The shape and the word are replaced together, because one without the
 * other is how a row ends up saying `succeeded` in the shape of `running`.
 */
export function restamp(stamp: HTMLElement, state: State): void {
  stamp.replaceChildren(sign(state), state);
}

/** Two digits, for the durations and times that are read as a clock rather than counted. */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// The three formatters below (duration, when, clock) are kept for the screens that have not been
// redesigned yet. New work uses relativeTime/exactTime/formatDuration in ui.ts; do not add callers.

/**
 * Seconds to "4 m 07 s", the way a person reads a duration off a running job.
 *
 * Nothing to count means nothing to say: a time the API did not give, or did not give in a shape that
 * parses, comes back empty rather than as `NaN s`, because a duration on these screens is a promise
 * that both ends of it are known.
 */
export function duration(total: number): string {
  if (!Number.isFinite(total)) return "";
  const seconds = Math.max(0, Math.floor(total));
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${pad(m)} m`;
  if (m) return `${m} m ${pad(s)} s`;
  return `${s} s`;
}

export function clock(total: number): string {
  const seconds = Math.max(0, Math.floor(total));
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

/**
 * An ISO time from run.json, in the reader's own clock, or nothing when the field is null.
 *
 * The old version ended its string with ` UTC`, and that was the whole of a bug: one screen said UTC,
 * the one beside it said the browser's own zone, and a version picker said neither by cutting the raw
 * ISO at the sixteenth character. Nothing on any of them said which zone was meant. So this says it
 * once, in the one zone the browser reads in, and it says it to the second — the minute is where two
 * runs started a breath apart stop being tellable apart. A string with no zone marker in it is only
 * ever the reader's own time, so whatever shows it puts `isoInstant` beside it. A string that will not
 * parse returns the empty string rather than being echoed back: a time the API got wrong is not shown
 * as a time, and every caller hides the line when this is empty.
 */
export function when(iso: string | null): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  // Echoing back a string that will not parse puts a wrong time on the page dressed up as a right one.
  if (Number.isNaN(at)) return "";
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * The same instant the API was answered with, in UTC, for the `title` of something showing `when`.
 *
 * What is on the page is the reader's own clock, so the exact instant has to be written down next to
 * it for anyone comparing two screens or matching a run against a server log. UTC always, even when
 * the answer came in some other offset, so that two screens always agree.
 */
export function isoInstant(iso: string | null): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  // The `.000` that `toISOString` adds is noise nobody asked for, and a title that reads differently
  // from the string in the API's JSON makes people think the two disagree. Real milliseconds stay.
  return Number.isNaN(at) ? "" : new Date(at).toISOString().replace(/\.000Z$/, "Z");
}

/** The e-ink repaint. Reading layout restarts it when the same node repaints twice in a row. */
export function flash(node: Element | null | undefined): void {
  if (!node) return;
  node.classList.remove("is-new");
  void (node as HTMLElement).offsetWidth;
  node.classList.add("is-new");
}

export function announce(message: string): void {
  const region = document.getElementById("announce");
  if (region) region.textContent = message;
}

/** The SPEC 5 error object, rendered honestly: code, message, and path/file when the API gave them. */
export function errorBox(
  error: { code?: string; message?: string; path?: string; file?: string },
  ...actions: Child[]
): HTMLElement {
  const buttons = flatten(actions);
  return el(
    "div",
    { class: "state state--error", role: "alert" },
    el(
      "p",
      { class: "state__head" },
      el("span", { class: "stamp" }, sign("failed"), "error"),
      " ",
      el("code", {}, error.code ?? "internal_error"),
    ),
    el("p", {}, error.message ?? "The server answered an error with no message in it."),
    error.path || error.file
      ? el(
          "p",
          { class: "help" },
          error.file ? el("span", {}, "In ", el("code", {}, error.file), error.path ? ", " : ".") : null,
          error.path ? el("span", {}, "At ", el("code", {}, error.path), ".") : null,
        )
      : null,
    buttons.length > 0 ? el("div", { class: "row" }, buttons) : null,
  );
}

/** A one-line status the screen is in, for the state region every screen uses. */
export function stateLine(message: string): HTMLElement {
  return el("p", { class: "state", role: "status" }, message);
}

/** Replaces a node's children with a list that may contain nulls, so a conditional child stays one line. */
export function fill(node: Element, children: Child[]): void {
  node.replaceChildren(...flatten(children));
}
