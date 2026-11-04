import { expect, test } from "bun:test";
import { openStore } from "./index.ts";

test("refuses with not_implemented instead of pretending to persist anything", () => {
  expect(() => openStore()).toThrow(expect.objectContaining({ code: "not_implemented" }));
});
