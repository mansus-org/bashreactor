// A pipeline file on your disk and a pipeline the API can run are not the same document.
//
// SPEC 3.4 resolves `uses: ./count-words.sh` against the directory holding the pipeline file, and
// the API stages the YAML it is given into its own directory (apps/api/README.md, "Staging"), so a
// relative reference from your laptop points at nothing there. The API has no route that takes a
// directory, and this task may not add one, so the CLI closes the gap with the two routes that do
// exist: it publishes each block beside the file into the library and rewrites the reference to the
// `name@version` the library answers with. Everything else in the file keeps its bytes, comments
// included, because only the scalar after `uses:` is replaced.
//
// The consequence is worth stating out loud: what gets stored or started is the rewritten document,
// so a run records `count-words@2` rather than `./count-words.sh`.

import {
  BLOCK_NAME_RE,
  kindOf,
  mapEntries,
  parseYamlDocument,
  scalarValue,
} from "@bashreactor/core";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { ApiClient } from "./client.ts";
import { isReadableFile } from "./connection.ts";
import { usage } from "./errors.ts";
import type { BlockVersion } from "./types.ts";

// `yaml` is core's dependency, not this package's, so its map node is named through the helper that
// hands it back rather than imported here.
type YamlMap = Parameters<typeof mapEntries>[0];

/** SPEC 3.4: a `uses` value that starts like this is a path, not a library reference. */
const PATH_REFERENCE = /^\.\.?\//;

// A folded or literal scalar's range swallows the line break that ends it, and putting that break
// back is what keeps the lines after `uses:` on their own lines.
const TRAILING_BREAK = /(\r?\n)+$/;

export interface PreparedFile {
  /** The path the user gave, kept for error messages. */
  path: string;
  /** The file's own text, before any rewrite. */
  source: string;
  /** What to send to the API. */
  yaml: string;
  /** The blocks this put into the library, so the command can say what it did. */
  published: { name: string; version: number; path: string }[];
}

/** One `steps.<id>.uses` that names a file, and where its scalar sits in the source text. */
export interface UsesReference {
  /** The YAML value, so `"./x.sh"` and `./x.sh` are one reference. */
  value: string;
  /** Half-open offsets of the scalar, quotes and block-scalar header included. */
  start: number;
  end: number;
}

export function readPipelineFile(path: string): { path: string; source: string } {
  const file = isAbsolute(path) ? path : resolve(path);
  if (!isReadableFile(file)) {
    throw usage(`"${path}" is not a file`, { code: "file_input_not_found", file: path });
  }
  return { path: file, source: readFileSync(file, "utf8") };
}

/**
 * Every path reference in `steps`, found by parsing rather than by matching lines: SPEC 3.1 makes a
 * quoted scalar, and a scalar inside a flow mapping, the same value as a bare one, so no regex over
 * lines can see them all. The offsets come back so the rewrite can replace one scalar and leave the
 * rest of the file untouched.
 *
 * A file that does not parse yields nothing, which is right: the API answers its own
 * `pipeline_yaml_invalid` for it. So does a `steps` that is not a mapping of steps, and a step with
 * no `uses` or with a `uses` that is not a string.
 */
export function findPathReferences(source: string): UsesReference[] {
  const parsed = parseYamlDocument(source);
  if (!parsed.ok || parsed.root === null) return [];
  const { doc, root } = parsed;
  if (kindOf(root, doc) !== "map") return [];

  const steps = mapEntries(root as YamlMap, doc).find((entry) => entry.key === "steps")?.value;
  if (!steps || kindOf(steps, doc) !== "map") return [];

  const found: UsesReference[] = [];
  const seen = new Set<string>();
  for (const step of mapEntries(steps as YamlMap, doc)) {
    if (!step.value || kindOf(step.value, doc) !== "map") continue;
    const uses = mapEntries(step.value as YamlMap, doc).find((entry) => entry.key === "uses")?.value;
    if (!uses || kindOf(uses, doc) !== "string") continue;

    const text = scalarValue(uses, doc);
    if (text === null || text.type !== "string" || !PATH_REFERENCE.test(text.value)) continue;
    const range = uses.range;
    if (!range) continue;

    // Two steps can share one anchored scalar, and one replacement covers both.
    const key = `${range[0]}:${range[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ value: text.value, start: range[0], end: range[1] });
  }
  return found;
}

/**
 * The same text with each reference replaced by what the library answered. References with no answer
 * are left as they are, and only the scalar is rewritten: the indentation, quoting of every other
 * value, comments and blank lines are the file's own bytes, copied through.
 */
export function rewriteReferences(
  source: string,
  references: readonly UsesReference[],
  library: ReadonlyMap<string, string>,
): string {
  let text = source;
  // Back to front, so a replacement never moves an offset that is still to come.
  for (const ref of references.toSorted((a, b) => b.start - a.start)) {
    const replacement = library.get(ref.value);
    if (replacement === undefined) continue;
    const original = text.slice(ref.start, ref.end);
    const trailingBreak = TRAILING_BREAK.exec(original)?.[0] ?? "";
    text = `${text.slice(0, ref.start)}${replacement}${trailingBreak}${text.slice(ref.end)}`;
  }
  return text;
}

/**
 * Publish every `uses: ./block.sh` and hand back the same document with those references pointed at
 * the library. A reference whose file is not there is left alone, so the API answers the spec's own
 * `block_not_found` for it rather than a message invented here.
 */
export async function publishRelativeBlocks(
  client: ApiClient,
  file: { path: string; source: string },
  note: (line: string) => void,
): Promise<PreparedFile> {
  const directory = dirname(file.path);
  const references = findPathReferences(file.source);
  const versions = new Map<string, string>();
  const published: PreparedFile["published"] = [];

  for (const ref of new Set(references.map((reference) => reference.value))) {
    const path = join(directory, ref);
    if (!isReadableFile(path)) continue;

    const name = basename(path, extname(path));
    if (!BLOCK_NAME_RE.test(name)) {
      throw usage(`"${path}" cannot become a library block: "${name}" is not a block name`, {
        code: "block_schema_invalid",
        path: "name",
        file: path,
      });
    }
    const content = readFileSync(path, "utf8");
    const created = await client.json<BlockVersion>("POST", `/v1/blocks/${name}/versions`, {
      body: { content },
    });
    versions.set(ref, `${created.name}@${created.version}`);
    published.push({ name: created.name, version: created.version, path });
    note(`published ${path} as ${created.name}@${created.version}`);
  }

  return {
    path: file.path,
    source: file.source,
    yaml: rewriteReferences(file.source, references, versions),
    published,
  };
}
