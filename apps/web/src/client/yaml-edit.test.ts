// The inspector rewrites the YAML text. These try every one of those edits on steps written in flow
// style, and on the block style they already worked for, and check the answer the way the API would:
// the result is parsed by core's parser and compared with the value it should have. A document that
// no longer parses, or parses to something else, is the failure this file exists to catch.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { nodeToJs, parseYamlDocument } from "@bashreactor/core";
import { serveModules } from "./client.testkit.ts";
import type { Library } from "./model.ts";

const served = serveModules(["model", "yaml-edit"]);
const { addStep, analyze, editBlocked, editStep, pinToLibrary, removeStep } = (await import(join(served, "model.js"))) as typeof import("./model.ts");
afterAll(() => rmSync(served, { recursive: true, force: true }));

function read(text: string): unknown {
  const result = parseYamlDocument(text);
  if (!result.ok) throw new Error(`does not parse: ${result.error}\n${text}`);
  return nodeToJs(result.root, result.doc);
}

const BLOCK_SOURCE = (inputs: string, outputs: string): string =>
  `#!/usr/bin/env bash\n# ---\n# name: failer\n# description: Fails.\n${inputs}${outputs}# ---\nexit 1\n`;
const library: Library = {
  failer: { name: "failer", versions: [{ version: 1, source: BLOCK_SOURCE("# inputs:\n#   n:\n#     type: integer\n#     default: 1\n", "# outputs:\n#   out:\n#     type: string\n") }] },
};

function analysed(text: string) {
  const result = analyze(text, library);
  if (!result.ok) throw new Error(`did not analyse: ${result.error.message}`);
  return result;
}

function edit(text: string, id: string, key: string, value: Parameters<typeof editStep>[3]): string {
  return editStep(text, id, key, value);
}

