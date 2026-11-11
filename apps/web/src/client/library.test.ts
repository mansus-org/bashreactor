// The library a stored or snapshotted pipeline is analysed against: one read per named version, and
// the source keyed by block name for model.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { installDom, serveModules, uninstallDom } from "./client.testkit.ts";

const dom = installDom({ href: "http://x/app/runs" });
const served = serveModules(["library"]);
const { fetchLibrary } = (await import(join(served, "library.js"))) as typeof import("./library.ts");
const apiModule = (await import(join(served, "api.js"))) as typeof import("./api.ts");

const source = (name: string): string => `#!/usr/bin/env bash
# ---
# name: ${name}
# description: The ${name} block.
# inputs:
#   text:
#     type: string
#     description: The line.
# ---
echo done
`;

const reads: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  reads.push(url.pathname);
  const name = /\/([^/]+)\/\d+\/content$/.exec(url.pathname)?.[1] ?? "unknown";
  return new Response(source(name), { status: 200, headers: { "x-block-sha256": "abc" } });
}) as typeof fetch;
apiModule.signIn("http://api.test", "a_token", false);

describe("fetchLibrary", () => {
  test("reads each named version once and returns the source model.ts analyses", async () => {
    reads.length = 0;
    const library = await fetchLibrary([
      { name: "shout", version: 1 },
      { name: "shout", version: 1 },
      { name: "count-words", version: 2 },
    ]);
    expect(reads.toSorted()).toEqual(["/v1/blocks/count-words/2/content", "/v1/blocks/shout/1/content"]);
    expect(library.shout?.name).toBe("shout");
    expect(library.shout?.versions).toEqual([{ version: 1, source: source("shout") }]);
    expect(library["count-words"]?.versions[0]?.source).toContain("name: count-words");
  });

  test("keeps two versions of one block apart, in version order", async () => {
    const library = await fetchLibrary([
      { name: "shout", version: 3 },
      { name: "shout", version: 2 },
    ]);
    expect(library.shout?.versions.map((version) => version.version)).toEqual([2, 3]);
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  apiModule.signOut();
  uninstallDom(dom);
  rmSync(served, { recursive: true, force: true });
});
