// Expression parsing (docs/SPEC.md section 3.6). Expressions are read only in `with` string values
// and in top-level `outputs` values; everywhere else `${{` is plain text.

import type { ExpressionRef, TemplatePart, WithValue } from "./types.ts";

const REF_PATTERN =
  "inputs\\.[a-z][a-z0-9_]{0,63}|steps\\.[a-z][a-z0-9_]{0,63}\\.outputs\\.[a-z][a-z0-9_]{0,63}";

const EXPR_PATTERN = `\\$\\{\\{[ \\t]*(${REF_PATTERN})[ \\t]*\\}\\}`;

export const EXPRESSION_RE = new RegExp(EXPR_PATTERN, "g");
export const EXPRESSION_WHOLE_RE = new RegExp(`^${EXPR_PATTERN}$`);

export function parseRef(raw: string): ExpressionRef {
  if (raw.startsWith("inputs.")) return { kind: "inputs", name: raw.slice("inputs.".length) };
  const rest = raw.slice("steps.".length);
  const marker = ".outputs.";
  const at = rest.lastIndexOf(marker);
  return { kind: "step_output", step: rest.slice(0, at), output: rest.slice(at + marker.length) };
}

export type WithStringResult =
  | { ok: true; value: WithValue }
  | { ok: false };

// The expression references inside a with value, for dependency discovery and binding.
export function refsOf(value: WithValue): ExpressionRef[] {
  if (value.kind === "whole") return [value.ref];
  if (value.kind === "template") {
    return value.parts
      .filter((part) => part.kind === "expr")
      .map((part) => (part as { kind: "expr"; ref: ExpressionRef }).ref);
  }
  return [];
}

// A `with` string value is a literal, one whole expression, or a template. Any `${{` that does not
// start a valid expression makes the value invalid.
export function parseWithString(text: string): WithStringResult {
  if (!text.includes("${{")) return { ok: true, value: { kind: "literal", value: text } };

  const matches = [...text.matchAll(new RegExp(EXPR_PATTERN, "g"))];
  const starts: number[] = [];
  let at = text.indexOf("${{");
  while (at !== -1) {
    starts.push(at);
    at = text.indexOf("${{", at + 1);
  }
  if (starts.length !== matches.length || starts.some((start, i) => start !== matches[i]!.index)) {
    return { ok: false };
  }

  const parts: TemplatePart[] = [];
  let cursor = 0;
  for (const match of matches) {
    const start = match.index!;
    if (start > cursor) parts.push({ kind: "text", text: text.slice(cursor, start) });
    parts.push({ kind: "expr", ref: parseRef(match[1]!) });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });

  if (parts.length === 1 && parts[0]!.kind === "expr") {
    return { ok: true, value: { kind: "whole", ref: parts[0]!.ref } };
  }
  return { ok: true, value: { kind: "template", parts } };
}
