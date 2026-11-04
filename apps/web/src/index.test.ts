import { expect, test } from "bun:test";
import { mountApp } from "./index.ts";

test("refuses with not_implemented instead of rendering an empty shell", () => {
  expect(() => mountApp()).toThrow(expect.objectContaining({ code: "not_implemented" }));
});
