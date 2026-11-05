// Reading a request body as a small set of typed fields, so a wrong body is a spec error object with
// a path rather than a crash three functions down. The codes are the spec's: a body is an input
// document, so an absent field is missing_input, an unknown one is unknown_input and a wrong one is
// type_mismatch — the same three the spec uses for a pipeline's `with`.

import type { Value } from "@bashreactor/core";
import { ApiError } from "./errors.ts";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface Body {
  raw: Record<string, unknown>;
}

export async function readBody(request: Request, known: readonly string[]): Promise<Body> {
  const header = request.headers.get("content-length");
  if (header !== null && Number(header) > MAX_BODY_BYTES) {
    throw new ApiError("type_mismatch", `the body is larger than ${MAX_BODY_BYTES} bytes`);
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new ApiError("type_mismatch", `the body is larger than ${MAX_BODY_BYTES} bytes`);
  }
  if (text.trim() === "") return { raw: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ApiError("type_mismatch", `the body is not JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError("type_mismatch", "the body must be a JSON object");
  }
  return { raw: only(parsed as Record<string, unknown>, known) };
}

function only(raw: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) {
      throw new ApiError("unknown_input", `"${key}" is not a field of this request`, { path: key });
    }
  }
  return raw;
}

export function requireString(body: Body, key: string): string {
  const value = body.raw[key];
  if (value === undefined) throw new ApiError("missing_input", `"${key}" is required`, { path: key });
  return stringOf(body, key);
}

export function optionalString(body: Body, key: string): string | undefined {
  return body.raw[key] === undefined ? undefined : stringOf(body, key);
}

export function optionalInteger(body: Body, key: string): number | undefined {
  const value = body.raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ApiError("type_mismatch", `"${key}" must be an integer`, { path: key });
  }
  return value;
}

export function optionalInputs(body: Body, key: string): Record<string, Value> {
  const value = body.raw[key];
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("type_mismatch", `"${key}" must be a JSON object`, { path: key });
  }
  // The engine checks every value against the pipeline's declared inputs (SPEC 3.3); the API only
  // checks that it is an object at all.
  return value as Record<string, Value>;
}

function stringOf(body: Body, key: string): string {
  const value = body.raw[key];
  if (typeof value !== "string") {
    throw new ApiError("type_mismatch", `"${key}" must be a string`, { path: key });
  }
  return value;
}

/** A path or query value that must be a positive integer, e.g. an attempt number. */
export function parseIntegerParam(name: string, value: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new ApiError("type_mismatch", `${name} must be an integer of ${minimum} or more`, { path: name });
  }
  return parsed;
}
