// The DOM helpers every screen shares: one element factory, the 7x7 state signs, the two formatters,
// the status region and the error box. Ported from mockup/shell.js; the only thing that changed is
// that an error here is always the SPEC 5 object, because that is all the API ever answers with.

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

type Child = Node | string | null | false | undefined | Child[];
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

/** A 7x7 sign, drawn cell by cell so it stays crisp in two inks at any zoom. */
export function sign(state: State, className?: string): SVGElement {
  const cells = SIGNS[state] ?? SIGNS.queued!;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 7 7");
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", className ?? "sign");
  let d = "";
  cells.forEach((row, y) => {
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

export function stateStamp(state: State): HTMLElement {
  return el("span", { class: "stamp" }, sign(state), state);
}

/** Two digits, for the durations that are read as a clock rather than counted. */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Seconds to "4 m 07 s", the way a person reads a duration off a running job. */
export function duration(total: number): string {
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

/** An ISO time from run.json, in the reader's own clock, or nothing when the field is null. */
export function when(iso: string | null): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return new Date(at).toLocaleString();
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

/** A one-line status the screen is in, for the state region the mockup uses everywhere. */
export function stateLine(message: string): HTMLElement {
  return el("p", { class: "state", role: "status" }, message);
}

/** Replaces a node's children with a list that may contain nulls, so a conditional child stays one line. */
export function fill(node: Element, children: Child[]): void {
  node.replaceChildren(...flatten(children));
}
