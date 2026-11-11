// The asset table is the whole of the browser's filesystem: there is no bundler and no static
// directory, so a module the table does not know about is a 404 and the ES module graph never
// resolves. The screen sits on "Loading." forever, and nothing in a typecheck can see it, because
// TypeScript is happy with `./yaml.ts` and the browser is served `assets/yaml.js`.
//
// So the test is the file listing and the import graph. The import graph is read off the bytes the
// server actually serves, with Bun's own import scanner, and each specifier is resolved the way the
// browser would resolve it — against the module's own URL under `/app/assets/`. The one thing that
// cannot be read off the served bytes is `import type`, which is erased before serving, so the `.js`
// convention is checked on the source for those lines alone.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildAssets, STYLE_FILES } from "./assets.ts";

const CLIENT = join(import.meta.dir, "client");
const STYLES = join(CLIENT, "styles");
const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Test files are Bun's, not the browser's: they import `.ts` directly and are never shipped. */
const isShipped = (name: string): boolean =>
  name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".testkit.ts") && !name.endsWith(".d.ts");

/** Every TypeScript file under `client/`, however it is arranged: the table is flat, so a subdirectory is a bug. */
function clientModules(dir: string = CLIENT, prefix = ""): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const child = join(dir, name);
      if (statSync(child).isDirectory()) return clientModules(child, `${prefix}${name}/`);
      return isShipped(name) ? [`${prefix}${name}`] : [];
    })
    .toSorted();
}

const files = buildAssets().files;

/** Every specifier the browser would go and ask for, from the scanner rather than a regex of my own. */
function specifiers(source: string): string[] {
  return transpiler.scanImports(source).map((entry) => entry.path);
}

/**
 * What the browser would end up asking for, as a key of the table — or the reason it cannot get it.
 * A client module is served at `http://x/app/assets/<name>.js`, so that is what it resolves against.
 */
function unresolved(name: string, source: string): string[] {
  const problems: string[] = [];
  for (const specifier of specifiers(source)) {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      problems.push(`${name}: "${specifier}" is not a relative specifier`);
      continue;
    }
    const at = new URL(specifier, `http://x/app/assets/${name}`);
    const key = at.pathname.slice("/app/".length);
    if (!at.pathname.startsWith("/app/assets/")) problems.push(`${name}: "${specifier}" resolves to ${at.pathname}, outside the assets directory`);
    else if (!files.has(key)) problems.push(`${name}: "${specifier}" resolves to ${key}, which the table does not have`);
  }
  return problems;
}

test("every client module on disk is served as an asset", () => {
  const missing = clientModules().filter((name) => !files.has(`assets/${name.replace(/\.ts$/, ".js")}`));
  expect(missing).toEqual([]);
});

test("the design system and the screens' new modules are registered", () => {
  for (const name of ["ui", "library", "dashboard", "pipelines", "pipeline-page", "settings", "timeline"]) {
    expect(files.has(`assets/${name}.js`)).toBe(true);
  }
});

test("every stylesheet file on disk is in the served order", () => {
  // The folder is the source of truth: a file the order list forgets is a rule the browser never sees.
  const onDisk = readdirSync(STYLES).filter((name) => name.endsWith(".css"));
  const listed: readonly string[] = STYLE_FILES;
  expect(onDisk.filter((name) => !listed.includes(name))).toEqual([]);
  expect(listed.filter((name) => !onDisk.includes(name))).toEqual([]);
});

test("the served stylesheet is the stylesheet files joined in order", () => {
  const expected = STYLE_FILES.map((name) => readFileSync(join(STYLES, name), "utf8")).join("\n");
  const served = new TextDecoder().decode(files.get("assets/style.css")!.data);
  expect(served).toBe(expected);
});

test("every import in a served module resolves to a served asset", () => {
  const problems: string[] = [];
  for (const [key, asset] of files) {
    if (!key.startsWith("assets/") || !key.endsWith(".js")) continue;
    problems.push(...unresolved(key.slice("assets/".length), new TextDecoder().decode(asset.data)));
  }
  expect(problems).toEqual([]);
});

test("a shipped module never names a .ts specifier, not even on an import type", () => {
  // The scanner cannot see this case: `import type` is gone by the time the bytes are served.
  const TYPE_IMPORT = /^\s*import\s+type\b[^;]*?from\s*["'](\.[^"']+\.ts)["']/gm;
  const typed: string[] = [];
  for (const name of clientModules()) {
    const source = readFileSync(join(CLIENT, name), "utf8");
    for (const match of source.matchAll(TYPE_IMPORT)) typed.push(`${name}: ${match[1]}`);
  }
  expect(typed).toEqual([]);
});

// The holes this test had when it was a regex over source. Each of these is a module the browser would
// fail to load, and each has to be caught; the last two are things the browser loads fine, which the
// test must leave alone.

const BROKEN: [string, string][] = [
  ["a side-effect import", `import "./nope.js";\n`],
  ["a .ts side-effect import", `import "./yaml.ts";\n`],
  ["a .ts specifier", `import { parse } from "./yaml.ts";\n`],
  ["a template dynamic import", "const m = await import(`./yaml.ts`);\n"],
  ["a bare dynamic import", `const m = await import("./gone.js");\n`],
  ["a re-export", `export*from"./yaml.ts";\n`],
  ["a subdirectory", `import { parse } from "./sub/yaml.js";\n`],
  ["a parent directory", `import { parse } from "../yaml.js";\n`],
  ["an absolute path", `import { parse } from "/assets/yaml.js";\n`],
  ["a bare specifier", `import { parse } from "yaml";\n`],
];

const FINE: [string, string][] = [
  ["a served sibling", `import { el } from "./dom.js";\nexport { el };\n`],
  ["a comment that mentions a path", `// moved from "./gone.js"\nimport { el } from "./dom.js";\n`],
];

test.each(BROKEN)("the specifier check catches %s", (_label, source) => {
  expect(unresolved("model.js", source).length).toBeGreaterThan(0);
});

test.each(FINE)("the specifier check leaves alone %s", (_label, source) => {
  expect(unresolved("model.js", source)).toEqual([]);
});
