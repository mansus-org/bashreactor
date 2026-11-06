// Rewrites YAML text for the inspector: set a key, add one, delete one, and every other byte stays
// what the person typed, so a graph edit never eats a comment. The edits are made from the parser's
// source ranges, which is what lets them reach into a flow mapping (`a: { uses: x@1 }`) as well as a
// block one. Each call re-parses, because each one moves the offsets.
//
// What it will not touch it leaves alone, and `editBlocked` says why: a key reached through an alias,
// a node that carries an anchor (rewriting it would orphan the `*alias` that points at it), or a
// value that is a scalar where the path needs a mapping. Returning the text unchanged is the safe
// answer; writing YAML that no longer parses is not.

import type { Node, Pair, YAMLMap } from "yaml";
import { isAlias, isMap as isYamlMap, isScalar, isSeq, parseYamlDocument } from "./yaml-lib.js";
import { contentEnd, formatScalar, keyName, lineAt, lineStarts, pairLoc } from "./yaml.js";
import type { Json } from "./yaml.js";

type Range = [number, number, number];

type Walk =
  | { kind: "blocked"; why: string }
  | { kind: "found"; map: YAMLMap; pair: Pair }
  // The path stops at a key the mapping does not have yet. `map` is null for a document with no mapping.
  | { kind: "missing"; at: number; map: YAMLMap | null; mapPair: Pair | null }
  // A key on the way has no value (`with:`), so what is under it has to be created.
  | { kind: "empty"; at: number; map: YAMLMap; pair: Pair };

const rangeOf = (node: unknown): Range | null => (node as { range?: Range | null } | null)?.range ?? null;
const isNullScalar = (node: unknown): boolean => node === null || node === undefined || (isScalar(node) && node.value === null);

function anchored(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if ((node as { anchor?: string }).anchor !== undefined) return true;
  if (isYamlMap(node) || isSeq(node)) {
    return (node.items as unknown[]).some((item) => {
      const pair = item as { key?: unknown; value?: unknown };
      return "key" in pair ? anchored(pair.key) || anchored(pair.value) : anchored(item);
    });
  }
  return false;
}

function walk(root: Node | null, path: string[]): Walk {
  let node: unknown = root;
  let parent: { map: YAMLMap; pair: Pair } | null = null;
  const here = (at: number): string => path.slice(0, at).join(".") || "the document";
  for (let at = 0; at < path.length; at++) {
    if (isAlias(node)) return { kind: "blocked", why: `${here(at)} is an alias (*), so editing it would edit its anchor` };
    if (!isYamlMap(node)) {
      if (!isNullScalar(node)) return { kind: "blocked", why: `${here(at)} is not a mapping` };
      if (parent === null) return { kind: "missing", at, map: null, mapPair: null };
      return { kind: "empty", at, map: parent.map, pair: parent.pair };
    }
    if (node.anchor !== undefined) return { kind: "blocked", why: `${here(at)} has an anchor (&), and an alias may point at it` };
    const pair = node.items.find((item) => keyName(item) === path[at]);
    if (pair === undefined) return { kind: "missing", at, map: node, mapPair: parent?.pair ?? null };
    if (at === path.length - 1) return { kind: "found", map: node, pair };
    parent = { map: node, pair };
    node = pair.value;
  }
  return { kind: "blocked", why: "the path is empty" };
}

/** Why an edit at this path would be refused, or null when it can be made. */
export function editBlocked(text: string, path: string[]): string | null {
  const parsed = parseYamlDocument(text);
  if (!parsed.ok) return "the YAML does not parse";
  const found = walk(parsed.root, path);
  if (found.kind === "blocked") return found.why;
  if (found.kind === "found" && anchored(found.pair.value)) return `${path.join(".")} holds an anchor (&), and an alias may point at it`;
  return null;
}

/** True when the mapping at this path is written in flow style, `{ ... }`. */
export function isFlowAt(text: string, path: string[]): boolean {
  const parsed = parseYamlDocument(text);
  if (!parsed.ok) return false;
  let node: unknown = parsed.root;
  for (const part of path) {
    if (!isYamlMap(node)) return false;
    node = node.items.find((item) => keyName(item) === part)?.value;
  }
  return isYamlMap(node) && node.flow === true;
}

