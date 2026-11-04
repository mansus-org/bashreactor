import { expect, test } from "bun:test";
import { createMcpServer } from "./index.ts";

test("refuses with not_implemented instead of exposing tools that do nothing", () => {
  expect(() => createMcpServer()).toThrow(expect.objectContaining({ code: "not_implemented" }));
});
