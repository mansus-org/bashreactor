import { describe, expect, test } from "bun:test";
import { BashreactorError, NotImplementedError } from "./errors.ts";

describe("errors", () => {
  test("carry a code and serialize to the body every surface prints", () => {
    const err = new BashreactorError("invalid_pipeline", "steps must not be empty");
    expect(err).toBeInstanceOf(Error);
    expect(err.toBody()).toEqual({ error: { code: "invalid_pipeline", message: "steps must not be empty" } });
  });

  test("NotImplementedError is a BashreactorError with the not_implemented code", () => {
    const err = new NotImplementedError("resume");
    expect(err).toBeInstanceOf(BashreactorError);
    expect(err.code).toBe("not_implemented");
    expect(err.message).toBe("resume is not implemented yet");
  });
});
