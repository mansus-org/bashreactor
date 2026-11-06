// Reads a pipeline or a block header the way the server does, because it is the server's parser.
//
// The file the API accepts and the file this editor accepts have to be the same file, and a second
// hand-written YAML reader can only drift from the first. So `./yaml-lib.js` is the `yaml` package
// plus `parseYamlDocument` and `nodeToJs` out of @bashreactor/core — the very functions SPEC 3.1 pins
// and the API validates with — bundled once at build time (see yaml-lib.macro.ts). What is left here
// is what the editor needs and the parser does not give: the line range of every key, so a click on
// a node can find its lines in the text, and a one-line message for the first problem.

import { isAlias, isMap as isYamlMap, isScalar, nodeToJs, parseYamlDocument, stringify } from "./yaml-lib.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Loc {
  start: number;
  end: number;
}

export interface YamlError {
  code: string;
  line: number;
  message: string;
}

export type ParseResult = { ok: true; value: Json; locs: Record<string, Loc> } | { ok: false; error: YamlError };

/** The offset of every line start, so a source range can be turned into a line number. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/** 1-based line of a character offset. */
export function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

interface Ranged {
  range?: [number, number, number] | null;
}

/** The offset of the last character of content before `end`, skipping the blanks a range runs over. */
export function contentEnd(text: string, end: number): number {
  let at = Math.min(end, text.length) - 1;
  while (at > 0 && /\s/.test(text[at]!)) at--;
  return Math.max(at, 0);
}

export function keyName(pair: { key: unknown }): string {
  const key = pair.key as { value?: unknown } | null;
  return isScalar(key) ? String(key.value) : String(key);
}

/** The lines a pair occupies: its key's line to the last line with content in its value. */
export function pairLoc(pair: { key: unknown; value: unknown }, text: string, starts: number[]): Loc | null {
  const key = pair.key as Ranged | null;
  if (key?.range == null) return null;
  const value = pair.value as Ranged | null;
  const start = lineAt(starts, key.range[0]);
  // An empty value (`key:`) has a zero-width range sitting just after the colon: its end is the key's.
  const stop = value?.range != null && value.range[1] > value.range[0] ? value.range[1] : key.range[1];
  return { start, end: Math.max(start, lineAt(starts, contentEnd(text, stop))) };
}

function collect(map: { items: unknown[] }, prefix: string, text: string, starts: number[], out: Record<string, Loc>): void {
  for (const item of map.items as { key: unknown; value: unknown }[]) {
    const loc = pairLoc(item, text, starts);
    if (loc === null) continue;
    const name = keyName(item);
    const path = prefix === "" ? name : `${prefix}.${name}`;
    out[path] = loc;
    if (isYamlMap(item.value)) collect(item.value, path, text, starts, out);
  }
}

/** The first error of the parser's message without its code frame, and the line it names. */
function describe(text: string, raw: string): YamlError {
  const at = /\bat line (\d+), column \d+/.exec(raw);
  if (at !== null) {
    return { code: "pipeline_yaml_invalid", line: Number(at[1]), message: raw.slice(0, at.index).trim() + "." };
  }
  // "expected one YAML document, got 2" names no line, so point at the second document's marker.
  const markers = text.split("\n").flatMap((line, index) => (/^---(\s|$)/.test(line) ? [index + 1] : []));
  return { code: "pipeline_yaml_invalid", line: markers[1] ?? markers[0] ?? 1, message: `${raw}.` };
}

export function parse(text: string): ParseResult {
  const parsed = parseYamlDocument(text);
  if (!parsed.ok) return { ok: false, error: describe(text, parsed.error) };
  const locs: Record<string, Loc> = {};
  if (isYamlMap(parsed.root)) collect(parsed.root, "", text, lineStarts(text), locs);
  return { ok: true, value: nodeToJs(parsed.root, parsed.doc) as Json, locs };
}

const FLOW_INDICATOR = /[[\]{},]/;

/**
 * Quotes only what would otherwise read back as something else, and asks the parser that decides
 * what "something else" means rather than guessing from a regex. In a flow collection `,[]{}` end a
 * plain scalar, which is why `${{ x }}` has to be quoted inside `{ }` and does not outside it.
 */
export function formatScalar(value: Json | undefined, flow = false): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const out = stringify(value, { lineWidth: 0, version: "1.2" }).trimEnd();
    // A string with a line break comes back as a block scalar, which cannot sit after `key: `.
    if (out.includes("\n")) return JSON.stringify(value);
    if (flow && FLOW_INDICATOR.test(value) && !/^["']/.test(out)) return JSON.stringify(value);
    return out;
  }
  if (Array.isArray(value)) return `[${value.map((item) => formatScalar(item, true)).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => `${formatScalar(key, true)}: ${formatScalar(item, true)}`);
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  }
  return stringify(value, { lineWidth: 0, version: "1.2" }).trimEnd();
}

export function isMap(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { isAlias, isYamlMap, isScalar };
