import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELLO_BLOCK, cli, parsed, startServer } from "./helpers.ts";

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

describe("pipelines", () => {
  test("validate publishes the blocks beside the file and reports the verdict", async () => {
    server = await startServer();
    const path = pipelineDir("hello-pipeline", GOOD, { "hello.sh": HELLO_BLOCK });

    const human = await cli(["pipelines", "validate", path], { url: server.url });
    expect(human.code).toBe(0);
    expect(human.stdout.trim()).toBe(`valid  ${path}`);
    // What it did to get there is a note, not part of the answer.
    expect(human.stderr).toContain("published");
    expect(human.stderr).toContain("hello@1");

    const json = await cli(["pipelines", "validate", path, "--json"], { url: server.url });
    expect(json.code).toBe(0);
    // The answer is the whole of stdout; what it did to get there is still on stderr, because a
    // side effect a person cannot see is a side effect they will be surprised by.
    expect(json.stderr).toContain("published");
    expect(parsed(json)).toEqual({ valid: true, issues: [] });

    // The blocks it published are now in the library, which is what made the validation pass.
    const listed = await cli(["blocks", "ls", "hello", "--json"], { url: server.url });
    expect(parsed(listed).latest).toBe(1);
  });

  test("an invalid pipeline is exit 1 with every issue, and the issues are the API's words", async () => {
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
