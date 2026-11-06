// The browser and the server have to agree on what a valid file is. This runs the same documents
// through the browser's reader and through @bashreactor/core's parser — which is what the API
// validates with — and asserts they accept and reject the same ones and read the same values.
//
// The browser's reader comes from the text the server serves, in a directory of its own, because
// bun's module cache hands `./yaml.ts` back as the string raw.js loaded (see raw.js).

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { nodeToJs, parseBlock as coreParseBlock, parsePipeline, parseYamlDocument } from "@bashreactor/core";
import { serveModules } from "./client.testkit.ts";

const served = serveModules(["yaml", "model"]);
const { parse } = (await import(join(served, "yaml.js"))) as typeof import("./yaml.ts");
const { parseBlock } = (await import(join(served, "model.js"))) as typeof import("./model.ts");
afterAll(() => rmSync(served, { recursive: true, force: true }));

const WORKED = readFileSync(join(import.meta.dir, "../../../../docs/examples/word-report.yaml"), "utf8");

// [label, text, whether SPEC 3.1 says it is one valid document]. The last column is what keeps the two
// readers honest against each other: if both were wrong the same way, it would still fail here.
const DOCUMENTS: [string, string, boolean][] = [
  ["the worked example", WORKED, true],
  ["a step written as a flow map", "name: flow\nsteps:\n  a: { uses: failer@1 }\n", true],
  ["a retry written as a flow map", "name: r\nsteps:\n  a:\n    uses: x@1\n    retry: { max_attempts: 3, delay: 2s, backoff: 1 }\n", true],
  ["the whole document as a flow map", "{ name: f, steps: { a: { uses: 'x@1' } } }\n", true],
  ["a flow map over several lines", "name: f\nsteps:\n  a: {\n    uses: x@1,\n    needs: [b],\n  }\n  b: { uses: y@1 }\n", true],
  ["an expression quoted inside a flow map", 'name: f\nsteps:\n  a: { uses: x@1, with: { n: "${{ inputs.n }}" } }\n', true],
  ["an expression left bare inside a flow map", "name: f\nsteps:\n  a: { uses: x@1, with: { n: ${{ inputs.n }} } }\n", false],
  ["flow sequences, nested and with a trailing comma", "a: [1, [2, 3], {b: c},]\nd: []\ne: {}\n", true],
  ["a sequence of maps", "steps:\n  - uses: x@1\n    with: { a: 1 }\n  - uses: y@1\n", true],
  ["quoted keys and values", `"a b": 'it''s'\n'c': "tab\\there \\u00e9"\n"d:e": "x: y"\n`, true],
  ["plain scalars that look like something else", "a: yes\nb: no\nc: 0x1F\nd: 2026-11-06\ne: 1e3\nf: ~\ng: null\nh: .inf\ni: 012\n", true],
  ["comments everywhere", "# top\nname: c # after\n# between\nsteps: # on a key\n  a: { uses: x@1 } # after a flow map\n  # last\n", true],
  ["a # inside a value is not a comment", "a: b#c\nd: 'e #f'\n", true],
  ["block scalars, literal and folded", "a: |\n  one\n  two\n\nb: >-\n  folded\n  text\nc: |+\n  keep\n\nd: |2\n    indented\n", true],
  ["anchors and aliases", "base: &b { uses: x@1 }\nsteps:\n  a: *b\n  c: *b\n", true],
  // The parser reports no error for it, so SPEC 3.1's parser (and so the API's YAML check) lets it by;
  // the value reads as null. A gap in the server, not in the browser, and the two agree on it.
  ["an alias to an anchor that does not exist", "a: *nope\n", true],
  ["merge keys are not merged", "base: &b { uses: x@1 }\nsteps:\n  a:\n    <<: *b\n", true],
  ["a duplicate key", "name: a\nname: b\n", false],
  ["a duplicate key inside a flow map", "a: { x: 1, x: 2 }\n", false],
  ["a duplicate key in a nested block", "steps:\n  a:\n    uses: x@1\n    uses: y@1\n", false],
  ["two documents", "a: 1\n---\nb: 2\n", false],
  ["one document with a start marker", "---\na: 1\n", true],
  ["one document with an end marker", "a: 1\n...\n", true],
  ["an empty file", "", false],
  ["only comments", "# nothing here\n", false],
  ["a scalar at the top", "just text\n", true],
  ["a tab for indentation", "steps:\n\ta: 1\n", false],
  ["an unclosed flow map", "a: { b: 1\n", false],
  ["an unclosed quote", 'a: "b\n', false],
  ["bad indentation", "a:\n    b: 1\n  c: 2\n", false],
  ["a map key with no value", "a:\nb:\n  c:\n", true],
  ["a colon in a plain value", "title: a: b\n", false],
  ["non-string keys", "1: a\ntrue: b\nnull: c\n", true],
  ["an empty key", '? ""\n: x\n', true],
  ["a plain key longer than 1024 characters", `${"k".repeat(2000)}: y\n`, false],
  ["CRLF line endings", "name: c\r\nsteps:\r\n  a: { uses: x@1 }\r\n", true],
  ["a byte order mark", "\ufeffname: c\n", true],
];

