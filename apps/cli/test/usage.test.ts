import { describe, expect, test } from "bun:test";
import { cli, parsed } from "./helpers.ts";

// Everything in this file fails before a request is made, so it needs no server: a wrong command
// line is exit 2 and the API never hears about it.

describe("the command line", () => {
  test("no command at all says so and exits 2", async () => {
    const result = await cli([]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(parsed({ ...result, stdout: result.stderr }).message).toContain("no command given");
  });

  test("an unknown command is a usage error, not a 404", async () => {
    const result = await cli(["--url", "http://127.0.0.1:1", "--token", "x", "frobnicate"]);
    expect(result.code).toBe(2);
    expect(parsed({ ...result, stdout: result.stderr }).code).toBe("invalid_argument");
  });

  test("a group without its command lists the ones it has", async () => {
    const result = await cli(["runs"]);
    expect(result.code).toBe(2);
    expect(parsed({ ...result, stdout: result.stderr }).message).toContain("runs start");
  });

  test("an unknown flag is named", async () => {
    const result = await cli(["health", "--colour"]);
    expect(result.code).toBe(2);
    expect(parsed({ ...result, stdout: result.stderr }).message).toContain("--colour");
  });

  test("a flag that belongs to another command is refused", async () => {
    const result = await cli(["--url", "http://127.0.0.1:1", "--token", "x", "health", "--attempt", "2"]);
    expect(result.code).toBe(2);
    expect(parsed({ ...result, stdout: result.stderr }).message).toContain("is not a flag of");
  });

  test("a missing argument prints the usage line for that command", async () => {
    const result = await cli(["runs", "logs", "20261104T101500Z-3fa9c2d1"]);
    expect(result.code).toBe(2);
    expect(parsed({ ...result, stdout: result.stderr }).message).toBe(
      "usage: bashreactor runs logs <run-id> <step>",
    );
  });

  test("a flag that needs a value says which", async () => {
    const result = await cli(["blocks", "get", "hello", "--version"]);
    expect(result.code).toBe(2);
    expect(parsed({ ...result, stdout: result.stderr }).message).toContain("--version");
  });

  test("a number that is not a number is refused before the request", async () => {
    const result = await cli(["runs", "logs", "20261104T101500Z-3fa9c2d1", "greet", "--offset", "soon"]);
    expect(result.code).toBe(2);
    expect(parsed({ ...result, stdout: result.stderr }).message).toContain("--offset");
  });

  test("--json moves the error object onto stdout, and nothing else is printed", async () => {
    const result = await cli(["runs", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    expect(parsed(result).code).toBe("invalid_argument");
  });

  test("--help prints the command table and exits 0", async () => {
    const all = await cli(["--help"]);
    expect(all.code).toBe(0);
    expect(all.stderr).toBe("");
    for (const line of [
      "runs start",
      "blocks content",
      "pipelines validate",
      "tokens revoke",
      "whoami",
      "health",
    ]) {
      expect(all.stdout).toContain(line);
    }

    const one = await cli(["runs", "logs", "--help"]);
    expect(one.code).toBe(0);
    expect(one.stdout).toContain("usage: bashreactor runs logs <run-id> <step>");
    expect(one.stdout).toContain("--follow");

    const group = await cli(["blocks", "--help"]);
    expect(group.code).toBe(0);
    expect(group.stdout).toContain("blocks content");
  });
});
