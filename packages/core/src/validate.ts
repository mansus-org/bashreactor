// Validation. docs/SPEC.md section 3.9 owns the table; this reports every broken rule, not only
// the first, and returns nothing else. A rule that depends on something already broken (for example
// a type check on a step whose block did not load) is not evaluated.

import { isMap, isSeq } from "yaml";
import type { Document, Node, YAMLMap, YAMLSeq } from "yaml";
import { splitBlockHeader } from "./block-header.ts";
import type { ErrorCode } from "./errors.ts";
import { parseWithString, refsOf } from "./expressions.ts";
import {
  BLOCK_NAME_RE,
  DEFAULT_KILL_GRACE_SECONDS,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_SECONDS,
  ENV_NAME_RE,
  IO_NAME_RE,
  RESERVED_ENV_NAMES,
  VALUE_TYPES,
  isLibraryRef,
  isPathRef,
} from "./types.ts";
import type {
  Block,
  BlockInput,
  ExpressionRef,
  Pipeline,
  PipelineInput,
  PipelineOutput,
  PipelineStep,
  Retry,
  Value,
  ValueType,
  WithEntry,
  WithValue,
} from "./types.ts";
import { canBind, checkLiteral, parseDuration } from "./values.ts";
import { deref, kindOf, mapEntries, nodeToJs, parseYamlDocument, scalarValue } from "./yaml.ts";
import type { MapEntry } from "./yaml.ts";

export interface ValidationIssue {
  code: ErrorCode;
  path?: string;
  message: string;
}

export interface BlockResolver {
  resolve(uses: string): { ok: true; source: string } | { ok: false };
}

const BLOCK_TOP_KEYS = new Set(["name", "description", "inputs", "outputs"]);
const BLOCK_INPUT_KEYS = new Set(["type", "description", "default"]);
const BLOCK_OUTPUT_KEYS = new Set(["type", "description"]);
const PIPELINE_TOP_KEYS = new Set(["name", "description", "max_parallel", "inputs", "steps", "outputs"]);
const STEP_KEYS = new Set(["name", "uses", "needs", "with", "pass_env", "timeout", "kill_grace", "retry"]);
const RETRY_KEYS = new Set(["max_attempts", "delay", "backoff", "max_delay"]);

// --- public entry points -------------------------------------------------

export function validateBlockSource(source: string): ValidationIssue[] {
  const split = splitBlockHeader(source);
  if (!split.ok) return [{ code: "block_header_malformed", message: split.error }];
  const yaml = parseYamlDocument(split.header);
  if (!yaml.ok) return [{ code: "block_header_malformed", message: yaml.error }];
  if (!isMap(yaml.root)) return [{ code: "block_header_malformed", message: "the header must be a mapping" }];
  return buildBlock(yaml.root, yaml.doc).issues;
}

export function validatePipelineSource(source: string, resolve: BlockResolver): ValidationIssue[] {
  const yaml = parseYamlDocument(source);
  if (!yaml.ok) return [{ code: "pipeline_yaml_invalid", message: yaml.error }];
  const { pipeline, issues } = buildPipeline(yaml.root, yaml.doc);
  if (pipeline === null) return issues;
  return [...issues, ...validatePipelineBlocks(pipeline, resolve)];
}

// --- block schema (section 2.3) -----------------------------------------

export function buildBlock(root: YAMLMap, doc: Document): { block: Block | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const entries = mapEntries(root, doc);
  for (const entry of entries) {
    if (entry.key === null || !BLOCK_TOP_KEYS.has(entry.key)) {
      issues.push({ code: "block_schema_invalid", path: entry.key ?? "(non-string key)", message: "unknown key" });
    }
  }

  const nameNode = findEntry(entries, "name");
  let name = "";
  if (nameNode === undefined) {
    issues.push({ code: "block_schema_invalid", path: "name", message: "name is required" });
  } else {
    const sv = scalarValue(nameNode.value, doc);
    if (sv === null || sv.type !== "string") {
      issues.push({ code: "block_schema_invalid", path: "name", message: "name must be a string" });
    } else if (!BLOCK_NAME_RE.test(sv.value)) {
      issues.push({ code: "block_schema_invalid", path: "name", message: "name must match the block name rule" });
    } else {
      name = sv.value;
    }
  }

  const description = stringField(entries, "description", "description", doc, issues, "block_schema_invalid");
  const inputs = buildParams(root, doc, "inputs", true, issues);
  const outputs = buildParams(root, doc, "outputs", false, issues);

  const block: Block = { name, description, inputs, outputs };
  return { block: issues.length === 0 ? block : null, issues };
}

