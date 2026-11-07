// Handing a stored pipeline to the engine.
//
// The engine resolves `uses` as a path next to the pipeline file it is given (SPEC 3.4), and has no
// block library of its own: a `name@version` reference is `block_not_found` there. The library lives
// in packages/store, which the engine must not depend on (SPEC 4.2). So the API stages a run: it
// writes the pipeline into a throwaway directory, drops the bytes of every library block beside it,
// and rewrites those `uses` to the file the engine can read. The engine then snapshots everything
// into the run directory, and the staging directory is deleted.
//
// A pipeline with no library reference is staged byte for byte. One with a library reference is
// staged as the same document re-emitted in JSON, which is valid YAML (SPEC 3.1 reads it with the
// core schema) and cannot change a value on the way. The stored pipeline version keeps the YAML
// exactly as it was written; only the snapshot the engine sees is re-emitted.
//
// Open item for the engine: give it a block resolver and this file goes away.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isLibraryRef, kindOf, mapEntries, nodeToJs, parseYamlDocument } from "@bashreactor/core";
import type { JsonValue } from "@bashreactor/core";

export interface StagedPipeline {
  /** Absolute path of the pipeline file to hand to the engine. */
  path: string;
  /** Removes the staging directory. The engine has snapshotted everything by then. */
  cleanup(): void;
}

export interface StageOptions {
  /** Directory the staging directories are made in, e.g. `<dataDir>/stage`. */
  baseDir: string;
  yaml: string;
  /** The block library: bytes of `name@version`, or null when the store has no such version. */
  resolveBlock(name: string, version: number): Uint8Array | null;
}

type Parsed = Extract<ReturnType<typeof parseYamlDocument>, { ok: true }>;
type YamlNode = Parameters<typeof kindOf>[0];
type YamlMap = Parameters<typeof mapEntries>[0];

export function stagePipeline(options: StageOptions): StagedPipeline {
  mkdirSync(options.baseDir, { recursive: true });
  const dir = mkdtempSync(join(options.baseDir, "pipeline-"));

  // Everything past the mkdir can throw on a document the caller chose, and a caller that never got
  // the `cleanup` back has no way to remove the directory. So the thrower does it here: a refused
  // request leaves nothing in `<dataDir>/stage`, which is what makes `validate` create nothing.
  try {
    const file = join(dir, "pipeline.yaml");
    const parsed = parseYamlDocument(options.yaml);
    const rewrites = parsed.ok ? libraryRefs(parsed, dir, options.resolveBlock) : new Map<string, string>();

    let source = options.yaml;
    if (rewrites.size > 0 && parsed.ok) {
      source = `${JSON.stringify(rewrite(parsed, rewrites), null, 2)}\n`;
    }
    writeFileSync(file, source);

    return { path: file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** step id -> `name@version`, for every step whose library block the store can supply. */
function libraryRefs(
  parsed: Parsed,
  dir: string,
  resolveBlock: StageOptions["resolveBlock"],
): Map<string, string> {
  const rewrites = new Map<string, string>();
  // A document that is not a mapping has no steps to rewrite. The engine reports it as
  // `pipeline_schema_invalid`; reading it as one here is what turned a scalar into a crash.
  if (kindOf(parsed.root, parsed.doc) !== "map") return rewrites;

  const stepsEntry = entriesOf(parsed, parsed.root).find((entry) => entry.key === "steps");
  if (stepsEntry === undefined || stepsEntry.value === null) return rewrites;
  const stepsNode = stepsEntry.value;
  if (kindOf(stepsNode, parsed.doc) !== "map") return rewrites;

  for (const step of entriesOf(parsed, stepsNode)) {
    if (step.key === null || step.value === null) continue;
    const stepNode = step.value;
    if (kindOf(stepNode, parsed.doc) !== "map") continue;
    const usesEntry = entriesOf(parsed, stepNode).find((entry) => entry.key === "uses");
    if (usesEntry === undefined || usesEntry.value === null) continue;

    const ref = scalarText(parsed, usesEntry.value);
    if (ref === null || !isLibraryRef(ref)) continue;
    const [name, versionText] = ref.split("@");
    if (name === undefined) continue;

    const bytes = resolveBlock(name, Number(versionText));
    if (bytes === null) continue; // leave it: the engine answers block_not_found, which is the spec's answer

    writeFileSync(join(dir, ref), bytes);
    rewrites.set(step.key, ref);
  }
  return rewrites;
}

function rewrite(parsed: Parsed, rewrites: Map<string, string>): JsonValue {
  const doc = nodeToJs(parsed.root, parsed.doc);
  const steps: unknown = (doc as { steps?: unknown }).steps;
  if (steps !== null && typeof steps === "object") {
    for (const [stepId, ref] of rewrites) {
      const step: unknown = (steps as Record<string, unknown>)[stepId];
      if (step !== null && typeof step === "object") (step as Record<string, unknown>).uses = `./${ref}`;
    }
  }
  return doc;
}

function entriesOf(parsed: Parsed, node: YamlNode) {
  return mapEntries(node as YamlMap, parsed.doc);
}

function scalarText(parsed: Parsed, node: YamlNode): string | null {
  if (kindOf(node, parsed.doc) !== "string") return null;
  const value = nodeToJs(node, parsed.doc);
  return typeof value === "string" ? value : null;
}
