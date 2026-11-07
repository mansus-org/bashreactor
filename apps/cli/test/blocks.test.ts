import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELLO_BLOCK, cli, lines, parsed, sha256Hex, startServer } from "./helpers.ts";

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

  // SPEC 2: the identity of a version is the SHA-256 of the file's exact bytes, and SPEC 2.2: the
  // body is opaque bytes. A block that is not valid UTF-8 used to be rewritten on the way up, so the
  // hash on the record was not the hash of the file that was read.
  test("a block whose bytes are not UTF-8 is stored byte for byte", async () => {
    server = await startServer();
    const bytes = Buffer.concat([
      Buffer.from(
        `#!/usr/bin/env bash\n# ---\n# name: binary-body\n# description: Ends with bytes no terminal can show.\n# ---\n\necho hi\n: "`,
      ),
      Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3]),
      Buffer.from(`"\n`),
    ]);
    const path = file("binary-body.sh", "");
    writeFileSync(path, bytes);

    // The test is only worth writing if a rewrite would show up: decoding the file as UTF-8 text
    // and back is not the same file.
    expect(sha256Hex(bytes)).not.toBe(sha256Hex(new TextDecoder().decode(bytes)));

    const added = await cli(["blocks", "add", "binary-body", path], { url: server.url });
    expect(added.code).toBe(0);
    expect(added.stdout).toContain(`added binary-body@1  ${bytes.length} bytes`);

    const got = await cli(["blocks", "get", "binary-body", "--json"], { url: server.url });
    expect(parsed(got).sha256).toBe(sha256Hex(bytes));
    expect(parsed(got).size).toBe(bytes.length);

    const content = await cli(["blocks", "content", "binary-body"], { url: server.url, raw: true });
    expect(content.code).toBe(0);
    expect(Buffer.from(content.stdoutBytes!).equals(bytes)).toBe(true);
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