function buildParams(
  root: YAMLMap,
  doc: Document,
  section: "inputs" | "outputs",
  allowDefault: boolean,
  issues: ValidationIssue[],
): BlockInput[] {
  const result: BlockInput[] = [];
  const entry = findEntry(mapEntries(root, doc), section);
  if (entry === undefined) return result;

  const kind = kindOf(entry.value, doc);
  if (kind === "null") {
    issues.push({ code: "block_schema_invalid", path: section, message: `${section} must be a mapping, not left empty` });
    return result;
  }
  if (kind !== "map") {
    issues.push({ code: "block_schema_invalid", path: section, message: `${section} must be a mapping` });
    return result;
  }

  const map = deref(entry.value, doc) as YAMLMap;
  for (const param of mapEntries(map, doc)) {
    const rawName = param.key;
    const displayName = rawName ?? "(non-string key)";
    if (rawName === null || !IO_NAME_RE.test(rawName)) {
      issues.push({
        code: "block_schema_invalid",
        path: `${section}.${displayName}`,
        message: "name must match the input/output name rule",
      });
    }
    const built = buildParam(section, displayName, param.value, doc, allowDefault, issues);
    if (rawName !== null && IO_NAME_RE.test(rawName)) result.push(built);
  }
  return result;
}

function buildParam(
  section: "inputs" | "outputs",
  name: string,
  value: Node | null,
  doc: Document,
  allowDefault: boolean,
  issues: ValidationIssue[],
): BlockInput {
  const path = `${section}.${name}`;
  if (!isMap(deref(value, doc))) {
    issues.push({ code: "block_schema_invalid", path, message: "must be a mapping" });
    return { name, type: "string", description: "" };
  }
  const paramEntries = mapEntries(deref(value, doc) as YAMLMap, doc);
  const allowed = allowDefault ? BLOCK_INPUT_KEYS : BLOCK_OUTPUT_KEYS;
  for (const pe of paramEntries) {
    if (pe.key === null || !allowed.has(pe.key)) {
      issues.push({
        code: "block_schema_invalid",
        path: `${path}.${pe.key ?? "(non-string key)"}`,
        message: "unknown key",
      });
    }
  }

  let type: ValueType | null = null;
  const typeEntry = findEntry(paramEntries, "type");
  if (typeEntry === undefined) {
    issues.push({ code: "block_schema_invalid", path: `${path}.type`, message: "type is required" });
  } else {
    const sv = scalarValue(typeEntry.value, doc);
    if (sv === null || sv.type !== "string" || !VALUE_TYPES.includes(sv.value as ValueType)) {
      issues.push({
        code: "block_schema_invalid",
        path: `${path}.type`,
        message: "type must be one of the six types",
      });
    } else {
      type = sv.value as ValueType;
    }
  }

  const description = stringField(
    paramEntries,
    "description",
    `${path}.description`,
    doc,
    issues,
    "block_schema_invalid",
  );

  let defaultValue: Value | undefined;
  const defaultEntry = findEntry(paramEntries, "default");
  if (defaultEntry !== undefined) {
    if (!allowDefault) {
      // `default` under an output was already reported as an unknown key.
    } else if (type === "file") {
      issues.push({
        code: "block_schema_invalid",
        path: `${path}.default`,
        message: "a file input cannot have a default",
      });
    } else if (type !== null) {
      const literal = checkLiteral(type, nodeToJs(defaultEntry.value, doc));
      if (!literal.ok) {
        issues.push({ code: "block_schema_invalid", path: `${path}.default`, message: literal.message });
      } else {
        defaultValue = literal.value;
      }
    }
  }

  return { name, type: type ?? "string", description, default: defaultValue };
}

// --- pipeline schema (sections 3.2-3.6) ---------------------------------

