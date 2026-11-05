// Rendering, text form, literal rule and durations (docs/SPEC.md sections 1.2 and 1.3). Parsed once
// here so the engine, CLI and API all agree.

import type { JsonValue, Value, ValueType } from "./types.ts";

export const MAX_TEXT_BYTES = 65536; // 64 KiB, for string and json values
export const MAX_STEP_INPUT_BYTES = 1024 * 1024; // 1 MiB across all rendered inputs of one step

export function renderValue(type: ValueType, value: Value): string {
  switch (type) {
    case "string":
      return value as string;
    case "integer":
    case "number":
      return String(value as number);
    case "boolean":
      return (value as boolean) ? "true" : "false";
    case "json":
      return JSON.stringify(value);
    case "file":
      return value as string;
  }
}

export function stripOneTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

export type TextFormResult =
  | { ok: true; value: Value }
  | { ok: false; code: "output_invalid" | "output_too_large"; message: string };

export function parseTextForm(type: ValueType, text: string): TextFormResult {
  const body = stripOneTrailingNewline(text);
  switch (type) {
    case "string": {
      if (body.includes("\0")) return invalid(`contains a NUL byte`);
      if (utf8Length(body) > MAX_TEXT_BYTES) return tooLarge();
      return { ok: true, value: body };
    }
    case "integer": {
      if (!/^-?(0|[1-9][0-9]*)$/.test(body)) return invalid(`not an integer`);
      const n = Number(body);
      if (!Number.isSafeInteger(n)) return invalid(`integer out of range`);
      return { ok: true, value: n };
    }
    case "number": {
      if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(body)) return invalid(`not a number`);
      const n = Number(body);
      if (!Number.isFinite(n)) return invalid(`not a finite number`);
      return { ok: true, value: n };
    }
    case "boolean": {
      if (body !== "true" && body !== "false") return invalid(`not a boolean`);
      return { ok: true, value: body === "true" };
    }
    case "json": {
      if (utf8Length(body) > MAX_TEXT_BYTES) return tooLarge();
      try {
        return { ok: true, value: JSON.parse(body) as JsonValue };
      } catch {
        return invalid(`not valid JSON`);
      }
    }
    case "file":
      return invalid(`a file value cannot be read from text`);
  }
}

function invalid(message: string): TextFormResult {
  return { ok: false, code: "output_invalid", message };
}

function tooLarge(): TextFormResult {
  return { ok: false, code: "output_too_large", message: `value is over ${MAX_TEXT_BYTES} bytes` };
}

export type LiteralResult =
  | { ok: true; value: Value }
  | { ok: false; message: string };

// The literal rule of section 1.2, checked against a JS value.
export function checkLiteral(type: ValueType, value: unknown): LiteralResult {
  switch (type) {
    case "string":
      if (typeof value !== "string") return { ok: false, message: `expected string, got ${describeValue(value)}` };
      return { ok: true, value };
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        return { ok: false, message: `expected integer, got ${describeValue(value)}` };
      }
      return { ok: true, value };
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, message: `expected number, got ${describeValue(value)}` };
      }
      return { ok: true, value };
    case "boolean":
      if (typeof value !== "boolean") return { ok: false, message: `expected boolean, got ${describeValue(value)}` };
      return { ok: true, value };
    case "json": {
      const json = JSON.stringify(value);
      if (json === undefined) return { ok: false, message: `not representable as JSON` };
      return { ok: true, value: JSON.parse(json) as JsonValue };
    }
    case "file":
      return { ok: false, message: `a file value cannot be written in YAML` };
  }
}

export function canBind(source: ValueType, target: ValueType): boolean {
  if (source === target) return true;
  if (source === "integer" && target === "number") return true;
  if (target === "string" && (source === "integer" || source === "number" || source === "boolean")) return true;
  return false;
}

// Section 3.7 conversion, called only after canBind returned true.
export function coerce(source: ValueType, target: ValueType, value: Value): Value {
  if (source === target) return value;
  if (source === "integer" && target === "number") return value;
  if (target === "string") return renderValue(source, value);
  throw new Error(`cannot coerce ${source} to ${target}`);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// Section 1.3: a day is 86400 seconds, units appear in order. Returns seconds, or null.
export function parseDuration(text: string): number | null {
  if (text === "") return null;
  const m = /^([0-9]+d)?([0-9]+h)?([0-9]+m)?([0-9]+s)?$/.exec(text);
  if (!m) return null;
  const days = m[1] ? Number(m[1]!.slice(0, -1)) : 0;
  const hours = m[2] ? Number(m[2]!.slice(0, -1)) : 0;
  const minutes = m[3] ? Number(m[3]!.slice(0, -1)) : 0;
  const seconds = m[4] ? Number(m[4]!.slice(0, -1)) : 0;
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}