describe("editStep on a step written in flow style", () => {
  const ONE = "name: flow\nsteps:\n  a: { uses: failer@1 }\n";

  test("changes a value in place and touches nothing else", () => {
    expect(edit(ONE, "a", "uses", "failer@2")).toBe("name: flow\nsteps:\n  a: { uses: failer@2 }\n");
  });

  test("adds a key inside the braces", () => {
    const out = edit(ONE, "a", "timeout", "90s");
    expect(out).toBe("name: flow\nsteps:\n  a: { uses: failer@1, timeout: 90s }\n");
    expect(read(out)).toEqual({ name: "flow", steps: { a: { uses: "failer@1", timeout: "90s" } } });
  });

  test("creates the nested keys it needs, in flow style too", () => {
    const out = edit(ONE, "a", "retry.max_attempts", 3);
    expect(read(out)).toEqual({ name: "flow", steps: { a: { uses: "failer@1", retry: { max_attempts: 3 } } } });
    const more = edit(edit(out, "a", "retry.delay", "2s"), "a", "with.n", "${{ inputs.n }}");
    expect(read(more)).toEqual({
      name: "flow",
      steps: { a: { uses: "failer@1", retry: { max_attempts: 3, delay: "2s" }, with: { n: "${{ inputs.n }}" } } },
    });
  });

  test("quotes an expression that would end a plain scalar inside braces", () => {
    const out = edit("name: f\nsteps:\n  a: { uses: failer@1, with: { x: 1 } }\n", "a", "with.y", "${{ steps.b.outputs.q }}");
    expect(read(out)).toEqual({ name: "f", steps: { a: { uses: "failer@1", with: { x: 1, y: "${{ steps.b.outputs.q }}" } } } });
  });

  test("writes a list as a flow list, and a number as a number", () => {
    const out = edit(edit(ONE, "a", "needs", ["b", "c"]), "a", "retry.max_attempts", 2);
    expect(read(out)).toEqual({ name: "flow", steps: { a: { uses: "failer@1", needs: ["b", "c"], retry: { max_attempts: 2 } } } });
  });

  test("replaces a list that is already there", () => {
    const out = edit("name: f\nsteps:\n  a: { uses: failer@1, needs: [b, c] }\n  b: { uses: failer@1 }\n  c: { uses: failer@1 }\n", "a", "needs", ["c"]);
    expect(read(out)).toMatchObject({ steps: { a: { needs: ["c"] } } });
  });

  test("removes a key from the middle, the end and the front without leaving a stray comma", () => {
    const text = "steps:\n  a: { uses: failer@1, timeout: 9s, name: A }\n";
    expect(read(edit(text, "a", "timeout", undefined))).toEqual({ steps: { a: { uses: "failer@1", name: "A" } } });
    expect(read(edit(text, "a", "name", undefined))).toEqual({ steps: { a: { uses: "failer@1", timeout: "9s" } } });
    expect(read(edit(text, "a", "uses", undefined))).toEqual({ steps: { a: { timeout: "9s", name: "A" } } });
  });

  test("removing the last key of a nested flow map removes the map, which would otherwise read as empty", () => {
    const out = edit("name: f\nsteps:\n  a: { uses: failer@1, retry: { delay: 2s } }\n", "a", "retry.delay", undefined);
    expect(read(out)).toEqual({ name: "f", steps: { a: { uses: "failer@1" } } });
  });

  test("works across lines, and keeps a comment", () => {
    const text = "steps:\n  a: {\n    uses: failer@1, # the block\n    retry: { max_attempts: 3, delay: 2s, backoff: 1 },\n  }\n";
    const out = edit(edit(text, "a", "retry.delay", "5s"), "a", "name", "Fail");
    expect(out).toContain("# the block");
    expect(read(out)).toEqual({ steps: { a: { uses: "failer@1", retry: { max_attempts: 3, delay: "5s", backoff: 1 }, name: "Fail" } } });
  });

  test("fills a key that was written with no value", () => {
    expect(read(edit("steps:\n  a: { uses: failer@1, with }\n", "a", "with.n", 4))).toEqual({ steps: { a: { uses: "failer@1", with: { n: 4 } } } });
    expect(read(edit("steps:\n  a: { uses: failer@1, with: }\n", "a", "with.n", 4))).toEqual({ steps: { a: { uses: "failer@1", with: { n: 4 } } } });
  });

  test("a step inside a `steps` that is itself a flow map", () => {
    const text = "name: f\nsteps: { a: { uses: failer@1 }, b: { uses: failer@1 } }\n";
    expect(read(edit(text, "b", "timeout", "1m"))).toEqual({ name: "f", steps: { a: { uses: "failer@1" }, b: { uses: "failer@1", timeout: "1m" } } });
  });

  test("and the same edits on block style keep working", () => {
    const text = "name: b\nsteps:\n  a:\n    uses: failer@1\n    # keep me\n    timeout: 9s\n";
    const out = edit(edit(edit(text, "a", "timeout", "1m"), "a", "retry.max_attempts", 3), "a", "name", undefined);
    expect(out).toContain("# keep me");
    expect(read(out)).toEqual({ name: "b", steps: { a: { uses: "failer@1", timeout: "1m", retry: { max_attempts: 3 } } } });
  });

  test("a block step whose `with:` is empty gets its key under it", () => {
    const out = edit("steps:\n  a:\n    uses: failer@1\n    with:\n", "a", "with.n", 2);
    expect(read(out)).toEqual({ steps: { a: { uses: "failer@1", with: { n: 2 } } } });
    expect(read(edit("steps:\n  a:\n    uses: failer@1\n    with: ~\n", "a", "with.n", 2))).toEqual({ steps: { a: { uses: "failer@1", with: { n: 2 } } } });
  });
});