export function buildPipeline(root: Node | null, doc: Document): { pipeline: Pipeline | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (!isMap(root)) {
    issues.push({ code: "pipeline_schema_invalid", path: "name", message: "name is required" });
    issues.push({ code: "pipeline_schema_invalid", path: "steps", message: "steps is required" });
    return { pipeline: null, issues };
  }

  const entries = mapEntries(root, doc);
  for (const entry of entries) {
    if (entry.key === null || !PIPELINE_TOP_KEYS.has(entry.key)) {
      issues.push({ code: "pipeline_schema_invalid", path: entry.key ?? "(non-string key)", message: "unknown key" });
    }
  }

  const name = nameField(entries, "name", "name", doc, issues, "pipeline_schema_invalid");
  const description = stringField(entries, "description", "description", doc, issues, "pipeline_schema_invalid");
  const maxParallel = intField(entries, "max_parallel", "max_parallel", doc, issues, "pipeline_schema_invalid", DEFAULT_MAX_PARALLEL, 1);
  const inputs = buildParams(root, doc, "inputs", true, issues) as PipelineInput[];
  const steps = buildSteps(root, doc, issues);
  const outputs = buildOutputs(root, doc, issues);

  const inputNames = new Set(inputs.map((input) => input.name));
  const stepIds = new Set(steps.map((step) => step.id));
  const exprStepsByStep = new Map<string, Set<string>>();

  for (const step of steps) {
    const exprSteps = new Set<string>();
    for (const entry of step.with) {
      for (const ref of refsOf(entry.value)) {
        if (ref.kind === "inputs") {
          if (!inputNames.has(ref.name)) {
            issues.push({
              code: "unknown_input",
              path: `steps.${step.id}.with.${entry.name}`,
              message: `unknown pipeline input "${ref.name}"`,
            });
          }
        } else if (!stepIds.has(ref.step)) {
          issues.push({
            code: "unknown_step",
            path: `steps.${step.id}.with.${entry.name}`,
            message: `unknown step "${ref.step}"`,
          });
        } else {
          exprSteps.add(ref.step);
        }
      }
    }
    exprStepsByStep.set(step.id, exprSteps);
  }

  for (const output of outputs) {
    if (output.ref.kind === "step_output" && !stepIds.has(output.ref.step)) {
      issues.push({ code: "unknown_step", path: `outputs.${output.name}`, message: `unknown step "${output.ref.step}"` });
    }
  }

  for (const step of steps) {
    step.needs.forEach((need, index) => {
      if (!stepIds.has(need)) {
        issues.push({ code: "unknown_step", path: `steps.${step.id}.needs.${index}`, message: `unknown step "${need}"` });
      }
    });
  }

  reportCycles(steps, exprStepsByStep, issues);

  const pipeline: Pipeline = { name, description, max_parallel: maxParallel, inputs, steps, outputs };
  return { pipeline, issues };
}

function buildSteps(root: YAMLMap, doc: Document, issues: ValidationIssue[]): PipelineStep[] {
  const steps: PipelineStep[] = [];
  const entry = findEntry(mapEntries(root, doc), "steps");
  if (entry === undefined) {
    issues.push({ code: "pipeline_schema_invalid", path: "steps", message: "steps is required" });
    return steps;
  }
  const kind = kindOf(entry.value, doc);
  if (kind === "null" || (kind === "map" && (deref(entry.value, doc) as YAMLMap).items.length === 0)) {
    issues.push({ code: "pipeline_schema_invalid", path: "steps", message: "steps must name at least one step" });
    return steps;
  }
  if (kind !== "map") {
    issues.push({ code: "pipeline_schema_invalid", path: "steps", message: "steps must be a mapping" });
    return steps;
  }

  const stepsMap = deref(entry.value, doc) as YAMLMap;
  for (const stepEntry of mapEntries(stepsMap, doc)) {
    const id = stepEntry.key;
    if (id === null || !IO_NAME_RE.test(id)) {
      issues.push({
        code: "pipeline_schema_invalid",
        path: `steps.${id ?? "(non-string key)"}`,
        message: "step id must match the step id rule",
      });
      continue;
    }
    if (!isMap(deref(stepEntry.value, doc))) {
      issues.push({ code: "pipeline_schema_invalid", path: `steps.${id}`, message: "must be a mapping" });
      continue;
    }
    steps.push(buildStep(id, deref(stepEntry.value, doc) as YAMLMap, doc, issues));
  }
  return steps;
}

