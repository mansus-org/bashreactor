import { describe, expect, test } from "bun:test";
import { parseBlock, parsePipeline } from "./parser.ts";

describe("parser", () => {
  test("refuses instead of pretending to parse", () => {
    expect(() => parseBlock("")).toThrow(expect.objectContaining({ code: "not_implemented" }));
    expect(() => parsePipeline("")).toThrow(expect.objectContaining({ code: "not_implemented" }));
  });

  test.todo("parses docs/examples: blocked until docs/SPEC.md (BASHR-1) fixes the syntax");
});
