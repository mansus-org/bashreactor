import { describe, expect, test } from "bun:test";
import { resolveApiUrl, resolveConfig, resolvePath, resolvePort, resolveToken, resolveVersion } from "../src/config.ts";

describe("BASHREACTOR_URL", () => {
  test("is required, and says which variable is missing", () => {
    for (const env of [{}, { BASHREACTOR_URL: "" }, { BASHREACTOR_URL: "   " }]) {
      try {
        resolveApiUrl(env);
        throw new Error("expected it to refuse");
      } catch (error) {
        expect((error as { code: string }).code).toBe("runtime_missing");
        expect((error as Error).message).toContain("BASHREACTOR_URL");
      }
    }
  });

  test("is normalised to a base with no trailing slash", () => {
    expect(resolveApiUrl({ BASHREACTOR_URL: "http://127.0.0.1:8080" })).toBe("http://127.0.0.1:8080");
    expect(resolveApiUrl({ BASHREACTOR_URL: "http://127.0.0.1:8080/" })).toBe("http://127.0.0.1:8080");
    // Behind a proxy the API may not sit at the root of the host.
    expect(resolveApiUrl({ BASHREACTOR_URL: "https://br.example.test/api/" })).toBe("https://br.example.test/api");
  });

  test("refuses anything that is not an http origin", () => {
    for (const url of ["not a url", "ftp://host/x", "http://host/x?a=1", "http://host/#frag"]) {
      expect(() => resolveApiUrl({ BASHREACTOR_URL: url })).toThrow();
    }
  });
});

describe("BASHREACTOR_TOKEN", () => {
  test("is optional, and empty means absent", () => {
    expect(resolveToken({})).toBeNull();
    expect(resolveToken({ BASHREACTOR_TOKEN: "" })).toBeNull();
    expect(resolveToken({ BASHREACTOR_TOKEN: "  " })).toBeNull();
    expect(resolveToken({ BASHREACTOR_TOKEN: " br_abc " })).toBe("br_abc");
  });
});

describe("the port", () => {
  test("defaults to 8090 so it never sits on the API's 8080", () => {
    expect(resolvePort({})).toBe(8090);
  });

  test("takes BASHREACTOR_MCP_PORT, and PORT when that is not set", () => {
    expect(resolvePort({ PORT: "9000" })).toBe(9000);
    expect(resolvePort({ PORT: "9000", BASHREACTOR_MCP_PORT: "9100" })).toBe(9100);
  });

  test("refuses a port that is not one", () => {
    for (const raw of ["nope", "1.5", "70000", "-1"]) {
      expect(() => resolvePort({ BASHREACTOR_MCP_PORT: raw })).toThrow();
    }
  });
});

describe("the path", () => {
  test("defaults to /mcp and always starts with a slash", () => {
    expect(resolvePath({})).toBe("/mcp");
    expect(resolvePath({ BASHREACTOR_MCP_PATH: "/mcp/v2" })).toBe("/mcp/v2");
    expect(resolvePath({ BASHREACTOR_MCP_PATH: "mcp" })).toBe("/mcp");
    expect(() => resolvePath({ BASHREACTOR_MCP_PATH: "/mcp?x=1" })).toThrow();
  });
});

describe("the whole config", () => {
  test("resolves once from one environment, the way main.ts does", () => {
    const env = {
      BASHREACTOR_URL: "http://api:8080/",
      BASHREACTOR_TOKEN: "br_x",
      BASHREACTOR_MCP_PORT: "0",
      BASHREACTOR_MCP_PATH: "/mcp",
      BASHREACTOR_VERSION: "1.2.3",
    };
    expect(resolveConfig(env, resolveVersion(env, "0.0.0"))).toEqual({
      apiUrl: "http://api:8080",
      token: "br_x",
      port: 0,
      path: "/mcp",
      version: "1.2.3",
    });
  });

  test("falls back to the manifest version when the environment is silent", () => {
    expect(resolveVersion({}, "0.0.0")).toBe("0.0.0");
    expect(resolveVersion({ BASHREACTOR_VERSION: "ci-test" }, "0.0.0")).toBe("ci-test");
  });
});