function buildStep(id: string, map: YAMLMap, doc: Document, issues: ValidationIssue[]): PipelineStep {
  const path = `steps.${id}`;
  const entries = mapEntries(map, doc);
  for (const entry of entries) {
    if (entry.key === null || !STEP_KEYS.has(entry.key)) {
      issues.push({ code: "pipeline_schema_invalid", path: `${path}.${entry.key ?? "(non-string key)"}`, message: "unknown key" });
    }
  }

  const name = stringField(entries, "name", `${path}.name`, doc, issues, "pipeline_schema_invalid", id);

  let uses = "";
  const usesEntry = findEntry(entries, "uses");
  if (usesEntry === undefined) {
    issues.push({ code: "pipeline_schema_invalid", path: `${path}.uses`, message: "uses is required" });
  } else {
    const sv = scalarValue(usesEntry.value, doc);
    if (sv === null || sv.type !== "string") {
      issues.push({ code: "pipeline_schema_invalid", path: `${path}.uses`, message: "uses must be a string" });
    } else if (!isPathRef(sv.value) && !isLibraryRef(sv.value)) {
      issues.push({ code: "pipeline_schema_invalid", path: `${path}.uses`, message: "uses must be a relative path or a library reference" });
    } else {
      uses = sv.value;
    }
  }

  const needs = needsField(entries, "needs", `${path}.needs`, doc, issues);
  const passEnv = passEnvField(entries, "pass_env", `${path}.pass_env`, doc, issues);
  const timeout = durationField(entries, "timeout", `${path}.timeout`, doc, issues, "pipeline_schema_invalid", DEFAULT_TIMEOUT_SECONDS, true);
  const killGrace = durationField(entries, "kill_grace", `${path}.kill_grace`, doc, issues, "pipeline_schema_invalid", DEFAULT_KILL_GRACE_SECONDS, false);
  const retry = retryField(entries, `${path}.retry`, doc, issues);
  const withEntries = withField(entries, `${path}.with`, doc, issues);

  return { id, name, uses, needs, with: withEntries, pass_env: passEnv, timeout, kill_grace: killGrace, retry };
}

function buildOutputs(root: YAMLMap, doc: Document, issues: ValidationIssue[]): PipelineOutput[] {
  const result: PipelineOutput[] = [];
  const entry = findEntry(mapEntries(root, doc), "outputs");
  if (entry === undefined) return result;
  const kind = kindOf(entry.value, doc);
  if (kind === "null") {
    issues.push({ code: "pipeline_schema_invalid", path: "outputs", message: "outputs must be a mapping, not left empty" });
    return result;
  }
  if (kind !== "map") {
    issues.push({ code: "pipeline_schema_invalid", path: "outputs", message: "outputs must be a mapping" });
    return result;
  }
  const map = deref(entry.value, doc) as YAMLMap;
  for (const outputEntry of mapEntries(map, doc)) {
    const outputName = outputEntry.key;
    if (outputName === null || !IO_NAME_RE.test(outputName)) {
      issues.push({
        code: "pipeline_schema_invalid",
        path: `outputs.${outputName ?? "(non-string key)"}`,
        message: "output name must match the output name rule",
      });
      continue;
    }
    const sv = scalarValue(outputEntry.value, doc);
    if (sv === null || sv.type !== "string") {
      issues.push({ code: "expression_invalid", path: `outputs.${outputName}`, message: "outputs must be whole expressions" });
      continue;
    }
    const parsed = parseWithString(sv.value);
    if (!parsed.ok || parsed.value.kind !== "whole" || parsed.value.ref.kind !== "step_output") {
      issues.push({ code: "expression_invalid", path: `outputs.${outputName}`, message: "outputs must be whole expressions" });
      continue;
    }
    result.push({ name: outputName, ref: parsed.value.ref });
  }
  return result;
}