// ---------- values ----------

const flowText = (value: Json): string => formatScalar(value, true);

/** `{ a: { b: value } }` for the keys that do not exist yet. */
function nestedFlow(keys: string[], value: Json): string {
  if (keys.length === 0) return flowText(value);
  return `{ ${formatScalar(keys[0], true)}: ${nestedFlow(keys.slice(1), value)} }`;
}

/** The lines of a new block entry, `a:` then `b:` indented under it, ending in the value. */
function nestedBlock(keys: string[], value: Json, indent: string): string[] {
  const [first, ...rest] = keys;
  if (rest.length > 0) return [`${indent}${formatScalar(first!)}:`, ...nestedBlock(rest, value, `${indent}  `)];
  const text = formatScalar(value);
  return [text === "" ? `${indent}${formatScalar(first!)}:` : `${indent}${formatScalar(first!)}: ${text}`];
}

// ---------- flow edits, by offset ----------

/** The offset just past a pair: its value, or the key and the colon when the value is empty. */
function pairEnd(text: string, pair: Pair): number {
  const key = rangeOf(pair.key)!;
  const value = rangeOf(pair.value);
  if (value !== null && value[1] > value[0]) return value[1];
  let at = key[1];
  while (at < text.length && /[ \t]/.test(text[at]!)) at++;
  return text[at] === ":" ? at + 1 : key[1];
}

function splice(text: string, from: number, to: number, insert: string): string {
  return text.slice(0, from) + insert + text.slice(to);
}

function setInFlow(text: string, pair: Pair, rendered: string): string {
  const value = rangeOf(pair.value);
  if (value !== null && value[1] > value[0]) return splice(text, value[0], value[1], rendered);
  const end = pairEnd(text, pair);
  return splice(text, end, end, end > rangeOf(pair.key)![1] ? ` ${rendered}` : `: ${rendered}`);
}

function addToFlow(text: string, map: YAMLMap, entry: string): string {
  const range = rangeOf(map)!;
  const last = map.items[map.items.length - 1];
  if (last === undefined) return splice(text, range[0], range[1], `{ ${entry} }`);
  const end = pairEnd(text, last);
  return splice(text, end, end, `, ${entry}`);
}

function removeFromFlow(text: string, map: YAMLMap, pair: Pair): string {
  if (map.items.length === 1) {
    const range = rangeOf(map)!;
    return splice(text, range[0], range[1], "{}");
  }
  const from = rangeOf(pair.key)![0];
  const to = pairEnd(text, pair);
  let after = to;
  while (after < text.length && /\s/.test(text[after]!)) after++;
  if (text[after] === ",") {
    after++;
    while (after < text.length && /[ \t]/.test(text[after]!)) after++;
    return splice(text, from, after, "");
  }
  // The last pair: it is the comma before it that has to go too.
  let before = from;
  while (before > 0 && /\s/.test(text[before - 1]!)) before--;
  return splice(text, text[before - 1] === "," ? before - 1 : from, to, "");
}

// ---------- block edits, by line ----------

const indentOf = (line: string): string => /^[ ]*/.exec(line)![0]!;

/** A pair can be rewritten as whole lines only when nothing else shares its first line. */
function ownsItsLine(text: string, starts: number[], pair: Pair): boolean {
  const key = rangeOf(pair.key)!;
  return /^[ ]*$/.test(text.slice(starts[lineAt(starts, key[0]) - 1]!, key[0]));
}

function dropHollowParent(text: string, path: string[]): string {
  if (path.length <= 1) return text;
  const parsed = parseYamlDocument(text);
  if (!parsed.ok) return text;
  const parent = walk(parsed.root, path.slice(0, -1));
  if (parent.kind !== "found") return text;
  const value = parent.pair.value as Node | null;
  // A key that lost its last child would read back as null, which is a different document.
  const hollow = isNullScalar(value) || (isYamlMap(value) && value.items.length === 0);
  return hollow ? deletePath(text, path.slice(0, -1)) : text;
}

