// The small library a stored or snapshotted pipeline needs to be analysed: for each block version the
// document names, its bytes, keyed the way model.ts's `analyze` reads them. The screens that open a run
// or a stored pipeline use this instead of carrying their own fetch loop.

import { api } from "./api.js";
import { parseBlock } from "./model.js";
import type { Library, LibraryEntry } from "./model.js";

/**
 * Read the source of every named block version and return the library `analyze` takes. A version that
 * the library does not have throws its own ApiError, because a pipeline that names it cannot be drawn
 * honestly; repeated references are read once.
 */
export async function fetchLibrary(refs: { name: string; version: number }[]): Promise<Library> {
  const wanted = new Map<string, { name: string; version: number }>();
  for (const ref of refs) wanted.set(`${ref.name}@${ref.version}`, ref);
  const entries: Library = {};
  await Promise.all(
    [...wanted.values()].map(async (ref) => {
      const content = await api.blockContent(ref.name, ref.version);
      // Parsing here keeps the contract's own problems beside the bytes that produced them, the way
      // the editor reads a version as it fetches it. `analyze` then receives the source it expects.
      parseBlock(content.text);
      const known: LibraryEntry = entries[ref.name] ?? { name: ref.name, versions: [] };
      known.versions = [...known.versions, { version: ref.version, source: content.text }].toSorted(
        (a, b) => a.version - b.version,
      );
      entries[ref.name] = known;
    }),
  );
  return entries;
}
