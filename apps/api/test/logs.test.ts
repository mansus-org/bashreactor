// The log route (SPEC 4.8): a reader follows `next_offset` and must never be shown half a character,
// and nothing that the block wrote is held back from it once the attempt is over.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { blockFile, pipelineYaml, startApi } from "./helpers.ts";

const server = startApi();
afterAll(() => server.cleanup());

const body = async (response: Response) => (await response.json()) as Record<string, any>;

// Writes "h", then the first byte of "é", waits, then writes the rest. A poll in the pause is the
// case that used to hand the reader "\ufffdllo".
const SPLIT_BLOCK = blockFile(
  "splitter",
  `name: splitter
description: Write a two-byte character in two writes, with a pause between them.
inputs:
  hold:
    type: integer
    default: 3`,
  `printf 'h'
printf '\\xc3'
sleep "$INPUT_HOLD"
printf '\\xa9llo\\n'`,
);
const SPLIT_PIPELINE = pipelineYaml(
  "splitter-pipeline",
  `  split:
    uses: splitter@1
    with:
      hold: \${{ inputs.hold }}`,
  "inputs:\n  hold:\n    type: integer\n    default: 3\n",
);

// Garbage on purpose, and it ends in the middle of a character: all of it is the block's bytes.
const BROKEN_BLOCK = blockFile(
  "broken",
  `name: broken
description: Write bytes that are not valid UTF-8 and stop half way through one.`,
  `printf 'h\\xff\\xfe\\x80'
printf '\\xc3'`,
);
const BROKEN_PIPELINE = pipelineYaml("broken-pipeline", "  junk:\n    uses: broken@1\n");

const logPath = (id: string, step: string) => join(server.root, "runs", id, "steps", step, "attempts", "1", "log");
const sizeOf = (path: string) => (existsSync(path) ? statSync(path).size : -1);

/**
 * The test PATH holds only the binaries SPEC 2.6 demands a block may call; this one also needs to
 * wait, so give it the real `sleep` the suite itself runs under.
 */
function allow(name: string): void {
  const target = join(server.root, "bin", name);
  if (existsSync(target)) return;
  const real = (process.env.PATH ?? "").split(":").map((dir) => join(dir, name)).find((c) => existsSync(c));
  if (real === undefined) throw new Error(`this suite needs ${name} on PATH`);
  symlinkSync(real, target);
}
allow("sleep");

async function start(pipeline: string, inputs: Record<string, unknown> = {}): Promise<{ id: string }> {
  const response = await server.call("POST", "/v1/runs", { body: { pipeline, inputs } });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

describe("the log route and UTF-8", () => {
  test("a poll between the two bytes of a character shows neither half", async () => {
    expect((await server.call("POST", "/v1/blocks/splitter/versions", { body: { content: SPLIT_BLOCK.content } })).status).toBe(201);
    expect((await server.call("POST", "/v1/pipelines/splitter-pipeline/versions", { body: { yaml: SPLIT_PIPELINE } })).status).toBe(201);
    const run = await start("splitter-pipeline", { hold: 4 });
    const path = logPath(run.id, "split");

    // The block sits with one byte of "é" written for four seconds; catch it there.
    const deadline = Date.now() + 10_000;
    while (sizeOf(path) !== 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(sizeOf(path)).toBe(2);

    const mid = await body(await server.call("GET", `/v1/runs/${run.id}/logs/split/1`));
    expect(mid.text).toBe("h");
    expect(mid.next_offset).toBe(1);
    expect(mid.truncated).toBe(false);

    expect((await server.waitForRun(run.id)).status).toBe("succeeded");
    const all = await body(await server.call("GET", `/v1/runs/${run.id}/logs/split/1`));
    expect(all.text).toBe("héllo\n");
    expect(all.text).not.toInclude("\ufffd");
    expect(all.next_offset).toBe(7);

    // The cursor that stopped at the boundary picks up the whole character, not its second byte.
    const rest = await body(await server.call("GET", `/v1/runs/${run.id}/logs/split/1?offset=1`));
    expect(rest.text).toBe("éllo\n");
    expect(rest.next_offset).toBe(7);
  }, 30_000);

  test("bytes that are not UTF-8 still arrive, and so does a character left unfinished", async () => {
    expect((await server.call("POST", "/v1/blocks/broken/versions", { body: { content: BROKEN_BLOCK.content } })).status).toBe(201);
    expect((await server.call("POST", "/v1/pipelines/broken-pipeline/versions", { body: { yaml: BROKEN_PIPELINE } })).status).toBe(201);
    const run = await start("broken-pipeline");
    expect((await server.waitForRun(run.id)).status).toBe("succeeded");

    const path = logPath(run.id, "junk");
    const chunk = await body(await server.call("GET", `/v1/runs/${run.id}/logs/junk/1`));
    // The same answer as decoding the file itself: the route dropped nothing to be tidy.
    expect(chunk.text).toBe(new TextDecoder().decode(new Uint8Array(readFileSync(path))));
    expect(chunk.next_offset).toBe(sizeOf(path));
    expect(chunk.truncated).toBe(false);
  }, 30_000);
});
