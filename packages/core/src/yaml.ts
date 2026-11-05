// The single YAML entry point. docs/SPEC.md section 3.1 pins the parser options: the `yaml` npm
// package with YAML 1.2, the core schema, merge keys disabled and duplicate-key detection. Bun.YAML
// fails three of those, which is why we depend on `yaml` here.

import { isAlias, isMap, isScalar, isSeq, parseAllDocuments } from "yaml";
import type { Document, Node, Scalar, YAMLMap } from "yaml";
import type { JsonValue } from "./types.ts";

export interface ParsedYaml {
  ok: true;
  doc: Document;
  root: Node | null;
}
export type ParsedYamlResult = ParsedYaml | { ok: false; error: string };

export function parseYamlDocument(text: string): ParsedYamlResult {
  let docs: Document[];
  try {
    docs = parseAllDocuments(text, {
      version: "1.2",
      schema: "core",
      merge: false,
      uniqueKeys: true,
    });
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (docs.length !== 1) {
    return { ok: false, error: `expected one YAML document, got ${docs.length}` };
  }
  const doc = docs[0]!;
  if (doc.errors.length > 0) {
    return { ok: false, error: doc.errors.map((error) => error.message).join("; ") };
  }
  return { ok: true, doc, root: doc.contents };
}

export function deref(node: Node | null, doc: Document): Node | null {
  if (node === null) return null;
  return isAlias(node) ? (node.resolve(doc) ?? null) : node;
}

export type NodeKind = "map" | "seq" | "string" | "number" | "boolean" | "null" | "other" | "missing";

export function kindOf(node: Node | null, doc: Document): NodeKind {
  const resolved = deref(node, doc);
  if (resolved === null) return "missing";
  if (isMap(resolved)) return "map";
  if (isSeq(resolved)) return "seq";
  if (isScalar(resolved)) {
    const value = resolved.value;
    if (value === null) return "null";
    if (typeof value === "string") return "string";
    if (typeof value === "number") return "number";
    if (typeof value === "boolean") return "boolean";
    return "other";
  }
  return "other";
}

export type ScalarValue =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "null"; value: null };

export function scalarValue(node: Node | null, doc: Document): ScalarValue | null {
  const resolved = deref(node, doc);
  if (resolved === null || !isScalar(resolved)) return null;
  const value = resolved.value;
  if (value === null) return { type: "null", value: null };
  if (typeof value === "string") return { type: "string", value };
  if (typeof value === "number") return { type: "number", value };
  if (typeof value === "boolean") return { type: "boolean", value };
  return null;
}

export function isStringScalar(node: Node | null, doc: Document): node is Scalar {
  const resolved = deref(node, doc);
  return resolved !== null && isScalar(resolved) && typeof resolved.value === "string";
}

export interface MapEntry {
  key: string | null; // null when the key is not a plain string
  keyNode: Node | null;
  value: Node | null;
}

export function mapEntries(map: YAMLMap, doc: Document): MapEntry[] {
  return map.items.map((pair) => {
    const keyNode = deref((pair.key ?? null) as Node | null, doc);
    const key = keyNode !== null && isScalar(keyNode) && typeof keyNode.value === "string"
      ? keyNode.value
      : null;
    return { key, keyNode, value: deref((pair.value ?? null) as Node | null, doc) };
  });
}

// YAML collection to a plain JSON value, preserving mapping order through JS object key order.
export function nodeToJs(node: Node | null, doc: Document): JsonValue {
  const resolved = deref(node, doc);
  if (resolved === null) return null;
  if (isMap(resolved)) {
    const out: { [key: string]: JsonValue } = {};
    for (const pair of resolved.items) {
      const key = pair.key !== null && isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      out[key] = nodeToJs(pair.value as Node | null, doc);
    }
    return out;
  }
  if (isSeq(resolved)) return resolved.items.map((item) => nodeToJs(item as Node, doc));
  if (isScalar(resolved)) {
    const value = resolved.value;
    if (value === null) return null;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    return null;
  }
  return null;
}
