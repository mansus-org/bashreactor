import { describe, expect, test } from "bun:test";
import { startRun } from "./index.ts";

describe("startRun", () => {
  test("rejects an invalid pipeline with the validator's own findings", () => {
    const pipeline = { name: "demo", steps: [{ id: "a", block: "b", needs: ["ghost"], retries: 0 }] };
    expect(() => startRun(pipeline)).toThrow(
      expect.objectContaining({
        code: "invalid_pipeline",
        message: 'steps[0].needs[0]: unknown step "ghost"',
      }),
    );
  });

  test("refuses a valid pipeline with not_implemented instead of claiming it ran", () => {
    const pipeline = { name: "demo", steps: [{ id: "a", block: "b", needs: [], retries: 0 }] };
    expect(() => startRun(pipeline)).toThrow(expect.objectContaining({ code: "not_implemented" }));
  });
});