function retryField(entries: MapEntry[], path: string, doc: Document, issues: ValidationIssue[]): Retry {
  const entry = findEntry(entries, "retry");
  if (entry === undefined) return { ...DEFAULT_RETRY };
  if (!isMap(deref(entry.value, doc))) {
    issues.push({ code: "pipeline_schema_invalid", path, message: "retry must be a mapping" });
    return { ...DEFAULT_RETRY };
  }
  const retryEntries = mapEntries(deref(entry.value, doc) as YAMLMap, doc);
  for (const re of retryEntries) {
    if (re.key === null || !RETRY_KEYS.has(re.key)) {
      issues.push({ code: "pipeline_schema_invalid", path: `${path}.${re.key ?? "(non-string key)"}`, message: "unknown key" });
    }
  }
  const maxAttempts = intField(retryEntries, "max_attempts", `${path}.max_attempts`, doc, issues, "pipeline_schema_invalid", 1, 1);
  const delay = durationField(retryEntries, "delay", `${path}.delay`, doc, issues, "pipeline_schema_invalid", DEFAULT_RETRY.delay, false);
  const backoff = numberField(retryEntries, "backoff", `${path}.backoff`, doc, issues, DEFAULT_RETRY.backoff, 1);
  const maxDelay = durationField(retryEntries, "max_delay", `${path}.max_delay`, doc, issues, "pipeline_schema_invalid", Math.max(3600, delay), false);
  if (maxDelay < delay) {
    issues.push({ code: "pipeline_schema_invalid", path: `${path}.max_delay`, message: "max_delay must not be below delay" });
  }
  return { max_attempts: maxAttempts, delay, backoff, max_delay: maxDelay };
}

function withField(entries: MapEntry[], path: string, doc: Document, issues: ValidationIssue[]): WithEntry[] {
  const result: WithEntry[] = [];
  const entry = findEntry(entries, "with");
  if (entry === undefined) return result;
  const kind = kindOf(entry.value, doc);
  if (kind === "null") {
    issues.push({ code: "pipeline_schema_invalid", path, message: "with must be a mapping, not left empty" });
    return result;
  }
  if (kind !== "map") {
    issues.push({ code: "pipeline_schema_invalid", path, message: "with must be a mapping" });
    return result;
  }
  const map = deref(entry.value, doc) as YAMLMap;
  for (const withEntry of mapEntries(map, doc)) {
    const withName = withEntry.key;
    if (withName === null || !IO_NAME_RE.test(withName)) {
      issues.push({
        code: "pipeline_schema_invalid",
        path: `${path}.${withName ?? "(non-string key)"}`,
        message: "with key must match the input name rule",
      });
      continue;
    }
    const valueKind = kindOf(withEntry.value, doc);
    if (valueKind === "string") {
      const sv = scalarValue(withEntry.value, doc)!;
      const parsed = parseWithString(sv.value as string);
      if (!parsed.ok) {
        issues.push({ code: "expression_invalid", path: `${path}.${withName}`, message: "invalid expression" });
        continue;
      }
      result.push({ name: withName, value: parsed.value });
    } else if (valueKind === "number" || valueKind === "boolean" || valueKind === "null" || valueKind === "map" || valueKind === "seq") {
      result.push({ name: withName, value: { kind: "literal", value: nodeToJs(withEntry.value, doc) } });
    } else {
      issues.push({ code: "pipeline_schema_invalid", path: `${path}.${withName}`, message: "with value is missing" });
    }
  }
  return result;
}

// --- field helpers -------------------------------------------------------

function findEntry(entries: MapEntry[], key: string): MapEntry | undefined {
  return entries.find((entry) => entry.key === key);
}

function nameField(
  entries: MapEntry[],
  key: string,
  path: string,
  doc: Document,
  issues: ValidationIssue[],
  code: ErrorCode,
): string {
  const entry = findEntry(entries, key);
  if (entry === undefined) {
    issues.push({ code, path, message: `${key} is required` });
    return "";
  }
  const sv = scalarValue(entry.value, doc);
  if (sv === null || sv.type !== "string") {
    issues.push({ code, path, message: `${key} must be a string` });
    return "";
  }
  if (!BLOCK_NAME_RE.test(sv.value)) {
    issues.push({ code, path, message: `${key} must match the name rule` });
    return "";
  }
  return sv.value;
}

function stringField(
  entries: MapEntry[],
  key: string,
  path: string,
  doc: Document,
  issues: ValidationIssue[],
  code: ErrorCode,
  fallback = "",
): string {
  const entry = findEntry(entries, key);
  if (entry === undefined) return fallback;
  const sv = scalarValue(entry.value, doc);
  if (sv === null || sv.type !== "string") {
    issues.push({ code, path, message: `${key} must be a string` });
    return fallback;
  }
  return sv.value;
}