describe("what an edit will not do", () => {
  const ALIASED = "base: &b { uses: failer@1 }\nsteps:\n  a: *b\n  c: { uses: failer@1 }\n";

  test("leaves a step that is an alias alone, and says why", () => {
    expect(edit(ALIASED, "a", "timeout", "9s")).toBe(ALIASED);
    expect(editBlocked(ALIASED, ["steps", "a", "timeout"])).toMatch(/alias/);
  });

  test("leaves a node that carries an anchor alone, because an alias may point at it", () => {
    const text = "steps:\n  a: &s { uses: failer@1 }\n  b: *s\n";
    expect(edit(text, "a", "timeout", "9s")).toBe(text);
    expect(edit(text, "a", "uses", undefined)).toBe(text);
    expect(editBlocked(text, ["steps", "a", "uses"])).toMatch(/anchor/);
  });

  test("leaves a value that is not a mapping alone", () => {
    const text = "steps:\n  a: 7\n";
    expect(edit(text, "a", "timeout", "9s")).toBe(text);
    expect(editBlocked(text, ["steps", "a", "timeout"])).toMatch(/not a mapping/);
  });

  test("does nothing to text that does not parse", () => {
    expect(edit("steps: { a: ", "a", "uses", "x@1")).toBe("steps: { a: ");
  });

  test("answers null when an edit is fine", () => {
    expect(editBlocked(ALIASED, ["steps", "c", "timeout"])).toBeNull();
  });
});

describe("addStep, removeStep and pinToLibrary on flow style", () => {
  const FLOW = "name: flow\nsteps:\n  a: { uses: ./failer.sh }\n  b: { uses: ./failer.sh, needs: [a], with: { n: \"${{ steps.a.outputs.out }}\" } }\n";

  test("a flow document opens: it parses, draws both steps and the wire between them", () => {
    const result = analysed(FLOW);
    expect(result.steps.map((step) => step.id)).toEqual(["a", "b"]);
    expect(result.edges).toEqual([{ from: "a", out: "out", to: "b", in: "n", kind: "data" }]);
    expect(result.steps[0]!.range).toEqual({ start: 3, end: 3 });
  });

  test("addStep after block-style steps adds a block entry", () => {
    const text = "name: f\nsteps:\n  a: { uses: failer@1 }\n";
    const out = addStep(text, analysed(text), "b", { uses: "failer@1", title: "Second" });
    expect(read(out)).toEqual({ name: "f", steps: { a: { uses: "failer@1" }, b: { name: "Second", uses: "failer@1" } } });
  });

  test("addStep into a steps map written in braces adds inside them", () => {
    const text = "name: f\nsteps: { a: { uses: failer@1 } }\noutputs: {}\n";
    const out = addStep(text, analysed(text), "b", { uses: "failer@1" });
    expect(read(out)).toEqual({ name: "f", steps: { a: { uses: "failer@1" }, b: { uses: "failer@1" } }, outputs: {} });
  });

  test("addStep into an empty steps map", () => {
    for (const empty of ["steps: {}", "steps:"]) {
      const text = `name: f\n${empty}\n`;
      const out = addStep(text, analysed(text), "a", { uses: "failer@1" });
      expect(read(out)).toEqual({ name: "f", steps: { a: { uses: "failer@1" } } });
    }
  });

  test("removeStep takes a flow step out of block steps, and the references to it", () => {
    const out = removeStep(FLOW, analysed(FLOW), "a");
    expect(read(out)).toEqual({ name: "flow", steps: { b: { uses: "./failer.sh" } } });
  });

  test("removeStep takes one step out of a steps map written in braces and leaves the other", () => {
    const text = "name: f\nsteps: { a: { uses: failer@1 }, b: { uses: failer@1, needs: [a] } }\n";
    const out = removeStep(text, analysed(text), "b");
    expect(read(out)).toEqual({ name: "f", steps: { a: { uses: "failer@1" } } });
    const other = removeStep(text, analysed(text), "a");
    expect(read(other)).toEqual({ name: "f", steps: { b: { uses: "failer@1" } } });
  });

  test("removeStep takes the blank line above a block step with it, and keeps the comments of the rest", () => {
    const text = "name: f\nsteps:\n  # first\n  a:\n    uses: failer@1\n\n  b:\n    uses: failer@1\n";
    expect(removeStep(text, analysed(text), "b")).toBe("name: f\nsteps:\n  # first\n  a:\n    uses: failer@1\n");
  });

  test("pinToLibrary rewrites a path reference written inside braces", () => {
    const out = pinToLibrary(FLOW, analysed(FLOW), library);
    expect(read(out)).toEqual({
      name: "flow",
      steps: {
        a: { uses: "failer@1" },
        b: { uses: "failer@1", needs: ["a"], with: { n: "${{ steps.a.outputs.out }}" } },
      },
    });
  });
});
