import { describe, expect, test } from "bun:test";
import { findPathReferences, rewriteReferences } from "../src/local.ts";

/** The references a file holds, as `value -> replacement` pairs, so a test says the form only. */
function values(source: string): string[] {
  return findPathReferences(source).map((reference) => reference.value);
}

/** What the file looks like once `./hello.sh` is `hello@2`, with nothing else touched. */
function rewritten(source: string): string {
  return rewriteReferences(source, findPathReferences(source), new Map([["./hello.sh", "hello@2"]]));
}

/** Everything that is not a `uses:` line, so a test can name what must not move. */
function rest(text: string): string[] {
  return text.split("\n").filter((line) => !line.includes("uses:"));
}

const step = (uses: string): string => `name: p\nsteps:\n  greet:\n    uses: ${uses}\n`;

describe("findPathReferences", () => {
  test("finds a block-style reference, quoted or not", () => {
    expect(values(step("./hello.sh"))).toEqual(["./hello.sh"]);
    expect(values(step("'./hello.sh'"))).toEqual(["./hello.sh"]);
    expect(values(step('"./hello.sh"'))).toEqual(["./hello.sh"]);
  });

  test("finds a reference inside a flow mapping, quoted or not", () => {
    expect(values("name: p\nsteps:\n  a: { uses: ./hello.sh }\n")).toEqual(["./hello.sh"]);
    expect(values("name: p\nsteps:\n  a: { uses: \"./hello.sh\" }\n")).toEqual(["./hello.sh"]);
  });

  test("finds a reference above the pipeline's own directory", () => {
    expect(values(step("../blocks/hello.sh"))).toEqual(["../blocks/hello.sh"]);
  });

  test("leaves a library reference alone, whatever its style", () => {
    expect(values(step("hello@1"))).toEqual([]);
    expect(values(step('"hello@1"'))).toEqual([]);
    expect(values("name: p\nsteps:\n  a: { uses: hello@1 }\n")).toEqual([]);
  });

  test("finds every step", () => {
    const source = `name: p
steps:
  a:
    uses: ./hello.sh
  b: { uses: './other.sh' }
`;
    expect(values(source)).toEqual(["./hello.sh", "./other.sh"]);
  });

  test("counts one anchored scalar once, wherever it is aliased", () => {
    const source = `name: p
steps:
  a:
    uses: &u ./hello.sh
  b:
    uses: *u
`;
    expect(values(source)).toEqual(["./hello.sh"]);
    expect(rewritten(source)).toBe(
      `name: p
steps:
  a:
    uses: &u hello@2
  b:
    uses: *u
`,
    );
  });

  test("ignores a `uses` that is not a step, and a file that is not a pipeline", () => {
    // `with:` takes the block's inputs, so a key called `uses` there is an input, not a reference.
    expect(values("name: p\nsteps:\n  a:\n    with:\n      uses: ./hello.sh\n")).toEqual([]);
    expect(values("- uses: ./hello.sh\n")).toEqual([]);
    expect(values("name: p\nsteps:\n")).toEqual([]);
    // Not our business: the API answers pipeline_yaml_invalid for it.
    expect(values("name: p\nsteps: [ { a:\n")).toEqual([]);
  });
});

describe("rewriteReferences", () => {
  test("replaces the scalar in every style the spec allows", () => {
    expect(rewritten(step("./hello.sh"))).toBe(step("hello@2"));
    expect(rewritten(step("'./hello.sh'"))).toBe(step("hello@2"));
    expect(rewritten(step('"./hello.sh"'))).toBe(step("hello@2"));
    expect(rewritten("name: p\nsteps:\n  a: { uses: './hello.sh' }\n")).toBe(
      "name: p\nsteps:\n  a: { uses: hello@2 }\n",
    );
  });

  test("keeps the line after a folded scalar on its own line", () => {
    const source = "name: p\nsteps:\n  greet:\n    uses: >-\n      ./hello.sh\n    needs: []\n";
    expect(rewritten(source)).toBe("name: p\nsteps:\n  greet:\n    uses: hello@2\n    needs: []\n");
  });

  test("keeps every other byte: comments, blank lines, the quoting of other values", () => {
    const source = `# the nightly report
name: "nightly"   # quoted on purpose

steps:
  # a comment above the step
  greet:
    uses: './hello.sh'  # beside this file
    with:
      name: "world"
  second:
    uses: ./hello.sh
    needs: [greet]
`;
    expect(rewritten(source)).toBe(`# the nightly report
name: "nightly"   # quoted on purpose

steps:
  # a comment above the step
  greet:
    uses: hello@2  # beside this file
    with:
      name: "world"
  second:
    uses: hello@2
    needs: [greet]
`);
    // The same check, stated as the rule rather than as one expected file.
    expect(rest(rewritten(source))).toEqual(rest(source));
  });

  test("leaves a reference the library has no answer for exactly as it was", () => {
    const source = step("./hello.sh");
    expect(rewriteReferences(source, findPathReferences(source), new Map())).toBe(source);
  });
});
