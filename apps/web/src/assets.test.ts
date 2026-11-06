// The asset table is the whole of the browser's filesystem: there is no bundler and no static
// directory, so a module the table does not know about is a 404 and the ES module graph never
// resolves. The screen sits on "Loading." forever, and nothing in a typecheck can see it, because
// TypeScript is happy with `./yaml.ts` and the browser is served `assets/yaml.js`.
//
// So the test is the file listing and the import graph: every client module on disk has to be in the
// table, and every relative specifier in a shipped module has to name a key the table answers with.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { buildAssets } from "./assets.ts";

const CLIENT = join(import.meta.dir, "client");

/** Test files are Bun's, not the browser's: they import `.ts` directly and are never shipped. */
const clientModules = (): string[] =>
  readdirSync(CLIENT)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .toSorted();

/** Every relative specifier: static `import`/`export ... from`, and `import("./x.js")`. */
function specifiers(source: string): string[] {
  const found = [
    ...[...source.matchAll(/(?:^|[\s;})])from\s*["'](\.[^"']+)["']/g)].map((match) => match[1]!),
    ...[...source.matchAll(/\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g)].map((match) => match[1]!),
  ];
  return [...new Set(found)].toSorted();
}

const files = buildAssets().files;

test("every client module on disk is served as an asset", () => {
  const missing = clientModules().filter((name) => !files.has(`assets/${name.replace(/\.ts$/, ".js")}`));
  expect(missing).toEqual([]);
});

test("every relative import in a shipped module names a served asset", () => {
  const broken: string[] = [];
  for (const name of clientModules()) {
    const source = readFileSync(join(CLIENT, name), "utf8");
    for (const specifier of specifiers(source)) {
      // The table is flat: each client module is one `assets/<name>.js`, whatever the specifier says.
      const key = `assets/${posix.basename(specifier)}`;
      if (!files.has(key)) broken.push(`${name}: ${specifier} -> ${key}`);
    }
  }
  expect(broken).toEqual([]);
});
