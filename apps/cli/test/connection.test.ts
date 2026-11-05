import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ADMIN_TOKEN, cli, parsed, startServer } from "./helpers.ts";

let server: Awaited<ReturnType<typeof startServer>> | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

describe("health", () => {
  test("says the server is up, in both modes", async () => {
    server = await startServer();
    const human = await cli(["health"], { url: server.url, token: null });
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/^ok\s+cli-test$/m);
    expect(human.stderr).toBe("");

    const json = await cli(["health", "--json"], { url: server.url, token: null });
    expect(json.code).toBe(0);
    expect(parsed(json)).toEqual({ status: "ok", version: "cli-test" });
  });

  test("a server it cannot reach is a failure, not a wrong command line", async () => {
    const result = await cli(["health", "--url", "http://127.0.0.1:1"], { token: null });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(parsed({ ...result, stdout: result.stderr }).code).toBe("runtime_missing");
  });
});

describe("whoami", () => {
  test("says who the token is and which source won", async () => {
    server = await startServer();
    const result = await cli(["whoami"], { url: server.url });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`${server.url}  (from BASHREACTOR_URL)`);
    expect(result.stdout).toContain("(from BASHREACTOR_TOKEN)");
    expect(result.stdout).toMatch(/name\s+admin/);
    // The token itself never reaches the terminal in full.
    expect(result.stdout).not.toContain(ADMIN_TOKEN);
  });

  test("a flag beats the environment", async () => {
    server = await startServer();
    const result = await cli(["whoami", "--url", server.url, "--token", ADMIN_TOKEN], {
      url: "http://flag-loser.test",
      token: "br_loser",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`${server.url}  (from --url)`);
    expect(result.stdout).toContain("(from --token)");
  });

  test("the environment beats the config file, and the file is read when neither is set", async () => {
    server = await startServer();
    const home = mkdtempSync(join(tmpdir(), "bashreactor-cli-config-"));
    writeFileSync(
      join(home, "cli.json"),
      JSON.stringify({ url: server.url, token: ADMIN_TOKEN }),
      { mode: 0o600 },
    );

    const fromFile = await cli(["whoami"], { url: null, token: null, env: { BASHREACTOR_HOME: home } });
    expect(fromFile.code).toBe(0);
    expect(fromFile.stdout).toContain(`${server.url}  (from ${join(home, "cli.json")})`);
    expect(fromFile.stdout).toMatch(/name\s+admin/);

    const fromEnv = await cli(["whoami"], { url: server.url, token: null, env: { BASHREACTOR_HOME: home } });
    expect(fromEnv.stdout).toContain("(from BASHREACTOR_URL)");

    rmSync(home, { recursive: true, force: true });
  });

  test("a config file that is not an object of the two settings is a usage error", async () => {
    const home = mkdtempSync(join(tmpdir(), "bashreactor-cli-config-"));
    writeFileSync(join(home, "cli.json"), "{ not json");
    const broken = await cli(["whoami"], { url: null, token: null, env: { BASHREACTOR_HOME: home } });
    expect(broken.code).toBe(2);
    expect(parsed({ ...broken, stdout: broken.stderr }).code).toBe("invalid_argument");

    writeFileSync(join(home, "cli.json"), JSON.stringify({ url: "http://x.test", port: 8080 }));
    const unknown = await cli(["whoami"], { url: null, token: null, env: { BASHREACTOR_HOME: home } });
    expect(unknown.code).toBe(2);
    expect(parsed({ ...unknown, stdout: unknown.stderr }).path).toBe("port");
    rmSync(home, { recursive: true, force: true });
  });

  test("nothing configured at all says what to do about it", async () => {
    const noUrl = await cli(["whoami"], { url: null, token: null });
    expect(noUrl.code).toBe(2);
    expect(noUrl.stderr).toContain("no API URL");

    server = await startServer();
    const noToken = await cli(["whoami"], { url: server.url, token: null });
    expect(noToken.code).toBe(2);
    expect(noToken.stderr).toContain("no token");
  });

  test("a wrong token is the API refusing, which is a different exit code from a wrong argument", async () => {
    server = await startServer();
    const wrongToken = await cli(["whoami"], { url: server.url, token: "br_not_a_token" });
    expect(wrongToken.code).toBe(1);
    expect(wrongToken.stdout).toBe("");
    expect(parsed({ ...wrongToken, stdout: wrongToken.stderr })).toEqual({
      code: "unauthenticated",
      message: "invalid or revoked token",
    });

    const wrongArgument = await cli(["whoami", "extra"], { url: server.url });
    expect(wrongArgument.code).toBe(2);
    expect(wrongArgument.stderr).toContain("usage: bashreactor whoami");
  });

  test("--json prints the API's own object and nothing else", async () => {
    server = await startServer();
    const result = await cli(["whoami", "--json"], { url: server.url });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed(result)).toEqual({ name: "admin", scope: "admin", admin: true });
  });
});

describe("a token from the API itself", () => {
  test("a read token gets read routes and no others", async () => {
    server = await startServer();
    const created = await cli(["tokens", "add", "reader", "--scope", "read", "--json"], { url: server.url });
    const token = parsed(created).token as string;

    const allowed = await cli(["whoami", "--json"], { url: server.url, token });
    expect(allowed.code).toBe(0);
    expect(parsed(allowed)).toEqual({ name: "reader", scope: "read", admin: false });

    const refused = await cli(["tokens", "ls"], { url: server.url, token });
    expect(refused.code).toBe(1);
    expect(parsed({ ...refused, stdout: refused.stderr }).code).toBe("forbidden");
  });
});

describe("the config file directory", () => {
  test("a directory that does not exist is simply no config", async () => {
    server = await startServer();
    const missing = join(mkdtempSync(join(tmpdir(), "bashreactor-cli-")), "nothing", "here");
    mkdirSync(missing, { recursive: true });
    const result = await cli(["health"], { url: server.url, token: null, env: { BASHREACTOR_HOME: missing } });
    expect(result.code).toBe(0);
    rmSync(missing, { recursive: true, force: true });
  });
});
