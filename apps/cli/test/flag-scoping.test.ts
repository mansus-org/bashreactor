import { describe, expect, test } from "bun:test";

import { COMMANDS } from "../src/index";
import { parseArgs } from "../src/args";

/**
 * Two commands may spell a flag the same way and mean different things by it. `tokens add --scope`
 * picks what a token may do, `runs files --scope` picks which part of a run to list, and the choices
 * were once read from one table holding every command's flags: whichever command declared `--scope`
 * first won, and the other's flag was validated against a list it never promised.
 */
describe("a flag means what its own command says it means", () => {
  test("each command's own choices are the ones enforced", () => {
    expect(() => parseArgs(["tokens", "add", "ci", "--scope", "read"], COMMANDS)).not.toThrow();
    expect(() => parseArgs(["runs", "files", "run_1", "--scope", "work"], COMMANDS)).not.toThrow();
  });

  test("and a value outside them names the list it was checked against", () => {
    let message = "";
    try {
      parseArgs(["tokens", "add", "ci", "--scope", "everything"], COMMANDS);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toInclude("read, write");
    expect(message).not.toInclude("outputs, work");

    try {
      parseArgs(["runs", "files", "run_1", "--scope", "everything"], COMMANDS);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toInclude("outputs, work, logs, all");
    expect(message).not.toInclude("read, write");
  });

  test("a flag is still only accepted by the command that declares it", () => {
    expect(() => parseArgs(["runs", "files", "run_1", "--tail", "10"], COMMANDS)).toThrow();
    expect(() => parseArgs(["runs", "logs", "run_1", "--scope", "work"], COMMANDS)).toThrow();
  });
});