/** Deletes a key. `tidy` takes the blank line above a block entry with it, for a step. */
export function deletePath(text: string, path: string[], tidy = false): string {
  const parsed = parseYamlDocument(text);
  if (!parsed.ok) return text;
  const found = walk(parsed.root, path);
  if (found.kind !== "found" || anchored(found.pair)) return text;
  if (found.map.flow === true) return dropHollowParent(removeFromFlow(text, found.map, found.pair), path);
  const starts = lineStarts(text);
  const loc = pairLoc(found.pair, text, starts);
  if (loc === null || !ownsItsLine(text, starts, found.pair)) return text;
  const lines = text.split("\n");
  const from = tidy && loc.start >= 2 && lines[loc.start - 2]!.trim() === "" ? loc.start - 2 : loc.start - 1;
  lines.splice(from, loc.end - from);
  return dropHollowParent(lines.join("\n"), path);
}

/** Sets a key to a value, creating the keys above it that do not exist; `undefined` deletes it. */
export function setPath(text: string, path: string[], value: Json | undefined): string {
  if (value === undefined) return deletePath(text, path);
  const parsed = parseYamlDocument(text);
  if (!parsed.ok) return text;
  const found = walk(parsed.root, path);
  if (found.kind === "blocked") return text;
  const starts = lineStarts(text);
  const lines = text.split("\n");

  if (found.kind === "found") {
    if (anchored(found.pair.value)) return text;
    if (found.map.flow === true) return setInFlow(text, found.pair, flowText(value));
    const loc = pairLoc(found.pair, text, starts);
    if (loc === null || !ownsItsLine(text, starts, found.pair)) return text;
    const rendered = formatScalar(value);
    const key = formatScalar(path[path.length - 1]!);
    lines.splice(loc.start - 1, loc.end - loc.start + 1, `${indentOf(lines[loc.start - 1]!)}${rendered === "" ? `${key}:` : `${key}: ${rendered}`}`);
    return lines.join("\n");
  }

  if (found.kind === "empty") {
    // `with:` with nothing under it. In a flow mapping the empty value becomes the new one.
    const rest = path.slice(found.at);
    if (found.map.flow === true) return setInFlow(text, found.pair, nestedFlow(rest, value));
    const loc = pairLoc(found.pair, text, starts);
    if (loc === null || !ownsItsLine(text, starts, found.pair)) return text;
    let out = text;
    // `with: ~` has to lose its `~` before anything can nest under it.
    const explicit = rangeOf(found.pair.value);
    if (explicit !== null && explicit[1] > explicit[0]) {
      out = splice(text, text.indexOf(":", rangeOf(found.pair.key)![1]) + 1, explicit[1], "");
    }
    const outLines = out.split("\n");
    outLines.splice(loc.end, 0, ...nestedBlock(rest, value, `${indentOf(outLines[loc.start - 1]!)}  `));
    return outLines.join("\n");
  }

  const rest = path.slice(found.at);
  if (found.map !== null && found.map.flow === true) {
    return addToFlow(text, found.map, `${formatScalar(rest[0]!, true)}: ${nestedFlow(rest.slice(1), value)}`);
  }
  if (found.map === null || found.mapPair === null) {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    lines.push("", ...nestedBlock(rest, value, ""), "");
    return lines.join("\n");
  }
  const first = found.map.items[0];
  const loc = pairLoc(found.mapPair, text, starts);
  if (loc === null) return text;
  const firstLoc = first === undefined ? null : pairLoc(first, text, starts);
  const indent = first !== undefined && firstLoc !== null && ownsItsLine(text, starts, first)
    ? indentOf(lines[firstLoc.start - 1]!)
    : `${indentOf(lines[loc.start - 1]!)}  `;
  const end = Math.max(loc.end, lineAt(starts, contentEnd(text, rangeOf(found.map)![1])));
  lines.splice(end, 0, ...nestedBlock(rest, value, indent));
  return lines.join("\n");
}