function intField(
  entries: MapEntry[],
  key: string,
  path: string,
  doc: Document,
  issues: ValidationIssue[],
  code: ErrorCode,
  fallback: number,
  min: number,
): number {
  const entry = findEntry(entries, key);
  if (entry === undefined) return fallback;
  const sv = scalarValue(entry.value, doc);
  if (sv === null || sv.type !== "number" || !Number.isInteger(sv.value) || sv.value < min) {
    issues.push({ code, path, message: `${key} must be an integer of at least ${min}` });
    return fallback;
  }
  return sv.value;
}

function numberField(
  entries: MapEntry[],
  key: string,
  path: string,
  doc: Document,
  issues: ValidationIssue[],
  fallback: number,
  min: number,
): number {
  const entry = findEntry(entries, key);
  if (entry === undefined) return fallback;
  const sv = scalarValue(entry.value, doc);
  if (sv === null || sv.type !== "number" || !Number.isFinite(sv.value) || sv.value < min) {
    issues.push({ code: "pipeline_schema_invalid", path, message: `${key} must be a number of at least ${min}` });
    return fallback;
  }
  return sv.value;
}

function durationField(
  entries: MapEntry[],
  key: string,
  path: string,
  doc: Document,
  issues: ValidationIssue[],
  code: ErrorCode,
  fallback: number,
  mustBePositive: boolean,
): number {
  const entry = findEntry(entries, key);
  if (entry === undefined) return fallback;
  const sv = scalarValue(entry.value, doc);
  if (sv === null || sv.type !== "string") {
    issues.push({ code, path, message: `${key} must be a duration string` });
    return fallback;
  }
  const seconds = parseDuration(sv.value);
  if (seconds === null) {
    issues.push({ code, path, message: `${key} must be a duration` });
    return fallback;
  }
  if (mustBePositive && seconds <= 0) {
    issues.push({ code, path, message: `${key} must be above zero` });
    return fallback;
  }
  return seconds;
}

function needsField(entries: MapEntry[], key: string, path: string, doc: Document, issues: ValidationIssue[]): string[] {
  const result: string[] = [];
  const entry = findEntry(entries, key);
  if (entry === undefined) return result;
  if (!isSeq(deref(entry.value, doc))) {
    issues.push({ code: "pipeline_schema_invalid", path, message: `${key} must be a list` });
    return result;
  }
  (deref(entry.value, doc) as YAMLSeq).items.forEach((item: unknown, index: number) => {
    const sv = scalarValue(item as Node, doc);
    if (sv === null || sv.type !== "string") {
      issues.push({ code: "pipeline_schema_invalid", path: `${path}.${index}`, message: `${key} entries must be strings` });
      return;
    }
    if (!IO_NAME_RE.test(sv.value)) {
      issues.push({ code: "pipeline_schema_invalid", path: `${path}.${index}`, message: `${key} entries must match the step id rule` });
      return;
    }
    if (result.includes(sv.value)) {
      issues.push({ code: "pipeline_schema_invalid", path, message: `${key} has a repeat` });
      return;
    }
    result.push(sv.value);
  });
  return result;
}

function passEnvField(entries: MapEntry[], key: string, path: string, doc: Document, issues: ValidationIssue[]): string[] {
  const result: string[] = [];
  const entry = findEntry(entries, key);
  if (entry === undefined) return result;
  if (!isSeq(deref(entry.value, doc))) {
    issues.push({ code: "pipeline_schema_invalid", path, message: `${key} must be a list` });
    return result;
  }
  (deref(entry.value, doc) as YAMLSeq).items.forEach((item: unknown, index: number) => {
    const sv = scalarValue(item as Node, doc);
    if (sv === null || sv.type !== "string") {
      issues.push({ code: "pipeline_schema_invalid", path: `${path}.${index}`, message: `${key} entries must be strings` });
      return;
    }
    const value = sv.value;
    const reserved = RESERVED_ENV_NAMES.includes(value)
      || value.startsWith("BR_")
      || value.startsWith("INPUT_")
      || value.startsWith("OUTPUT_");
    if (!ENV_NAME_RE.test(value) || reserved) {
      issues.push({ code: "pipeline_schema_invalid", path: `${path}.${index}`, message: `${key} entry is not a passable environment variable name` });
      return;
    }
    if (result.includes(value)) {
      issues.push({ code: "pipeline_schema_invalid", path, message: `${key} has a repeat` });
      return;
    }
    result.push(value);
  });
  return result;
}

