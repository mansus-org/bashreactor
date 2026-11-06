// The document model: YAML text goes in, the steps, wires and problems come out, and every edit from
// the graph side is a change to the text. Nothing here stores a pipeline, so the graph and the YAML
// cannot drift apart. Ported from mockup/model.js.
//
// Two things changed on the way in. The block library is what the API serves — `GET /v1/blocks/:name`
// and its `.../content` — so a step's contract is read from the bytes of the version it names, and
// `uses` takes the library form `name@version` (SPEC 3.4) as well as the path form. And the problem
// codes are the SPEC 5 ones, so a problem the editor found locally reads the way the API's would.

import { formatScalar, isMap, parse } from "./yaml.js";
import type { Json, Loc, YamlError } from "./yaml.js";

export interface LibraryVersion {
  version: number;
  source: string;
}

export interface LibraryEntry {
  name: string;
  versions: LibraryVersion[];
}

/** What the editor knows of the library so far: only the blocks this document names. */
export type Library = Record<string, LibraryEntry>;

export interface Problem {
  code: string;
  line: number;
  message: string;
  step: string | null;
}

export interface Decl {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default: Json;
}

export interface Contract {
  name: string | null;
  description: string;
  runtime: string;
  inputs: Decl[];
  outputs: Decl[];
  problems: Problem[];
}

export type Ref =
  | { kind: "output"; step: string; output: string }
  | { kind: "input"; name: string }
  | { kind: "invalid"; text: string };

export interface Source {
  kind: "unset" | "input" | "output" | "template" | "literal";
  value: Json;
  refs: Ref[];
}

export interface StepInput {
  name: string;
  type: string;
  required: boolean;
  default: Json;
  description: string;
  source: Source;
}

export interface Edge {
  from: string;
  to: string;
  out?: string;
  in?: string;
  kind: "data" | "needs";
}

export interface Step {
  id: string;
  raw: { [key: string]: Json };
  range: Loc;
  title: string;
  uses: string | null;
  blockName: string | null;
  version: number | null;
  /** True when `uses` named a version, which is the only form the API can run. */
  pinned: boolean;
  contract: Contract | null;
  needs: string[];
  deps: string[];
  timeout: string | null;
  maxAttempts: Json;
  delay: Json;
  inputs: StepInput[];
  outputs: Decl[];
  layer: number;
}

export interface PipelineOutput {
  name: string;
  value: string;
  refs: Ref[];
}

export interface Analysis {
  ok: true;
  name: string;
  description: string;
  maxParallel: number;
  inputs: Decl[];
  outputs: PipelineOutput[];
  steps: Step[];
  byId: Record<string, Step>;
  order: string[];
  layers: string[][];
  edges: Edge[];
  problems: Problem[];
  locs: Record<string, Loc>;
}

export interface FailedAnalysis {
  ok: false;
  error: YamlError;
  problems: Problem[];
}

export type Read = Analysis | FailedAnalysis;

const REF = /\$\{\{\s*(.+?)\s*\}\}/g;
const TOP_KEYS = ["name", "description", "max_parallel", "inputs", "steps", "outputs"];
const STEP_KEYS = ["name", "uses", "needs", "with", "timeout", "retry"];
const RETRY_KEYS = ["max_attempts", "delay"];
const DURATION = /^\d+(s|m|h|d)$/;
const LIBRARY_REF = /^([a-z][a-z0-9-]{0,63})@([1-9][0-9]*)$/;
const PATH_REF = /^\.\/([a-z][a-z0-9-]{0,63})\.sh$/;

function problem(code: string, line: number, message: string, step: string | null = null): Problem {
  return { code, line, message, step };
}

/** `name@3` and `./name.sh`, both of which SPEC 3.4 allows. Only the first one runs from the API. */
export function readUses(uses: string): { name: string; version: number | null } | null {
  const library = LIBRARY_REF.exec(uses);
  if (library !== null) return { name: library[1]!, version: Number(library[2]) };
  const path = PATH_REF.exec(uses);
  if (path !== null) return { name: path[1]!, version: null };
  return null;
}

