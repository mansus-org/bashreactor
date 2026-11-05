// A pipeline file on your disk and a pipeline the API can run are not the same document.
//
// SPEC 3.4 resolves `uses: ./count-words.sh` against the directory holding the pipeline file, and
// the API stages the YAML it is given into its own directory (apps/api/README.md, "Staging"), so a
// relative reference from your laptop points at nothing there. The API has no route that takes a
// directory, and this task may not add one, so the CLI closes the gap with the two routes that do
// exist: it publishes each block beside the file into the library and rewrites the reference to the
// `name@version` the library answers with. Everything else in the file keeps its bytes, comments
// included, because only the `uses:` line is touched.
//
// The consequence is worth stating out loud: what gets stored or started is the rewritten document,
// so a run records `count-words@2` rather than `./count-words.sh`.

import { BLOCK_NAME_RE } from "@bashreactor/core";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { ApiClient } from "./client.ts";
import { isReadableFile } from "./connection.ts";
import { usage } from "./errors.ts";
import type { BlockVersion } from "./types.ts";

/** `uses: ./x.sh`, with whatever indentation and trailing comment the file has around it. */
const USES_PATH_RE = /^([ \t]*uses:[ \t]*)((?:\.\.?\/)[^\s#]+)([ \t]*(?:#.*)?)[ \t]*$/;

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

export function readPipelineFile(path: string): { path: string; source: string } {
  const file = isAbsolute(path) ? path : resolve(path);
  if (!isReadableFile(file)) {
    throw usage(`"${path}" is not a file`, { code: "file_input_not_found", file: path });
  }
  return { path: file, source: readFileSync(file, "utf8") };
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
  const versions = new Map<string, string>();
  const published: PreparedFile["published"] = [];

  const lines = file.source.split("\n");
  const refs = new Set<string>();
  for (const line of lines) {
    const match = USES_PATH_RE.exec(line);
    if (match !== null) refs.add(match[2]!);
  }
  for (const ref of new Set(refs)) {
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

  const yaml =
    versions.size === 0
      ? file.source
      : lines
          .map((line) => {
            const match = USES_PATH_RE.exec(line);
            if (match === null) return line;
            const replacement = versions.get(match[2]!);
            if (replacement === undefined) return line;
            return `${match[1]!}${replacement}${match[3]!}`;
          })
          .join("\n");

  return { path: file.path, source: file.source, yaml, published };
}