// --- block-aware validation (section 3.9, the rows that need headers) ---

export function validatePipelineBlocks(pipeline: Pipeline, resolver: BlockResolver): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  type Loaded = Block | "invalid" | "unresolved";
  const blocks = new Map<string, Loaded>();

  for (const step of pipeline.steps) {
    if (!isPathRef(step.uses) && !isLibraryRef(step.uses)) {
      blocks.set(step.id, "invalid");
      continue;
    }
    const resolved = resolver.resolve(step.uses);
    if (!resolved.ok) {
      issues.push({ code: "block_not_found", path: `steps.${step.id}.uses`, message: `block "${step.uses}" was not found` });
      blocks.set(step.id, "unresolved");
      continue;
    }
    const blockIssues = validateBlockSource(resolved.source);
    if (blockIssues.length > 0) {
      for (const blockIssue of blockIssues) {
        issues.push({ code: blockIssue.code, path: `steps.${step.id}.uses`, message: blockIssue.message });
      }
      blocks.set(step.id, "invalid");
      continue;
    }
    const block = buildBlockSafe(resolved.source);
    blocks.set(step.id, block);
    if (isLibraryRef(step.uses)) {
      const refName = step.uses.slice(0, step.uses.indexOf("@"));
      if (block.name !== refName) {
        issues.push({
          code: "block_schema_invalid",
          path: `steps.${step.id}.uses`,
          message: `block name "${block.name}" does not match the library reference`,
        });
      }
    }
  }

  const inputTypes = new Map(pipeline.inputs.map((input) => [input.name, input.type]));

  for (const step of pipeline.steps) {
    const block = blocks.get(step.id);
    if (block === "invalid" || block === "unresolved" || block === undefined) continue;
    const blockInputs = new Map(block.inputs.map((input) => [input.name, input]));
    const provided = new Set<string>();
    for (const entry of step.with) {
      provided.add(entry.name);
      const input = blockInputs.get(entry.name);
      const path = `steps.${step.id}.with.${entry.name}`;
      if (input === undefined) {
        issues.push({ code: "unknown_input", path, message: `"${entry.name}" is not an input of the block` });
        continue;
      }
      for (const ref of refsOf(entry.value)) {
        if (ref.kind !== "step_output") continue;
        const source = blocks.get(ref.step);
        if (source !== "invalid" && source !== "unresolved" && source !== undefined) {
          if (!source.outputs.some((output) => output.name === ref.output)) {
            issues.push({ code: "unknown_output", path, message: `step "${ref.step}" has no output "${ref.output}"` });
          }
        }
      }
      const typeError = checkWithType(entry.value, input.type, path, inputTypes, blocks);
      if (typeError !== null) issues.push(typeError);
    }
    for (const input of block.inputs) {
      if (input.default === undefined && !provided.has(input.name)) {
        issues.push({
          code: "missing_input",
          path: `steps.${step.id}.with.${input.name}`,
          message: `required input "${input.name}" is not provided`,
        });
      }
    }
  }

  for (const output of pipeline.outputs) {
    const ref = output.ref;
    if (ref.kind !== "step_output") continue;
    const source = blocks.get(ref.step);
    if (source === "invalid" || source === "unresolved" || source === undefined) continue;
    if (!source.outputs.some((o) => o.name === ref.output)) {
      issues.push({
        code: "unknown_output",
        path: `outputs.${output.name}`,
        message: `step "${ref.step}" has no output "${ref.output}"`,
      });
    }
  }

  return issues;
}

function buildBlockSafe(source: string): Block {
  const split = splitBlockHeader(source);
  if (!split.ok) throw new Error("unreachable: block header was already validated");
  const yaml = parseYamlDocument(split.header);
  if (!yaml.ok || !isMap(yaml.root)) throw new Error("unreachable: block header was already validated");
  const { block } = buildBlock(yaml.root, yaml.doc);
  return block!;
}

