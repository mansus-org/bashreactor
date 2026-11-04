import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCli } from "./index.ts";

describe("runCli", () => {
  test("prints the shared error body and fails", () => {
    const lines: string[] = [];
    const code = runCli(["run", "demo.yaml"], { stderr: (line) => lines.push(line) });
    expect(code).toBe(1);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { error: { code: "not_implemented", message: "bashreactor: run is not implemented yet" } },
    ]);
  });

  test("the bin exits non-zero so a script cannot mistake it for success", async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "bin.ts"), "run"], { stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("not_implemented");
  });
});
