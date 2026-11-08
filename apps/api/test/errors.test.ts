// The contract this package is judged on: SPEC section 5 is the list of codes a client may see, and
// this API answers with nothing the spec has not agreed to. Review 39 found thirteen codes raised in
// code and absent from the spec, and one code mapped to a status that nothing could ever raise; both
// directions are pinned here so they cannot drift again.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ERROR_CODES } from "@bashreactor/core";
import { CODES_WITH_STATUS, statusForCode } from "../src/errors.ts";

/**
 * The codes in the table in SPEC section 5, taken from the first cell of each row so that a row
 * which mentions other codes while explaining one does not count as declaring them.
 */
function specCodes(): Set<string> {
  const spec = readFileSync(join(import.meta.dir, "../../../docs/SPEC.md"), "utf8");
  const section = spec.slice(spec.indexOf("\n## 5. Errors"), spec.indexOf("\n## 6. "));
  const codes = new Set<string>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const firstCell = line.split("|")[1] ?? "";
    for (const match of firstCell.matchAll(/`([a-z][a-z_]+)`/g)) codes.add(match[1]!);
  }
  return codes;
}

/**
 * What a client says when the API did not answer at all, so no route of this API can raise it. Every
 * other code in the spec is one this API can answer with, and the test below holds it to that.
 */
const RAISED_BY_A_CLIENT = ["api_unreachable"];

describe("the code list is the spec's", () => {
  const codes = specCodes();

  test("every code core can fail with is in SPEC 5", () => {
    for (const code of ERROR_CODES) expect(codes.has(code)).toBe(true);
  });

  test("every code this API has a status for is in SPEC 5", () => {
    for (const code of CODES_WITH_STATUS) expect(codes.has(code)).toBe(true);
  });

  test("every code in SPEC 5 has a status decided here", () => {
    for (const code of codes) {
      if (RAISED_BY_A_CLIENT.includes(code)) continue;
      expect(CODES_WITH_STATUS).toContain(code);
    }
  });

  test("the codes review 39 found in code and not in the spec are all in it now", () => {
    for (const code of [
      "forbidden",
      "unauthenticated",
      "internal_error",
      "invalid_argument",
      "pipeline_not_found",
      "step_not_found",
      "attempt_not_found",
      "token_not_found",
      "artifact_not_found",
      "bad_request",
      "not_found",
      "method_not_allowed",
      "api_unreachable",
    ]) {
      expect(codes.has(code)).toBe(true);
    }
  });

  test("a code nothing raises is not in the spec either", () => {
    // Declared in packages/store/src/errors.ts, raised nowhere: a client cannot meet it, so the
    // spec does not promise it and this API does not map a status for it.
    expect(codes.has("store_locked")).toBe(false);
    expect(CODES_WITH_STATUS).not.toContain("store_locked");
  });

  test("the status follows from the code alone", () => {
    expect(statusForCode("unauthenticated")).toBe(401);
    expect(statusForCode("forbidden")).toBe(403);
    expect(statusForCode("pipeline_not_found")).toBe(404);
    expect(statusForCode("token_not_found")).toBe(404);
    expect(statusForCode("step_not_found")).toBe(404);
    expect(statusForCode("attempt_not_found")).toBe(404);
    expect(statusForCode("artifact_not_found")).toBe(404);
    expect(statusForCode("bad_request")).toBe(400);
    expect(statusForCode("not_found")).toBe(404);
    expect(statusForCode("method_not_allowed")).toBe(405);
    expect(statusForCode("invalid_argument")).toBe(422);
    expect(statusForCode("already_exists")).toBe(409);
    expect(statusForCode("version_conflict")).toBe(409);
    expect(statusForCode("internal_error")).toBe(500);
    expect(statusForCode("store_closed")).toBe(500);
    expect(statusForCode("store_migration_failed")).toBe(500);
  });

  test("a code nobody thought about is a 500, not a wrong 4xx", () => {
    expect(statusForCode("a_code_that_is_not_anywhere")).toBe(500);
  });
});
