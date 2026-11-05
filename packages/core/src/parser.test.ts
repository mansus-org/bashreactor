import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseBlock, parsePipeline } from "./parser.ts";
import type { Pipeline } from "./types.ts";

const examples = new URL("../../../docs/examples/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, examples), "utf8");

const validBlock = `#!/usr/bin/env bash
# ---
# name: fetch-dataset
# description: Download a dataset and report its size.
# inputs:
#   url:
#     type: string
#     description: Where to download from.
#   attempts:
#     type: integer
#     default: 3
# outputs:
#   dataset:
#     type: file
#   bytes:
#     type: integer
# ---

curl --fail "$INPUT_URL"
`;

describe("parseBlock", () => {
  test("parses a valid header with defaults", () => {
    const block = parseBlock(validBlock);
    expect(block.name).toBe("fetch-dataset");
    expect(block.description).toBe("Download a dataset and report its size.");
    expect(block.inputs).toEqual([
      { name: "url", type: "string", description: "Where to download from." },
      { name: "attempts", type: "integer", description: "", default: 3 },
    ]);
    expect(block.outputs).toEqual([
      { name: "dataset", type: "file", description: "" },
      { name: "bytes", type: "integer", description: "" },
    ]);
  });

  test("parses the worked example's generate-corpus block", () => {
    const block = parseBlock(read("generate-corpus.sh"));
    expect(block.name).toBe("generate-corpus");
    expect(block.inputs.map((input) => input.name)).toEqual(["lines", "seed", "interrupt_at"]);
    expect(block.inputs.every((input) => input.type === "integer")).toBe(true);
    expect(block.outputs.map((output) => [output.name, output.type])).toEqual([
      ["corpus", "file"],
      ["line_count", "integer"],
    ]);
  });

  test("rejects a missing closing marker", () => {
    expect(() => parseBlock("#!/usr/bin/env bash\n# ---\n# name: x\n")).toThrow(
      expect.objectContaining({ code: "block_header_malformed" }),
    );
  });

  test("rejects CRLF line endings at step 1", () => {
    expect(() => parseBlock("#!/usr/bin/env bash\r\n# ---\r\n# name: x\r\n# ---\r\n")).toThrow(
      expect.objectContaining({ code: "block_header_malformed" }),
    );
  });

  test("rejects a schema violation with the key's path", () => {
    const bad = `#!/usr/bin/env bash
# ---
# name: x
# inputs:
#   url:
#     type: string
#     default: 5
# ---
`;
    expect(() => parseBlock(bad)).toThrow(expect.objectContaining({ code: "block_schema_invalid", path: "inputs.url.default" }));
  });

  test("rejects a file input with a default", () => {
    const bad = `#!/usr/bin/env bash
# ---
# name: x
# inputs:
#   data:
#     type: file
#     default: /tmp/x
# ---
`;
    expect(() => parseBlock(bad)).toThrow(expect.objectContaining({ code: "block_schema_invalid", path: "inputs.data.default" }));
  });
});

describe("parsePipeline", () => {
  test("parses the worked example and matches the README's values", () => {
    const pipeline = parsePipeline(read("word-report.yaml"));
    expect(pipeline.name).toBe("word-report");
    expect(pipeline.max_parallel).toBe(2);
    expect(pipeline.inputs.map((input) => [input.name, input.type, input.default])).toEqual([
      ["lines", "integer", 200],
      ["seed", "integer", 7],
      ["title", "string", "Word report"],
    ]);
    expect(pipeline.steps.map((step) => step.id)).toEqual(["generate", "check", "count", "report"]);

    const generate = pipeline.steps[0]!;
    expect(generate.name).toBe("Generate the corpus");
    expect(generate.uses).toBe("./generate-corpus.sh");
    expect(generate.timeout).toBe(300);
    expect(generate.retry).toEqual({ max_attempts: 3, delay: 1, backoff: 2, max_delay: 3600 });
    expect(generate.with).toEqual([
      { name: "lines", value: { kind: "whole", ref: { kind: "inputs", name: "lines" } } },
      { name: "seed", value: { kind: "whole", ref: { kind: "inputs", name: "seed" } } },
      { name: "interrupt_at", value: { kind: "literal", value: 120 } },
    ]);

    const check = pipeline.steps[1]!;
    expect(check.retry.max_attempts).toBe(2);

    const count = pipeline.steps[2]!;
    expect(count.timeout).toBe(600);
    expect(count.retry).toEqual({ max_attempts: 1, delay: 30, backoff: 2, max_delay: 3600 });

    const report = pipeline.steps[3]!;
    expect(report.needs).toEqual(["check"]);
    const title = report.with.find((entry) => entry.name === "title")!;
    expect(title.value.kind).toBe("template");

    expect(pipeline.outputs.map((output) => [output.name, output.ref])).toEqual([
      ["report", { kind: "step_output", step: "report", output: "report" }],
      ["total_words", { kind: "step_output", step: "count", output: "total_words" }],
    ]);
  });

  test("rejects duplicate keys instead of letting the last win", () => {
    expect(() => parsePipeline("name: a\nname: b\nsteps:\n  s:\n    uses: ./x.sh\n")).toThrow(
      expect.objectContaining({ code: "pipeline_yaml_invalid" }),
    );
  });

  test("rejects multiple documents", () => {
    expect(() => parsePipeline("name: a\n---\nname: b\n")).toThrow(
      expect.objectContaining({ code: "pipeline_yaml_invalid" }),
    );
  });

  test("rejects an unknown key as a schema error", () => {
    expect(() => parsePipeline("name: a\nbogus: 1\nsteps:\n  s:\n    uses: ./x.sh\n")).toThrow(
      expect.objectContaining({ code: "pipeline_schema_invalid", path: "bogus" }),
    );
  });

  test("parses durations into seconds once", () => {
    const pipeline: Pipeline = parsePipeline(
      "name: a\nsteps:\n  s:\n    uses: ./x.sh\n    timeout: 1h30m\n    kill_grace: 0s\n    retry:\n      delay: 2m\n      max_delay: 5m\n",
    );
    const step = pipeline.steps[0]!;
    expect(step.timeout).toBe(5400);
    expect(step.kill_grace).toBe(0);
    expect(step.retry.delay).toBe(120);
    expect(step.retry.max_delay).toBe(300);
  });

  test("a template with a stray ${{ is expression_invalid", () => {
    expect(() => parsePipeline('name: a\nsteps:\n  s:\n    uses: ./x.sh\n    with:\n      t: "${{ inputs.a }} ${{"\n')).toThrow(
      expect.objectContaining({ code: "expression_invalid" }),
    );
  });
});