export function libraryRef(name: string, version: number): string {
  return `${name}@${version}`;
}

function readRef(expr: string): Ref {
  const output = /^steps\.([\w-]+)\.outputs\.([\w-]+)$/.exec(expr);
  if (output !== null) return { kind: "output", step: output[1]!, output: output[2]! };
  const input = /^inputs\.([\w-]+)$/.exec(expr);
  if (input !== null) return { kind: "input", name: input[1]! };
  return { kind: "invalid", text: expr };
}

function refsIn(value: Json): Ref[] {
  if (typeof value !== "string") return [];
  return [...value.matchAll(REF)].map((match) => readRef(match[1]!));
}

// One value is a plain reference, a string with references in it, or a literal.
function readSource(value: Json, has: boolean): Source {
  if (!has) return { kind: "unset", value: null, refs: [] };
  const refs = refsIn(value);
  if (refs.length === 1 && typeof value === "string" && value.replace(REF, "").trim() === "") {
    return { kind: refs[0]!.kind === "invalid" ? "literal" : (refs[0]!.kind as "input" | "output"), value, refs };
  }
  return { kind: refs.length > 0 ? "template" : "literal", value, refs };
}

const outputRef = (step: string, output: string) => `\${{ steps.${step}.outputs.${output} }}`;
const inputRef = (name: string) => `\${{ inputs.${name} }}`;

// ---------- block files ----------

// The spec has no runtime field: a block is always a bash file, and uv or bun are what it hands over
// to. So the stamp is read from the script itself.
function detectRuntime(body: string): string {
  const match = /^\s*(?:exec\s+)?(uv|bun)\s+run\b/m.exec(body);
  return match !== null ? match[1]! : "bash";
}

