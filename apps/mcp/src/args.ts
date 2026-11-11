// Tool arguments, described once and used twice: the same table produces the JSON Schema a client
// sees in `tools/list` and the check every call goes through. The check speaks the API's vocabulary
// — a body is an input document, so an absent field is `missing_input`, an unknown one is
// `unknown_input` and a wrong one is `type_mismatch`, each with the field as its `path` — because an
// agent that mistypes an argument should get the same object it would get from `POST /v1/runs`.

import { errorObject, McpFailure } from "./errors.ts";

export type ArgType = "string" | "integer" | "boolean" | "object" | "array";

export interface ArgSpec {
  type: ArgType;
  description: string;
  required?: boolean;
  /** `integer` only: the smallest accepted value. */
  minimum?: number;
  /** `string` only: the whole value must match. */
  pattern?: string;
  /** `string` only: the only accepted values. */
  enum?: readonly string[];
  /** `object` only: whether keys other than a fixed set are allowed. */
  freeKeys?: boolean;
  /** `array` only: what every element must be. */
  items?: ArgSpec;
}

export type Args = Record<string, ArgSpec>;
export type CheckedArgs = Record<string, unknown>;

export function inputSchema(args: Args): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, spec] of Object.entries(args)) {
    properties[key] = propertySchema(spec);
    if (spec.required === true) required.push(key);
  }
  const schema: Record<string, unknown> = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

function propertySchema(spec: ArgSpec): Record<string, unknown> {
  const property: Record<string, unknown> = { type: spec.type, description: spec.description };
  if (spec.enum !== undefined) property.enum = [...spec.enum];
  if (spec.pattern !== undefined) property.pattern = spec.pattern;
  if (spec.minimum !== undefined) property.minimum = spec.minimum;
  if (spec.type === "object") property.additionalProperties = spec.freeKeys !== false;
  if (spec.type === "array" && spec.items !== undefined) property.items = propertySchema(spec.items);
  return property;
}

/** The arguments of a call, checked against the table. Throws `McpFailure` with the field as path. */
export function checkArgs(tool: string, raw: unknown, args: Args): CheckedArgs {
  if (raw === undefined || raw === null) return check(tool, {}, args);
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new McpFailure(errorObject("type_mismatch", `the arguments of ${tool} must be a JSON object`));
  }
  return check(tool, raw as Record<string, unknown>, args);
}

function check(tool: string, raw: Record<string, unknown>, args: Args): CheckedArgs {
  for (const key of Object.keys(raw)) {
    if (args[key] === undefined) {
      throw new McpFailure(errorObject("unknown_input", `"${key}" is not an argument of ${tool}`, { path: key }));
    }
  }

  const out: CheckedArgs = {};
  for (const [key, spec] of Object.entries(args)) {
    const value = raw[key];
    if (value === undefined) {
      if (spec.required === true) {
        throw new McpFailure(errorObject("missing_input", `"${key}" is required: ${spec.description}`, { path: key }));
      }
      continue;
    }
    out[key] = one(key, spec, value);
  }
  return out;
}

function one(key: string, spec: ArgSpec, value: unknown): unknown {
  const path = key;
  switch (spec.type) {
    case "string": {
      if (typeof value !== "string") {
        throw new McpFailure(errorObject("type_mismatch", `"${key}" must be a string`, { path }));
      }
      if (spec.enum !== undefined && !spec.enum.includes(value)) {
        throw new McpFailure(
          errorObject("type_mismatch", `"${key}" must be one of ${spec.enum.join(", ")}`, { path }),
        );
      }
      if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(value)) {
        throw new McpFailure(
          errorObject("type_mismatch", `"${key}" must match ${spec.pattern}, got "${value}"`, { path }),
        );
      }
      return value;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new McpFailure(errorObject("type_mismatch", `"${key}" must be an integer`, { path }));
      }
      if (spec.minimum !== undefined && value < spec.minimum) {
        throw new McpFailure(
          errorObject("type_mismatch", `"${key}" must be ${spec.minimum} or more, got ${value}`, { path }),
        );
      }
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw new McpFailure(errorObject("type_mismatch", `"${key}" must be true or false`, { path }));
      }
      return value;
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new McpFailure(errorObject("type_mismatch", `"${key}" must be a JSON object`, { path }));
      }
      return value;
    }
    case "array": {
      if (!Array.isArray(value)) {
        throw new McpFailure(errorObject("type_mismatch", `"${key}" must be an array`, { path }));
      }
      const items = spec.items;
      return items === undefined ? value : value.map((item) => one(key, items, item));
    }
  }
}