function core(text: string): { ok: true; value: unknown } | { ok: false } {
  const result = parseYamlDocument(text);
  return result.ok ? { ok: true, value: nodeToJs(result.root, result.doc) } : { ok: false };
}

describe("the browser reads a file the way core's parser does", () => {
  test.each(DOCUMENTS)("%s", (_label, text, valid) => {
    const server = core(text);
    const browser = parse(text);
    expect(server.ok).toBe(valid);
    expect(browser.ok).toBe(server.ok);
    if (browser.ok && server.ok) expect(browser.value).toEqual(server.value as never);
  });

  test("a rejection names a line and says what is wrong, and calls itself invalid YAML", () => {
    const result = parse("name: a\nsteps:\n  x: 1\n  x: 2\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("pipeline_yaml_invalid");
    expect(result.error.line).toBe(4);
    expect(result.error.message).toMatch(/unique/i);
    expect(result.error.message).not.toMatch(/\n/);
  });

  test("an empty file says there is nothing in it", () => {
    const result = parse("# only a comment\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("There is no YAML document in this file.");
  });

  test("two documents point at the second one", () => {
    const result = parse("a: 1\n---\nb: 2\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.line).toBe(2);
  });

  test("every pipeline the browser rejects is one the API would answer pipeline_yaml_invalid to, and the reverse", () => {
    for (const [label, text] of DOCUMENTS) {
      const code = (() => {
        try {
          parsePipeline(text);
          return null;
        } catch (error) {
          return (error as { code?: string }).code ?? null;
        }
      })();
      expect([label, code === "pipeline_yaml_invalid"]).toEqual([label, !parse(text).ok]);
    }
  });
});

describe("the line ranges the graph clicks through", () => {
  const text = `name: x # c
description: |
  hello
  world

steps:
  a: { uses: failer@1 }
  b:
    uses: x@1
    # tail comment
    retry: { max_attempts: 3, delay: 2s }
    needs:
      - a
  c:
  d: ~
outputs:
  z: \${{ steps.a.outputs.q }}
`;

  test("a flow-style step sits on its own line, and a block step runs to its last value", () => {
    const result = parse(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.locs["steps.a"]).toEqual({ start: 7, end: 7 });
    expect(result.locs["steps.a.uses"]).toEqual({ start: 7, end: 7 });
    expect(result.locs["steps.b"]).toEqual({ start: 8, end: 13 });
    expect(result.locs["steps.b.retry.delay"]).toEqual({ start: 11, end: 11 });
    expect(result.locs["steps.b.needs"]).toEqual({ start: 12, end: 13 });
  });

  test("a trailing comment, a blank line and an empty value do not stretch a range", () => {
    const result = parse(text);
    if (!result.ok) throw new Error("did not parse");
    expect(result.locs.description).toEqual({ start: 2, end: 4 });
    expect(result.locs["steps.c"]).toEqual({ start: 14, end: 14 });
    expect(result.locs["steps.d"]).toEqual({ start: 15, end: 15 });
    expect(result.locs.steps).toEqual({ start: 6, end: 15 });
  });
});

const block = (header: string): string =>
  `#!/usr/bin/env bash\n# ---\n${header.split("\n").map((line) => (line === "" ? "#" : `# ${line}`)).join("\n")}\n# ---\necho done\n`;

describe("a block header the API stored", () => {
  const JDEF = block(`name: jdef
description: Takes a json document.
inputs:
  doc:
    type: json
    default: {"b": 2}
    description: The document.
  tags:
    type: json
    default: ["a", {"c": [1, 2]}]
  n: { type: integer, default: 3 }
outputs:
  out: { type: string }`);

  test("lists the inputs with the defaults the header declares, and the same as core reads", () => {
    const browser = parseBlock(JDEF);
    const server = coreParseBlock(JDEF);
    expect(browser.problems).toEqual([]);
    expect(browser.inputs.map((input) => input.name)).toEqual(server.inputs.map((input) => input.name));
    expect(browser.outputs.map((output) => output.name)).toEqual(server.outputs.map((output) => output.name));
    expect(browser.inputs.map((input) => input.default)).toEqual([{ b: 2 }, ["a", { c: [1, 2] }], 3]);
    expect(browser.inputs.every((input) => !input.required)).toBe(true);
  });

  test("prints a default that is a map or a list as JSON, not as [object Object]", () => {
    const browser = parseBlock(JDEF);
    expect(browser.inputs.map((input) => `${input.default}`)).toEqual(['{"b":2}', '["a",{"c":[1,2]}]', "3"]);
    expect(JSON.stringify(browser.inputs[0]!.default)).toBe('{"b":2}');
  });

  test("a header that is not a mapping is a problem of its own, never an empty contract", () => {
    const result = parseBlock(block("- a\n- b"));
    expect(result.problems.map((problem) => problem.code)).toEqual(["block_header_malformed"]);
  });
});
