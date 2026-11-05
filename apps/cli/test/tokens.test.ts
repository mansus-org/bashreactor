import { afterEach, describe, expect, test } from "bun:test";
import { ADMIN_TOKEN, cli, lines, parsed, startServer } from "./helpers.ts";

let server: Awaited<ReturnType<typeof startServer>> | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

describe("tokens", () => {
  test("add prints the secret once, ls lists it without it, revoke takes it away", async () => {
    server = await startServer();

    const added = await cli(["tokens", "add", "ci-reader", "--scope", "read"], { url: server.url });
    expect(added.code).toBe(0);
    const token = added.stdout.match(/token\s+(br_[0-9a-f]+)/)?.[1];
    expect(token).toBeDefined();
    expect(added.stderr).toContain("shown once");

    const listed = await cli(["tokens", "ls"], { url: server.url });
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("ci-reader");
    expect(listed.stdout).toContain("read");
    expect(listed.stdout).not.toContain(token!);

    const json = await cli(["tokens", "ls", "--json"], { url: server.url });
    const record = parsed(json)[0];
    expect(record.name).toBe("ci-reader");
    expect(record.token).toBeUndefined();
    expect(record.id).toBeTruthy();

    const revoked = await cli(["tokens", "revoke", record.id, "--json"], { url: server.url });
    expect(revoked.code).toBe(0);
    expect(parsed(revoked)).toEqual({ deleted: record.id });

    // The next request with it fails, without a restart.
    const after = await cli(["whoami", "--json"], { url: server.url, token });
    expect(after.code).toBe(1);
    expect(parsed(after).code).toBe("unauthenticated");
  });

  test("the scope is not optional, and only the two the API knows are allowed", async () => {
    server = await startServer();

    const missing = await cli(["tokens", "add", "x"], { url: server.url });
    expect(missing.code).toBe(2);
    expect(parsed({ ...missing, stdout: missing.stderr }).path).toBe("scope");

    const wrong = await cli(["tokens", "add", "x", "--scope", "everything"], { url: server.url });
    expect(wrong.code).toBe(2);
    expect(wrong.stderr).toContain("read, write");
  });

  test("revoking an id that is not there is the API's answer, not ours", async () => {
    server = await startServer();
    const result = await cli(["tokens", "revoke", "0f6c0b0e-5007-4ec4-9d0a-0ffbc4d2f6c1"], { url: server.url });
    expect(result.code).toBe(1);
    expect(parsed({ ...result, stdout: result.stderr }).code).toBe("token_not_found");
  });

  test("the admin token is the only one that may list them", async () => {
    server = await startServer();
    const result = await cli(["tokens", "ls"], { url: server.url, token: ADMIN_TOKEN });
    expect(result.code).toBe(0);
    expect(lines(result.stdout)[0]).toContain("no agent tokens");
  });
});
