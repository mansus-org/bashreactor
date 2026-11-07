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
// The consequence is worth stating out loud: what gets stored or started is the rewritten
// document, so the stored pipeline version reads `count-words@2`. What a *run* records is a staged
// path, not that: the API stages a run by copying the library's bytes beside a throwaway copy of the
// YAML and rewriting every `name@version` to `./name@version` (`apps/api/src/staging.ts`), and the
// engine snapshots that document into the run directory. So `run.json` holds
// `steps.<id>.block.uses` as `"./count-words@2"`, a path that only ever existed in the staging
// directory, and the bytes it ran are at `blocks/<sha256>.sh` — keyed by hash, by design, so the
// reference cannot rot under a later version.

import {
  BashreactorError,
  isLibraryRef,
  isPathRef,
  kindOf,
  mapEntries,
  parseBlockHeaderText,
  parseYamlDocument,
  scalarValue,
  splitBlockHeaderBytes,
  validatePipelineSource,
} from "@bashreactor/core";
import type { ValidationIssue } from "@bashreactor/core";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { ApiClient } from "./client.ts";
import { isReadableFile } from "./connection.ts";
import { CliError, EXIT_FAILURE, usage } from "./errors.ts";
import type { BlockVersion } from "./types.ts";

// `yaml` is core's dependency, not this package's, so its map node is named through the helper that
// hands it back rather than imported here.
type YamlMap = Parameters<typeof mapEntries>[0];

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

/**
 * The upload body for a block file. SPEC 2 makes the SHA-256 of the file's exact bytes its identity,
 * and a JSON string can only carry what is valid UTF-8, so the bytes go over as base64 and arrive
 * whole whatever a block's body happens to contain.
 */
export function blockUploadBody(bytes: Uint8Array): { content_b64: string } {
  return { content_b64: Buffer.from(bytes).toString("base64") };
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
 * Every `uses` in `steps` whose value is a string, found by parsing rather than by matching lines:
 * SPEC 3.1 makes a quoted scalar, and a scalar inside a flow mapping, the same value as a bare one,
 * so no regex over lines can see them all. The offsets come back so the rewrite can replace one
 * scalar and leave the rest of the file untouched.
 *
 * A file that does not parse yields nothing, which is right: the validator answers its own
 * `pipeline_yaml_invalid` for it. So does a `steps` that is not a mapping of steps, and a step with
 * no `uses` or with a `uses` that is not a string.
 */
export function findUses(source: string): UsesReference[] {
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
    if (text === null || text.type !== "string") continue;
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

/** The references that name a file beside the pipeline (SPEC 3.4). */
export function findPathReferences(source: string): UsesReference[] {
  return findUses(source).filter((reference) => isPathRef(reference.value));
}

/** The references that name the library, as `name@version`. */
export function findLibraryReferences(source: string): UsesReference[] {
  return findUses(source).filter((reference) => isLibraryRef(reference.value));
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
 *
 * This is a write: it is what `pipelines add` and `runs start` do with a file on your disk, and it is
 * why `pipelines validate` does not go through here (SPEC 3.9 — see `validateLocalPipelineFile`).
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

    const bytes = readFileSync(path);
    // SPEC 2.3: the header's name is the block's name and the filename is a convenience, so the
    // library learns it from the file and not from whatever the file happens to be called.
    const name = declaredBlockName(bytes, path);
    const created = await client.json<BlockVersion>(
      "POST",
      `/v1/blocks/${encodeURIComponent(name)}/versions`,
      { body: blockUploadBody(bytes) },
    );
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

/**
 * The name a block file declares for itself. The same core parser the API runs, so a file that will
 * not parse gets the same code and message whoever read it; only the exit code is the CLI's own, and
 * a bad file is the document's fault rather than the command line's.
 */
function declaredBlockName(bytes: Uint8Array, path: string): string {
  const split = splitBlockHeaderBytes(bytes);
  if (!split.ok) {
    throw new CliError("block_header_malformed", split.error, { path: "name", file: path, exit: EXIT_FAILURE });
  }
  try {
    return parseBlockHeaderText(split.header).name;
  } catch (error) {
    if (error instanceof BashreactorError) {
      throw new CliError(error.code, error.message, {
        path: error.path ?? "name",
        file: path,
        exit: EXIT_FAILURE,
      });
    }
    throw error;
  }
}

/**
 * SPEC 3.9: validation "runs over the pipeline and the headers of all blocks it references, and
 * creates nothing". So it happens here, over the file on your disk, with core's own validator — the
 * one the engine and the API run, so there is not a second schema — and nothing is published.
 *
 * A `uses: ./block.sh` is read from beside the file. A `name@version` is read from the library over
 * a GET, which is read scope: a read-only token is enough, and a file whose blocks are all beside it
 * needs no token at all.
 */
export async function validateLocalPipelineFile(
  file: { path: string; source: string },
  client: ApiClient,
): Promise<{ valid: boolean; issues: ValidationIssue[] }> {
  const directory = dirname(file.path);
  const library = await readLibraryBlocks(client, file.source);
  const issues = validatePipelineSource(file.source, {
    resolve(uses: string): { ok: true; source: string } | { ok: false } {
      if (isPathRef(uses)) {
        try {
          return { ok: true, source: decodeBlockBytes(readFileSync(join(directory, uses))) };
        } catch {
          return { ok: false };
        }
      }
      const source = library.get(uses);
      return source === undefined ? { ok: false } : { ok: true, source };
    },
  });
  return { valid: issues.length === 0, issues };
}

/**
 * A block file as text, for reading its header. SPEC 2.2: the header must be valid UTF-8 and the
 * rest of the file is opaque bytes, so a body that is not UTF-8 must not stop the header being read.
 */
function decodeBlockBytes(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Every `name@version` the file references, fetched read-only and held in memory for one run. */
async function readLibraryBlocks(client: ApiClient, source: string): Promise<Map<string, string>> {
  const references = new Set(findLibraryReferences(source).map((reference) => reference.value));
  const library = new Map<string, string>();
  await Promise.all(
    [...references].map(async (ref) => {
      const [name, version] = ref.split("@");
      try {
        const response = await client.bytes(
          "GET",
          `/v1/blocks/${encodeURIComponent(name!)}/${encodeURIComponent(version!)}/content`,
        );
        library.set(ref, decodeBlockBytes(new Uint8Array(await response.arrayBuffer())));
      } catch (error) {
        // A block the library does not have is the report's news, not the command's: the validator
        // answers the spec's own `block_not_found` for it. Anything else — no token, no server, a
        // block name the URL cannot carry — is the command failing, and calling that
        // `block_not_found` would be a lie about why nothing was checked.
        if (error instanceof CliError && error.code === "block_not_found") return;
        throw error;
      }
    }),
  );
  return library;
}

