import { describe, expect, test } from "bun:test";
import { BashreactorError, ERROR_CODES, NotImplementedError } from "./errors.ts";

describe("errors", () => {
  test("carry a code, message, path and file", () => {
    const err = new BashreactorError("type_mismatch", "expected integer, got string", {
      path: "steps.count.with.top",
      file: "word-report.yaml",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.toBody()).toEqual({
      code: "type_mismatch",
      message: "expected integer, got string",
      path: "steps.count.with.top",
      file: "word-report.yaml",
    });
  });

  test("omit path and file when there are none", () => {
    expect(new BashreactorError("pipeline_yaml_invalid", "bad").toBody()).toEqual({
      code: "pipeline_yaml_invalid",
      message: "bad",
    });
  });

  test("NotImplementedError keeps the not_implemented code the store imports", () => {
    const err = new NotImplementedError("resume");
    expect(err).toBeInstanceOf(BashreactorError);
    expect(err.code).toBe("not_implemented");
    expect(err.message).toBe("resume is not implemented yet");
  });

  test("every code the spec names exists", () => {
    expect(ERROR_CODES).toContain("pipeline_yaml_invalid");
    expect(ERROR_CODES).toContain("output_too_large");
    expect(ERROR_CODES).toContain("interrupted");
    expect(ERROR_CODES).toContain("run_claimed");
    expect(ERROR_CODES).toContain("runtime_missing");
  });
});