function checkWithType(
  value: WithValue,
  targetType: ValueType,
  path: string,
  inputTypes: Map<string, ValueType>,
  blocks: Map<string, Block | "invalid" | "unresolved">,
): ValidationIssue | null {
  if (value.kind === "literal") {
    const literal = checkLiteral(targetType, value.value);
    if (!literal.ok) return { code: "type_mismatch", path, message: literal.message };
    return null;
  }
  if (value.kind === "whole") {
    const source = typeOfRef(value.ref, inputTypes, blocks);
    if (source === null) return null;
    if (!canBind(source, targetType)) {
      return { code: "type_mismatch", path, message: `cannot bind ${source} to ${targetType}` };
    }
    return null;
  }
  if (targetType !== "string") {
    return { code: "type_mismatch", path, message: `a template only binds to string, not ${targetType}` };
  }
  for (const part of value.parts) {
    if (part.kind !== "expr") continue;
    const source = typeOfRef(part.ref, inputTypes, blocks);
    if (source === null) continue;
    if (source !== "string" && source !== "integer" && source !== "number" && source !== "boolean") {
      return { code: "type_mismatch", path, message: `cannot embed ${source} in a template` };
    }
  }
  return null;
}

function typeOfRef(
  ref: ExpressionRef,
  inputTypes: Map<string, ValueType>,
  blocks: Map<string, Block | "invalid" | "unresolved">,
): ValueType | null {
  if (ref.kind === "inputs") return inputTypes.get(ref.name) ?? null;
  const block = blocks.get(ref.step);
  if (block === "invalid" || block === "unresolved" || block === undefined) return null;
  return block.outputs.find((output) => output.name === ref.output)?.type ?? null;
}

// --- dependency cycles (section 3.9) ------------------------------------

function reportCycles(steps: PipelineStep[], exprStepsByStep: Map<string, Set<string>>, issues: ValidationIssue[]): void {
  const index = new Map(steps.map((step, i) => [step.id, i]));
  const adjacency: number[][] = steps.map((step) => {
    const deps = new Set<number>();
    for (const need of step.needs) {
      const i = index.get(need);
      if (i !== undefined) deps.add(i);
    }
    for (const exprStep of exprStepsByStep.get(step.id) ?? []) {
      const i = index.get(exprStep);
      if (i !== undefined) deps.add(i);
    }
    return [...deps];
  });

  for (const component of tarjan(adjacency)) {
    const isCycle = component.length > 1 || (component.length === 1 && adjacency[component[0]!]!.includes(component[0]!));
    if (!isCycle) continue;
    const firstIndex = Math.min(...component);
    const cycle = findCyclePath(firstIndex, adjacency);
    issues.push({
      code: "dependency_cycle",
      path: `steps.${steps[firstIndex]!.id}.needs`,
      message: `dependency cycle: ${cycle.map((i) => steps[i]!.id).join(" -> ")}`,
    });
  }
}

function findCyclePath(start: number, adjacency: number[][]): number[] {
  const path = [start];
  const seen = new Set<number>([start]);
  const visit = (node: number): number[] | null => {
    for (const dep of adjacency[node]!) {
      if (dep === start) return [...path, start];
      if (seen.has(dep)) continue;
      seen.add(dep);
      path.push(dep);
      const found = visit(dep);
      if (found !== null) return found;
      path.pop();
    }
    return null;
  };
  return visit(start) ?? [start, start];
}

function tarjan(adjacency: number[][]): number[][] {
  const n = adjacency.length;
  const index = Array.from({ length: n }, () => -1);
  const low = Array.from({ length: n }, () => 0);
  const onStack = Array.from({ length: n }, () => false);
  const stack: number[] = [];
  let counter = 0;
  const components: number[][] = [];

  const strongconnect = (v: number): void => {
    index[v] = counter;
    low[v] = counter;
    counter += 1;
    stack.push(v);
    onStack[v] = true;
    for (const w of adjacency[v]!) {
      if (index[w] === -1) {
        strongconnect(w);
        low[v] = Math.min(low[v]!, low[w]!);
      } else if (onStack[w]) {
        low[v] = Math.min(low[v]!, index[w]!);
      }
    }
    if (low[v] === index[v]) {
      const component: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack[w] = false;
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  };

  for (let v = 0; v < n; v++) {
    if (index[v] === -1) strongconnect(v);
  }
  return components;
}
