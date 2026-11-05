import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELLO_BLOCK, cli, lines, parsed, startServer } from "./helpers.ts";

let server: Awaited<ReturnType<typeof startServer>> | null = null;
const files: string[] = [];

function file(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bashreactor-cli-files-"));
  files.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

afterEach(async () => {
  await server?.stop();
  server = null;
  for (const dir of files.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("blocks", () => {
  test("add, ls, get and content, in both modes", async () => {
    server = await startServer();
    const path = file("hello.sh", HELLO_BLOCK);

    const added = await cli(["blocks", "add", "hello", path], { url: server.url });
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("added hello@1");

    const again = await cli(["blocks", "add", "hello", path, "--json"], { url: server.url });
    expect(again.code).toBe(0);
    // The same bytes are the same version (SPEC 2), and the API says so rather than storing twice.
    expect(parsed(again).version).toBe(1);

    const list = await cli(["blocks", "ls", "hello"], { url: server.url });
    expect(list.code).toBe(0);
    expect(lines(list.stdout)[0]).toBe("hello — 1 version(s), latest 1");
    expect(lines(list.stdout)[2]!.startsWith("hello  1")).toBe(true);

    const listed = await cli(["blocks", "ls", "hello", "--json"], { url: server.url });
    expect(parsed(listed).versions[0].name).toBe("hello");

    const got = await cli(["blocks", "get", "hello", "--version", "1"], { url: server.url });
    expect(got.code).toBe(0);
    expect(got.stdout).toMatch(/name\s+hello/);
    expect(got.stdout).toMatch(/version\s+1/);

    const content = await cli(["blocks", "content", "hello"], { url: server.url });
    expect(content.code).toBe(0);
    // The bytes are the block's, byte for byte, with nothing added around them.
    expect(content.stdout).toBe(HELLO_BLOCK);
    expect(content.stderr).toBe("");

    const contentJson = await cli(["blocks", "content", "hello", "--json"], { url: server.url });
    expect(contentJson.code).toBe(0);
    const record = parsed(contentJson);
    expect(record.version).toBe(1);
    expect(record.content).toBe(HELLO_BLOCK);
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a block whose header names something else is the API's own refusal", async () => {
    server = await startServer();
    const path = file("other.sh", HELLO_BLOCK.replace("name: hello", "name: different"));
    const result = await cli(["blocks", "add", "other", path], { url: server.url });
    expect(result.code).toBe(1);
    expect(parsed({ ...result, stdout: result.stderr }).code).toBe("block_schema_invalid");
  });

  test("a file that is not there is exit 2, and a block that is not there is exit 1", async () => {
    server = await startServer();
    const missing = await cli(["blocks", "add", "hello", "/nope/hello.sh"], { url: server.url });
    expect(missing.code).toBe(2);
    expect(parsed({ ...missing, stdout: missing.stderr }).code).toBe("file_input_not_found");

    const absent = await cli(["blocks", "ls", "nothing-here"], { url: server.url });
    expect(absent.code).toBe(1);
    expect(parsed({ ...absent, stdout: absent.stderr }).code).toBe("block_not_found");
  });
});
