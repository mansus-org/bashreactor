import { describe, expect, test } from "bun:test";
import type { Pipeline, PipelineStep } from "./types.ts";
import { validateBlock, validatePipeline } from "./validate.ts";

const step = (id: string, needs: string[] = [], rest: Partial<PipelineStep> = {}): PipelineStep => ({
  id,
  block: "some-block",
  needs,
  retries: 0,
  ...rest,
});

const pipeline = (...steps: PipelineStep[]): Pipeline => ({ name: "demo", steps });
const messages = (p: Pipeline) => validatePipeline(p).map((issue) => `${issue.path}: ${issue.message}`);

describe("validateBlock", () => {
  test("accepts a block with distinct params", () => {
    const block = { name: "fetch", inputs: [{ name: "url" }], outputs: [{ name: "path" }, { name: "size" }] };
    expect(validateBlock(block)).toEqual([]);
  });

  test("an input and an output may share a name", () => {
    expect(validateBlock({ name: "copy", inputs: [{ name: "path" }], outputs: [{ name: "path" }] })).toEqual([]);
  });

  test("reports empty and duplicate names with their path", () => {
    const block = { name: " ", inputs: [{ name: "a" }, { name: "a" }], outputs: [{ name: "" }] };
    expect(validateBlock(block)).toEqual([
      { path: "name", message: "must not be empty" },
      { path: "inputs[1].name", message: 'duplicate name "a"' },
      { path: "outputs[0].name", message: "must not be empty" },
    ]);
  });
});

describe("validatePipeline", () => {
  test("accepts a diamond", () => {
    const p = pipeline(step("a"), step("b", ["a"]), step("c", ["a"]), step("d", ["b", "c"]));
    expect(validatePipeline(p)).toEqual([]);
  });

  test("rejects a pipeline with no steps", () => {
    expect(messages(pipeline())).toEqual(["steps: must not be empty"]);
  });

  test("rejects duplicate step ids", () => {
    expect(messages(pipeline(step("a"), step("a")))).toEqual(['steps[1].id: duplicate id "a"']);
  });

  test("rejects needs that point nowhere", () => {
    expect(messages(pipeline(step("a", ["ghost"])))).toEqual(['steps[0].needs[0]: unknown step "ghost"']);
  });

  test("reports a cycle with the path around it", () => {
    const p = pipeline(step("a", ["c"]), step("b", ["a"]), step("c", ["b"]));
    expect(messages(p)).toEqual(["steps: dependency cycle: a -> c -> b -> a"]);
  });

  test("a step that needs itself is a cycle", () => {
    expect(messages(pipeline(step("a", ["a"])))).toEqual(["steps: dependency cycle: a -> a"]);
  });

  test("a step downstream of a cycle is not itself reported as part of it", () => {
    const p = pipeline(step("a", ["b"]), step("b", ["a"]), step("downstream", ["a"]));
    expect(messages(p)).toEqual(["steps: dependency cycle: a -> b -> a"]);
  });

  test.each([-1, 1.5, Number.NaN])("rejects %p retries", (retries) => {
    expect(messages(pipeline(step("a", [], { retries })))).toEqual(["steps[0].retries: must be a non-negative integer"]);
  });

  test.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])("rejects a %p second timeout", (timeoutSeconds) => {
    expect(messages(pipeline(step("a", [], { timeoutSeconds })))).toEqual([
      "steps[0].timeoutSeconds: must be a positive number",
    ]);
  });

  test("a step without a timeout is fine: jobs run for hours", () => {
    expect(validatePipeline(pipeline(step("a"), step("b", [], { timeoutSeconds: 3600 })))).toEqual([]);
  });
});
