import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELLO_BLOCK, cli, libraryDir, parsed, startServer, treeDigest } from "./helpers.ts";

let server: Awaited<ReturnType<typeof startServer>> | null = null;
const dirs: string[] = [];

/** A pipeline directory, so a `uses: ./block.sh` has something beside it, as it does on a disk. */
function pipelineDir(name: string, yaml: string, blocks: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bashreactor-cli-files-"));
  dirs.push(dir);
  for (const [file, content] of Object.entries(blocks)) writeFileSync(join(dir, file), content);
  const path = join(dir, `${name}.yaml`);
  writeFileSync(path, yaml);
  return path;
}

afterEach(async () => {
  await server?.stop();
  server = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GOOD = `name: hello-pipeline
inputs:
  name:
    type: string
    default: world
steps:
  greet:
    uses: ./hello.sh
    with:
      name: \${{ inputs.name }}
`;

const BROKEN = `name: hello-pipeline
steps:
  greet:
    uses: ./nope.sh
    with:
      nothing: 1
`;

// SPEC 3.1: quoting and flow style are the same YAML value, so every one of these is the same
// reference as `uses: ./hello.sh` and has to resolve the same way.
const DOUBLE_QUOTED = `name: quoted-pipeline
# a comment the file keeps
steps:
  greet:
    uses: "./hello.sh"
`;

const SINGLE_QUOTED = `name: quoted-pipeline
steps:
  greet:
    uses: './hello.sh'
`;

const FLOW = `name: flow-pipeline
steps:
  a: { uses: ./hello.sh }
`;

describe("pipelines", () => {
  // SPEC 3.9: validation "runs over the pipeline and the headers of all blocks it references, and
  // creates nothing". It used to publish every block beside the file to get an answer, which made it
  // a write and needed a write token.
  test("validate checks the file where it lies and leaves the library alone", async () => {
    server = await startServer();
    const path = pipelineDir("hello-pipeline", GOOD, { "hello.sh": HELLO_BLOCK });
    const before = treeDigest(libraryDir(server));

    const human = await cli(["pipelines", "validate", path], { url: server.url });
    expect(human.code).toBe(0);
    expect(human.stdout.trim()).toBe(`valid  ${path}`);
    // Nothing was done to get there, so there is nothing to report having done.
    expect(human.stderr).toBe("");

    const json = await cli(["pipelines", "validate", path, "--json"], { url: server.url });
    expect(json.code).toBe(0);
    expect(json.stderr).toBe("");
    expect(parsed(json)).toEqual({ valid: true, issues: [] });

    // The library, byte for byte: not one block published on the way to the verdict.
    expect(treeDigest(libraryDir(server))).toEqual(before);
    const listed = await cli(["blocks", "ls", "hello", "--json"], { url: server.url });
    expect(parsed(listed).code).toBe("block_not_found");
  });

  test("validate needs no write token, and no token at all when the blocks are beside the file", async () => {
    server = await startServer();
    const path = pipelineDir("hello-pipeline", GOOD, { "hello.sh": HELLO_BLOCK });

    const minted = await cli(["tokens", "add", "reader", "--scope", "read", "--json"], { url: server.url });
    expect(minted.code).toBe(0);
    const read = parsed(minted).token as string;

    // A read token used to be refused, because validating meant publishing.
    const readOnly = await cli(["pipelines", "validate", path], { url: server.url, token: read });
    expect(readOnly.code).toBe(0);
    expect(readOnly.stdout.trim()).toBe(`valid  ${path}`);

    // Every block is a file next to the pipeline, so no route is called for them at all.
    const offline = await cli(["pipelines", "validate", path], { url: server.url, token: null });
    expect(offline.code).toBe(0);
    expect(offline.stdout.trim()).toBe(`valid  ${path}`);
  });

  test("an invalid pipeline is exit 1 with every issue, and the issues are the spec's words", async () => {
    server = await startServer();
    const path = pipelineDir("broken", BROKEN, {});

    const human = await cli(["pipelines", "validate", path], { url: server.url });
    expect(human.code).toBe(1);
    expect(human.stdout).toContain("invalid");
    expect(human.stdout).toContain("block_not_found");

    const json = await cli(["pipelines", "validate", path, "--json"], { url: server.url });
    expect(json.code).toBe(1);
    const report = parsed(json);
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue: { code: string }) => issue.code)).toContain("block_not_found");
  });

  test("a quoted or flow-style path reference validates like any other, with nothing published", async () => {
    server = await startServer();
    const before = treeDigest(libraryDir(server));
    for (const [name, yaml] of [
      ["double", DOUBLE_QUOTED],
      ["single", SINGLE_QUOTED],
      ["flow", FLOW],
    ] as const) {
      const path = pipelineDir(name, yaml, { "hello.sh": HELLO_BLOCK });
      const result = await cli(["pipelines", "validate", path], { url: server.url });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(`valid  ${path}`);
      expect(result.stderr).toBe("");
    }
    expect(treeDigest(libraryDir(server))).toEqual(before);
  });

  // SPEC 2.3: the header's name is the block's name and the filename is a convenience. The library
  // used to be told the filename, so `other-file.sh` could never be `real-name`.
  test("a block file is published under the name its header declares", async () => {
    server = await startServer();
    const renamed = HELLO_BLOCK.replace("name: hello", "name: real-name");
    const path = pipelineDir("mismatch", `name: mismatched\nsteps:\n  greet:\n    uses: ./other-file.sh\n`, {
      "other-file.sh": renamed,
    });

    // Validation reads the header, so a filename that disagrees with it is nobody's problem.
    const checked = await cli(["pipelines", "validate", path], { url: server.url });
    expect(checked.code).toBe(0);

    const added = await cli(["pipelines", "add", "mismatched", path], { url: server.url });
    expect(added.code).toBe(0);
    expect(added.stderr).toContain("other-file.sh as real-name@1");

    const stored = await cli(["pipelines", "get", "mismatched", "--json"], { url: server.url });
    expect(parsed(stored).yaml).toContain("uses: real-name@1");
    const listed = await cli(["blocks", "ls", "real-name", "--json"], { url: server.url });
    expect(parsed(listed).latest).toBe(1);
  });

  test("the rewrite keeps the file's own bytes and points only the reference at the library", async () => {
    server = await startServer();
    const path = pipelineDir("quoted", DOUBLE_QUOTED, { "hello.sh": HELLO_BLOCK });

    const added = await cli(["pipelines", "add", "quoted-pipeline", path], { url: server.url });
    expect(added.code).toBe(0);

    const got = await cli(["pipelines", "get", "quoted-pipeline"], { url: server.url });
    expect(got.stdout).toContain("# a comment the file keeps");
    expect(got.stdout).toContain('uses: hello@1');
    expect(got.stdout).not.toContain('"./hello.sh"');
  });

  test("a library reference resolves in a flow mapping and in quotes, with nothing published", async () => {
    server = await startServer();
    const block = pipelineDir("hello", HELLO_BLOCK, {});
    expect((await cli(["blocks", "add", "hello", block], { url: server.url })).code).toBe(0);
    const read = parsed(
      await cli(["tokens", "add", "reader", "--scope", "read", "--json"], { url: server.url }),
    ).token as string;
    const before = treeDigest(libraryDir(server));

    for (const yaml of [
      `name: flow-lib\nsteps:\n  a: { uses: hello@1 }\n`,
      `name: quoted-lib\nsteps:\n  a:\n    uses: "hello@1"\n`,
    ]) {
      const path = pipelineDir("lib", yaml, {});
      // The library is read over a GET, so a read token is enough and nothing is written.
      const result = await cli(["pipelines", "validate", path], { url: server.url, token: read });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(`valid  ${path}`);
      expect(result.stderr).not.toContain("published");
    }
    expect(treeDigest(libraryDir(server))).toEqual(before);
  });

  test("a library block that is not there is block_not_found in the report, not a failed command", async () => {
    server = await startServer();
    const path = pipelineDir("gone", `name: gone-lib\nsteps:\n  a:\n    uses: nope@1\n`, {});

    const result = await cli(["pipelines", "validate", path, "--json"], { url: server.url });
    expect(result.code).toBe(1);
    expect(parsed(result).issues).toEqual([
      { code: "block_not_found", path: "steps.a.uses", message: 'block "nope@1" was not found' },
    ]);
  });

  test("a library reference cannot be read without a token, and says so", async () => {
    server = await startServer();
    const path = pipelineDir("gone", `name: needs-a-token\nsteps:\n  a:\n    uses: nope@1\n`, {});

    const result = await cli(["pipelines", "validate", path, "--json"], { url: server.url, token: null });
    expect(result.code).toBe(1);
    expect(parsed(result).code).toBe("unauthenticated");
  });

  test("a block that is really missing is block_not_found, in the spec's own words", async () => {
    server = await startServer();
    const path = pipelineDir("missing", `name: gone\nsteps:\n  a:\n    uses: "./nope.sh"\n`, {});

    const result = await cli(["pipelines", "validate", path, "--json"], { url: server.url });
    expect(result.code).toBe(1);
    expect(parsed(result).issues).toEqual([
      {
        code: "block_not_found",
        path: "steps.a.uses",
        message: 'block "./nope.sh" was not found',
      },
    ]);
  });

  test("add stores a version, and ls and get read it back", async () => {
    server = await startServer();
    const path = pipelineDir("hello-pipeline", GOOD, { "hello.sh": HELLO_BLOCK });

    const added = await cli(["pipelines", "add", "hello-pipeline", path], { url: server.url });
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("stored hello-pipeline@1");

    const list = await cli(["pipelines", "ls", "hello-pipeline", "--json"], { url: server.url });
    expect(parsed(list).latest).toBe(1);

    const got = await cli(["pipelines", "get", "hello-pipeline"], { url: server.url });
    expect(got.code).toBe(0);
    expect(got.stdout).toMatch(/name\s+hello-pipeline/);
    expect(got.stdout).toContain("steps:");
    // The stored YAML is the rewritten one: the library reference, not the path on this disk.
    expect(got.stdout).toContain("uses: hello@1");
    expect(got.stdout).not.toContain("./hello.sh");

    const json = await cli(["pipelines", "get", "hello-pipeline", "--json"], { url: server.url });
    expect(parsed(json).parsed.inputs[0].name).toBe("name");
  });

  test("a pipeline file that is not there is exit 2", async () => {
    server = await startServer();
    const result = await cli(["pipelines", "validate", "/nope/thing.yaml"], { url: server.url });
    expect(result.code).toBe(2);
    expect(parsed({ ...result, stdout: result.stderr }).code).toBe("file_input_not_found");
  });

  test("a name that has no versions is the API's 404", async () => {
    server = await startServer();
    const result = await cli(["pipelines", "ls", "nothing"], { url: server.url });
    expect(result.code).toBe(1);
    expect(parsed({ ...result, stdout: result.stderr }).code).toBe("pipeline_not_found");
  });
});