/** A block's contract, read out of its own comment header — never from a sidecar list. */
export function parseBlock(source: string): Contract {
  const out: Contract = { name: null, description: "", runtime: "bash", inputs: [], outputs: [], problems: [] };
  const lines = source.split("\n");
  const open = lines[0] !== undefined && lines[0].startsWith("#!") ? 1 : 0;
  if ((lines[open] ?? "").trim() !== "# ---") {
    out.problems.push(problem("block_header_malformed", open + 1, 'A block starts with front matter: a "# ---" line after the shebang.'));
    return out;
  }
  const start = open + 1;
  let close = start;
  while (close < lines.length && (lines[close] ?? "").trim() !== "# ---") close++;
  if (close >= lines.length) {
    out.problems.push(problem("block_header_malformed", start, 'The front matter needs a closing "# ---" line.'));
    return out;
  }
  const bad = lines.slice(start, close).findIndex((line) => !/^#( |$)/.test(line));
  if (bad !== -1) {
    out.problems.push(problem("block_header_malformed", start + bad + 1, "Every front matter line starts with a # and a space."));
    return out;
  }
  const parsed = parse(lines.slice(start, close).map((line) => line.replace(/^# ?/, "")).join("\n"));
  if (!parsed.ok) {
    out.problems.push(problem("block_header_malformed", parsed.error.line + start, parsed.error.message));
    return out;
  }
  const front = isMap(parsed.value) ? parsed.value : {};
  out.name = front.name !== undefined && front.name !== null ? String(front.name) : null;
  out.description = front.description !== undefined ? String(front.description) : "";
  out.runtime = detectRuntime(lines.slice(close + 1).join("\n"));
  if (out.name === null) out.problems.push(problem("block_schema_invalid", start + 1, 'The front matter needs a "name".'));

  const declared = (map: Json | undefined, kind: string): Decl[] =>
    Object.entries(isMap(map) ? map : {}).map(([name, raw]) => {
      const decl = isMap(raw) ? raw : {};
      if (decl.type === undefined) {
        out.problems.push(
          problem("block_schema_invalid", (parsed.ok && parsed.locs[`${kind}.${name}`]?.start ? parsed.locs[`${kind}.${name}`]!.start : 0) + start, `${name} needs a "type".`),
        );
      }
      const hasDefault = Object.prototype.hasOwnProperty.call(decl, "default");
      return {
        name,
        type: decl.type !== undefined ? String(decl.type) : "unknown",
        description: decl.description !== undefined ? String(decl.description) : "",
        required: !hasDefault,
        default: hasDefault ? (decl.default as Json) ?? null : null,
      };
    });
  out.inputs = declared(front.inputs, "inputs");
  out.outputs = declared(front.outputs, "outputs");
  return out;
}

export function latest(entry: LibraryEntry): LibraryVersion {
  return entry.versions[entry.versions.length - 1]!;
}

// ---------- pipeline analysis ----------

export function analyze(text: string, library: Library): Read {
  const parsed = parse(text);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
      problems: [problem(parsed.error.code, parsed.error.line, parsed.error.message)],
    };
  }

  const locs = parsed.locs;
  const root = isMap(parsed.value) ? parsed.value : {};
  const problems: Problem[] = [];
  const lineOf = (path: string, fallback = 1): number => (locs[path] !== undefined ? locs[path]!.start : fallback);

  if (root.name === undefined || root.name === null) problems.push(problem("pipeline_schema_invalid", 1, 'The pipeline needs a "name".'));
  for (const key of Object.keys(root)) {
    if (!TOP_KEYS.includes(key)) problems.push(problem("pipeline_schema_invalid", lineOf(key), `A pipeline has no "${key}" key.`));
  }
  if (root.max_parallel !== undefined && !(Number.isInteger(root.max_parallel) && Number(root.max_parallel) > 0)) {
    problems.push(problem("pipeline_schema_invalid", lineOf("max_parallel"), '"max_parallel" is a whole number, 1 or more.'));
  }

  const inputs = isMap(root.inputs) ? root.inputs : {};
  if (root.steps !== undefined && root.steps !== null && !isMap(root.steps)) {
    problems.push(problem("pipeline_schema_invalid", lineOf("steps"), '"steps" is a map of step ids.'));
  }
  const rawSteps = isMap(root.steps) ? root.steps : {};

  const steps: Step[] = Object.keys(rawSteps).map((id) => {
    const path = `steps.${id}`;
    const raw = isMap(rawSteps[id]) ? (rawSteps[id] as { [key: string]: Json }) : {};
    const range = locs[path] ?? { start: lineOf(path), end: lineOf(path) };
    const retry = isMap(raw.retry) ? raw.retry : raw.retry !== undefined && raw.retry !== null ? null : undefined;
    const step: Step = {
      id,
      raw,
      range,
      title: raw.name !== undefined && raw.name !== null ? String(raw.name) : "",
      uses: raw.uses !== undefined && raw.uses !== null ? String(raw.uses) : null,
      blockName: null,
      version: null,
      pinned: false,
      contract: null,
      needs: [],
      deps: [],
      timeout: raw.timeout === undefined || raw.timeout === null ? null : String(raw.timeout),
      maxAttempts: retry && retry.max_attempts !== undefined ? (retry.max_attempts as Json) : null,
      delay: retry && retry.delay !== undefined ? (retry.delay as Json) : null,
      inputs: [],
      outputs: [],
      layer: 0,
    };

    for (const key of Object.keys(raw)) {
      if (!STEP_KEYS.includes(key)) {
        problems.push(problem("pipeline_schema_invalid", lineOf(`${path}.${key}`, range.start), `Steps have no "${key}" key.`, id));
      }
    }
    if (retry === null) {
      problems.push(problem("pipeline_schema_invalid", lineOf(`${path}.retry`), '"retry" is a map with max_attempts and delay.', id));
    } else if (retry !== undefined) {
      for (const key of Object.keys(retry)) {
        if (!RETRY_KEYS.includes(key)) {
          problems.push(problem("pipeline_schema_invalid", lineOf(`${path}.retry.${key}`), `"retry" has no "${key}" key.`, id));
        }
      }
      if (retry.max_attempts !== undefined && !(Number.isInteger(retry.max_attempts) && Number(retry.max_attempts) > 0)) {
        problems.push(problem("pipeline_schema_invalid", lineOf(`${path}.retry.max_attempts`), '"max_attempts" is a whole number, 1 or more.', id));
      }
      if (retry.delay !== undefined && !DURATION.test(String(retry.delay))) {
        problems.push(problem("pipeline_schema_invalid", lineOf(`${path}.retry.delay`), "Delays read like 1s, 30s or 5m.", id));
      }
    }

    if (raw.uses === undefined || raw.uses === null) {
      problems.push(problem("pipeline_schema_invalid", range.start, `Step ${id} needs "uses", the block it runs.`, id));
    } else {
      const uses = String(raw.uses);
      const line = lineOf(`${path}.uses`, range.start);
      const ref = readUses(uses);
      if (ref === null) {
        problems.push(problem("pipeline_schema_invalid", line, 'Write "uses" as a library block like count-words@2, or a path like ./count-words.sh.', id));
      } else {
        step.blockName = ref.name;
        step.pinned = ref.version !== null;
        const entry = library[ref.name];
        if (entry === undefined) {
          problems.push(problem("block_not_found", line, `There is no block ${ref.name} in the library.`, id));
        } else if (ref.version !== null) {
          const version = entry.versions.find((v) => v.version === ref.version);
          if (version === undefined) {
            problems.push(problem("block_not_found", line, `The library has no version ${ref.version} of ${ref.name}; it has up to ${latest(entry).version}.`, id));
          } else {
            step.version = ref.version;
            step.contract = parseBlock(version.source);
          }
        } else {
          // A path reference is legal in the spec, and the API stages runs from the library, so the
          // step cannot run as written. The contract still draws, from the newest version.
          const current = latest(entry);
          step.version = current.version;
          step.contract = parseBlock(current.source);
          problems.push(
            problem("block_not_found", line, `${uses} is a file beside the pipeline, and the API runs blocks from the library. The library has ${libraryRef(ref.name, current.version)}.`, id),
          );
        }
      }
    }

    if (raw.needs !== undefined && raw.needs !== null) {
      step.needs = (Array.isArray(raw.needs) ? raw.needs : [raw.needs]).map(String);
    }
    if (raw.timeout !== undefined && raw.timeout !== null && !DURATION.test(String(raw.timeout))) {
      problems.push(problem("pipeline_schema_invalid", lineOf(`${path}.timeout`), "Timeouts read like 90s, 15m, 6h or 2d.", id));
    }
    return step;
  });

  const byId: Record<string, Step> = Object.fromEntries(steps.map((step) => [step.id, step]));
  const edges: Edge[] = [];

  const checkRefs = (refs: Ref[], line: number, step: string | null): void => {
    for (const ref of refs) {
      if (ref.kind === "invalid") {
        problems.push(problem("expression_invalid", line, `"${ref.text}" is not a reference this schema has.`, step));
      }
      if (ref.kind === "input" && inputs[ref.name] === undefined) {
        problems.push(problem("expression_invalid", line, `The pipeline has no input called ${ref.name}.`, step));
      }
      if (ref.kind === "output") {
        const from = byId[ref.step];
        if (from === undefined) problems.push(problem("unknown_step", line, `There is no step called ${ref.step}.`, step));
        else if (from.contract !== null && !from.contract.outputs.some((o) => o.name === ref.output)) {
          problems.push(problem("unknown_output", line, `${from.uses} has no output called ${ref.output}.`, step));
        }
      }
    }
  };

  for (const step of steps) {
    const path = `steps.${step.id}`;
    for (const need of step.needs) {
      if (byId[need] === undefined) {
        problems.push(problem("unknown_step", lineOf(`${path}.needs`), `Step ${step.id} needs ${need}, which does not exist.`, step.id));
      }
    }

    const given = isMap(step.raw.with) ? step.raw.with : {};
    const declared = step.contract !== null ? step.contract.inputs : [];
    const fedBy = new Set<string>();

    const describe = (name: string, decl: Decl | null): StepInput => {
      const has = Object.prototype.hasOwnProperty.call(given, name);
      const line = lineOf(`${path}.with.${name}`, step.range.start);
      const source = readSource((given[name] as Json) ?? null, has);
      checkRefs(source.refs, line, step.id);
      for (const ref of source.refs) {
        if (ref.kind !== "output") continue;
        const from = byId[ref.step];
        if (from !== undefined && (from.contract === null || from.contract.outputs.some((o) => o.name === ref.output))) {
          fedBy.add(ref.step);
          edges.push({ from: ref.step, out: ref.output, to: step.id, in: name, kind: "data" });
        }
      }
      if (!has && decl !== null && decl.required) {
        problems.push(problem("missing_input", step.range.start, `Step ${step.id} has to set input ${name}.`, step.id));
      }
      if (has && decl === null && step.contract !== null) {
        problems.push(problem("unknown_input", line, `${step.uses} has no input called ${name}.`, step.id));
      }
      return {
        name,
        type: decl !== null ? decl.type : "unknown",
        required: decl !== null ? decl.required : false,
        default: decl !== null ? decl.default : null,
        description: decl !== null ? decl.description : "",
        source,
      };
    };

    step.inputs = declared.map((decl) => describe(decl.name, decl));
    // Keys the block does not declare still draw, so the wire stays visible next to its problem.
    for (const key of Object.keys(given)) {
      if (!declared.some((decl) => decl.name === key)) step.inputs.push(describe(key, null));
    }
    step.outputs = step.contract !== null ? step.contract.outputs : [];

    // A reference is a dependency by itself. "needs" only adds order without data.
    step.deps = [...new Set([...fedBy, ...step.needs.filter((need) => byId[need] !== undefined)])];
    for (const need of step.deps) {
      if (!fedBy.has(need)) edges.push({ from: need, to: step.id, kind: "needs" });
    }
  }

  const outputs: PipelineOutput[] = Object.entries(isMap(root.outputs) ? root.outputs : {}).map(([name, value]) => {
    const refs = refsIn(value);
    checkRefs(refs, lineOf(`outputs.${name}`), null);
    return { name, value: value === null ? "" : String(value), refs };
  });

  // Kahn's algorithm: whatever it cannot place is in a cycle. Those steps still get a layer, in
  // document order, so a broken graph is drawn and not hidden.
  const order: string[] = [];
  const layerOf: Record<string, number> = {};
  const pending = new Map(steps.map((step) => [step.id, new Set(step.deps)]));
  while (pending.size > 0) {
    const ready = [...pending].filter(([, deps]) => [...deps].every((dep) => !pending.has(dep))).map(([id]) => id);
    if (ready.length === 0) {
      const stuck = [...pending.keys()];
      problems.push(problem("dependency_cycle", lineOf(`steps.${stuck[0]}`), `These steps wait for each other: ${stuck.join(", ")}.`, stuck[0] ?? null));
      for (const id of stuck) {
        const deps = (byId[id]?.deps ?? []).filter((dep) => layerOf[dep] !== undefined);
        layerOf[id] = deps.length > 0 ? Math.max(...deps.map((dep) => layerOf[dep]!)) : 0;
        order.push(id);
        pending.delete(id);
      }
      break;
    }
    for (const id of ready) {
      const deps = [...(pending.get(id) ?? [])].filter((dep) => layerOf[dep] !== undefined);
      layerOf[id] = deps.length > 0 ? Math.max(...deps.map((dep) => layerOf[dep]!)) : 0;
      order.push(id);
      pending.delete(id);
    }
  }
  for (const step of steps) step.layer = layerOf[step.id] ?? 0;
  const layers: string[][] = [];
  for (const id of order) {
    const layer = layerOf[id] ?? 0;
    (layers[layer] ??= []).push(id);
  }

  problems.sort((a, b) => a.line - b.line);
  return {
    ok: true,
    name: root.name !== undefined && root.name !== null ? String(root.name) : "",
    description: root.description !== undefined ? String(root.description) : "",
    maxParallel: Number.isInteger(root.max_parallel) && Number(root.max_parallel) > 0 ? Number(root.max_parallel) : Number.POSITIVE_INFINITY,
    inputs: Object.keys(inputs).map((name) => {
      const raw = isMap(inputs[name]) ? (inputs[name] as { [key: string]: Json }) : {};
      const hasDefault = Object.prototype.hasOwnProperty.call(raw, "default");
      return {
        name,
        type: raw.type !== undefined ? String(raw.type) : "string",
        description: raw.description !== undefined ? String(raw.description) : "",
        required: !hasDefault,
        default: hasDefault ? (raw.default as Json) ?? null : null,
      };
    }),
    outputs,
    steps,
    byId,
    order,
    layers: layers.filter((layer) => layer !== undefined && layer.length > 0),
    edges,
    problems,
    locs,
  };
}

/** Which step the caret is inside, so typing in the YAML keeps the graph selection in step. */
export function stepAtLine(analysis: Read, line: number): string | null {
  if (!analysis.ok) return null;
  const hit = analysis.steps.find((step) => line >= step.range.start && line <= step.range.end);
  return hit !== undefined ? hit.id : null;
}

// ---------- edits: text in, text out ----------

function formatValue(value: Json): string {
  return Array.isArray(value) ? `[${value.map((item) => formatScalar(item)).join(", ")}]` : formatScalar(value);
}

/**
 * Sets or deletes one key and leaves every other line byte for byte what the person typed, so a
 * graph edit never eats a comment. Each step re-parses, because each one moves the lines.
 */
export function setPath(text: string, path: string[], value: Json | undefined): string {
  const parsed = parse(text);
  if (!parsed.ok) return text;
  const key = path.join(".");
  const parentPath = path.slice(0, -1);
  const parentKey = parentPath.join(".");
  const lines = text.split("\n");
  const here = parsed.locs[key];

  if (value === undefined) {
    if (here === undefined) return text;
    lines.splice(here.start - 1, here.end - here.start + 1);
    const next = lines.join("\n");
    // A key that lost its last child would read back as null, which is a different document.
    if (parentPath.length > 0) {
      const after = parse(next);
      if (after.ok) {
        const parentValue = parentPath.reduce<Json>((current, part) => {
          return isMap(current) ? (current[part] as Json) ?? null : null;
        }, after.value);
        if (parentValue === null) return setPath(next, parentPath, undefined);
      }
    }
    return next;
  }

  const leaf = path[path.length - 1]!;
  if (here !== undefined) {
    const indent = /^[ ]*/.exec(lines[here.start - 1]!)![0]!;
    lines.splice(here.start - 1, here.end - here.start + 1, `${indent}${leaf}: ${formatValue(value)}`);
    return lines.join("\n");
  }

  const parent = parentPath.length > 0 ? parsed.locs[parentKey] : undefined;
  if (parentPath.length > 0 && parent === undefined) {
    return setPath(setPath(text, parentPath, null), path, value);
  }
  if (parentPath.length === 0) {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    lines.push("", value === null ? `${leaf}:` : `${leaf}: ${formatValue(value)}`, "");
    return lines.join("\n");
  }
  const indent = `${/^[ ]*/.exec(lines[parent!.start - 1]!)![0]!}  `;
  lines.splice(parent!.end, 0, value === null ? `${indent}${leaf}:` : `${indent}${leaf}: ${formatValue(value)}`);
  return lines.join("\n");
}

export function editStep(text: string, id: string, key: string, value: Json | undefined): string {
  return setPath(text, ["steps", id, ...key.split(".")], value);
}

export function addStep(text: string, analysis: Analysis, id: string, step: { uses: string; title?: string }): string {
  const lines = text.split("\n");
  const body = [`  ${id}:`];
  if (step.title) body.push(`    name: ${formatScalar(step.title)}`);
  body.push(`    uses: ${step.uses}`);
  if (analysis.steps.length > 0) {
    lines.splice(analysis.steps[analysis.steps.length - 1]!.range.end, 0, "", ...body);
  } else if (analysis.locs.steps !== undefined) {
    lines.splice(analysis.locs.steps.start - 1, 1, "steps:", ...body);
  } else {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    lines.push("", "steps:", ...body, "");
  }
  return lines.join("\n");
}

/** Removing a step also takes it out of everything that used it. Otherwise one click would leave a
 *  problem on every step downstream. */
export function removeStep(text: string, analysis: Analysis, id: string): string {
  let next = text;
  for (const output of analysis.outputs) {
    if (output.refs.some((ref) => ref.kind === "output" && ref.step === id)) next = setPath(next, ["outputs", output.name], undefined);
  }
  for (const step of analysis.steps) {
    if (step.id === id) continue;
    for (const input of step.inputs) {
      if (input.source.refs.some((ref) => ref.kind === "output" && ref.step === id)) {
        next = editStep(next, step.id, `with.${input.name}`, undefined);
      }
    }
    if (step.needs.includes(id)) {
      const left = step.needs.filter((need) => need !== id);
      next = editStep(next, step.id, "needs", left.length > 0 ? left : undefined);
    }
  }
  const reparsed = parse(next);
  const range = reparsed.ok ? reparsed.locs[`steps.${id}`] : undefined;
  if (range === undefined) return next;
  const lines = next.split("\n");
  const hasBlankBefore = range.start >= 2 && lines[range.start - 2]!.trim() === "";
  const from = hasBlankBefore ? range.start - 2 : range.start - 1;
  lines.splice(from, range.end - from);
  return lines.join("\n");
}

/** Every step whose path reference the library could answer with a version. */
export function rewrites(text: string, analysis: Analysis, library: Library): { step: string; uses: string }[] {
  if (!analysis.ok) return [];
  const out: { step: string; uses: string }[] = [];
  for (const step of analysis.steps) {
    if (step.pinned || step.blockName === null || step.version === null) continue;
    if (library[step.blockName] === undefined) continue;
    out.push({ step: step.id, uses: libraryRef(step.blockName, step.version) });
  }
  void text;
  return out;
}

/** Rewrites every path reference the library can answer, one text edit each. */
export function pinToLibrary(text: string, analysis: Analysis, library: Library): string {
  let next = text;
  for (const change of rewrites(next, analysis, library)) {
    next = editStep(next, change.step, "uses", change.uses);
  }
  return next;
}

// ---------- what a step can read from ----------

/** Everything not downstream is a legal source. Downstream would make a cycle, so it is not offered. */
export function sourcesFor(analysis: Analysis, id: string): { value: string; label: string }[] {
  const downstream = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of analysis.steps) {
      if (!downstream.has(step.id) && step.deps.some((dep) => downstream.has(dep))) {
        downstream.add(step.id);
        grew = true;
      }
    }
  }
  const out = analysis.inputs.map((input) => ({ value: inputRef(input.name), label: `Pipeline input ${input.name}` }));
  for (const step of analysis.steps) {
    if (downstream.has(step.id)) continue;
    for (const output of step.outputs) out.push({ value: outputRef(step.id, output.name), label: `${step.id}, output ${output.name}` });
  }
  return out;
}

/** The steps that could not run before this one finishes, for the "needs" checkboxes. */
export function wouldCycle(analysis: Analysis, id: string, candidate: string): boolean {
  const seen = new Set<string>();
  const walk = (at: string): boolean => {
    if (at === id) return true;
    if (seen.has(at)) return false;
    seen.add(at);
    return (analysis.byId[at]?.deps ?? []).some(walk);
  };
  return walk(candidate);
}
