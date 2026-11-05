import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../src/config.ts";
import { TokenStore } from "../src/tokens.ts";

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "bashreactor-tokens-")), "tokens.json");
}

describe("TokenStore", () => {
  test("a token comes back once and is stored only as a hash", () => {
    const path = tempPath();
    const tokens = new TokenStore(path);
    const { info, token } = tokens.create("build agent", "write");

    expect(token).toStartWith("br_");
    expect(token.length).toBeGreaterThan(30);
    expect(info.name).toBe("build agent");
    expect(info.scope).toBe("write");
    expect(info.created_at).toStartWith("20");
    expect(info.last_used).toBeNull();

    // The clear text is never written anywhere, and listing never gives it back.
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).not.toContain(token);
    expect(onDisk).toContain(sha256Hex(token));
    expect(tokens.list()).toEqual([{ ...info, last_used: info.last_used }]);
  });

  test("check matches a token and records last_used at most once a minute", () => {
    const tokens = new TokenStore(tempPath());
    const { token } = tokens.create("reader", "read");
    expect(tokens.check("br_not_the_token")).toBeNull();

    const first = tokens.check(token, new Date("2026-11-04T10:00:00Z"));
    expect(first?.name).toBe("reader");
    expect(first?.last_used).toBe("2026-11-04T10:00:00.000Z");

    const soon = tokens.check(token, new Date("2026-11-04T10:00:20Z"));
    expect(soon?.last_used).toBe("2026-11-04T10:00:00.000Z");

    const later = tokens.check(token, new Date("2026-11-04T10:02:00Z"));
    expect(later?.last_used).toBe("2026-11-04T10:02:00.000Z");
  });

  test("a revoked token stops matching, and a new store on the same file agrees", () => {
    const path = tempPath();
    const tokens = new TokenStore(path);
    const { info, token } = tokens.create("temp", "read");
    expect(tokens.check(token)).not.toBeNull();

    tokens.revoke(info.id);
    expect(tokens.check(token)).toBeNull();
    expect(new TokenStore(path).check(token)).toBeNull();
  });

  test("revoking an unknown id is token_not_found", () => {
    const tokens = new TokenStore(tempPath());
    expect(() => tokens.revoke("nope")).toThrow(expect.objectContaining({ code: "token_not_found" }));
  });

  test("a name and a scope are required, and only read and write are scopes", () => {
    const tokens = new TokenStore(tempPath());
    expect(() => tokens.create("   ", "read")).toThrow(expect.objectContaining({ code: "missing_input" }));
    expect(() => tokens.create("agent", "admin")).toThrow(expect.objectContaining({ code: "type_mismatch" }));
  });

  test("a token file that cannot be read means no agents, and says why", () => {
    const path = tempPath();
    writeFileSync(path, "{ not json");
    const warnings: string[] = [];
    const tokens = new TokenStore(path, (line) => warnings.push(line));
    const problem = tokens.problem;
    expect(tokens.list()).toEqual([]);
    if (typeof problem !== "string") throw new Error(`expected a problem, got ${String(problem)}`);
    expect(problem).toContain(path);
    expect(warnings).toEqual([problem]);
  });

  test("entries that are not tokens are dropped", () => {
    const path = tempPath();
    writeFileSync(path, JSON.stringify({ tokens: [{ nonsense: true }] }));
    expect(new TokenStore(path).list()).toEqual([]);
  });
});
