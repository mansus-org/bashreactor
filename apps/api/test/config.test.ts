import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  resolveAdminHash,
  resolveConfig,
  resolveDataDir,
  resolvePort,
  resolveVersion,
  sha256Hex,
} from "../src/config.ts";

describe("resolvePort", () => {
  test("defaults to 8080 when PORT is unset or empty", () => {
    expect(resolvePort({})).toBe(8080);
    expect(resolvePort({ PORT: "" })).toBe(8080);
  });

  test("reads PORT", () => {
    expect(resolvePort({ PORT: "9090" })).toBe(9090);
  });

  test.each(["abc", "-1", "65536", "80.5"])("rejects %p", (PORT) => {
    expect(() => resolvePort({ PORT })).toThrow(expect.objectContaining({ code: "runtime_missing" }));
  });
});

describe("resolveVersion", () => {
  test("prefers the version the image was tagged with", () => {
    expect(resolveVersion({ BASHREACTOR_VERSION: "pr-7-abc1234" }, "0.0.0")).toBe("pr-7-abc1234");
  });

  test("falls back when the image was built without one", () => {
    expect(resolveVersion({}, "0.0.0")).toBe("0.0.0");
    expect(resolveVersion({ BASHREACTOR_VERSION: "" }, "0.0.0")).toBe("0.0.0");
  });
});

describe("resolveDataDir", () => {
  test("is BASHREACTOR_HOME when set, and ~/.bashreactor otherwise", () => {
    expect(resolveDataDir({ BASHREACTOR_HOME: "/srv/bashreactor" })).toBe("/srv/bashreactor");
    expect(resolveDataDir({ HOME: "/home/who" })).toBe(join("/home/who", ".bashreactor"));
  });
});

describe("resolveAdminHash", () => {
  test("hashes a clear-text admin token", () => {
    expect(resolveAdminHash({ BASHREACTOR_ADMIN_TOKEN: "secret" })).toBe(sha256Hex("secret"));
  });

  test("takes a pre-hashed admin token, and lowercases it", () => {
    const hash = sha256Hex("secret").toUpperCase();
    expect(resolveAdminHash({ BASHREACTOR_ADMIN_TOKEN_SHA256: hash })).toBe(sha256Hex("secret"));
  });

  test("the hash wins over the clear text", () => {
    const env = { BASHREACTOR_ADMIN_TOKEN: "other", BASHREACTOR_ADMIN_TOKEN_SHA256: sha256Hex("secret") };
    expect(resolveAdminHash(env)).toBe(sha256Hex("secret"));
  });

  test("nothing set means no admin, which disables the API rather than the server", () => {
    expect(resolveAdminHash({})).toBeNull();
  });

  test("a hash that is not 64 hex digits is a configuration error", () => {
    expect(() => resolveAdminHash({ BASHREACTOR_ADMIN_TOKEN_SHA256: "nothex" })).toThrow(
      expect.objectContaining({ code: "runtime_missing" }),
    );
  });
});

describe("resolveConfig", () => {
  test("puts the store and the token file inside the data directory", () => {
    const config = resolveConfig({ BASHREACTOR_HOME: "/srv/br", BASHREACTOR_ADMIN_TOKEN: "secret" }, "v1");
    expect(config.dataDir).toBe("/srv/br");
    expect(config.storeDir).toBe(join("/srv/br", "store"));
    expect(config.tokensPath).toBe(join("/srv/br", "tokens.json"));
    expect(config.adminHash).toBe(sha256Hex("secret"));
    expect(config.version).toBe("v1");
  });
});
