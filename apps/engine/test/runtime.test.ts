// SPEC 2.6 is a promise about the image a block runs in, so it is tested against a PATH and not
// against a mock: the check has to name exactly what is missing, and it has to be something a server
// can ask before it serves anything rather than something that only surfaces at the first run.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BashreactorError } from "@bashreactor/core";
import { Engine } from "../src/engine.ts";
import { FsRunStore } from "../src/run-store.ts";
import { REQUIRED_BINARIES, checkRuntime } from "../src/runtime.ts";

const fixtures = new URL("./fixtures/", import.meta.url);
const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bashreactor-runtime-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A bin directory holding every binary the spec demands except `without`, linked from the real PATH.
 * Linked rather than stubbed so the bash version check runs against a real bash: the point of these
 * tests is which binary the answer names, not what the binaries do.
 */
function binWithout(...without: string[]): string {
  const bin = join(newRoot(), "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of REQUIRED_BINARIES) {
    if (without.includes(name)) continue;
    const real = Bun.which(name);
    if (real === null) throw new Error(`this suite needs ${name} on PATH`);
    symlinkSync(real, join(bin, name));
  }
  return bin;
}

async function refused(run: () => Promise<unknown>): Promise<BashreactorError> {
  try {
    await run();
  } catch (error) {
    return error as BashreactorError;
  }
  throw new Error("expected the run to be refused");
}

describe("checkRuntime", () => {
  test("says nothing when the contract holds", () => {
    expect(checkRuntime(binWithout())).toEqual([]);
  });

  test("names jq, and only jq, in an image built without it", () => {
    // The exact container from the review: everything else present, the one package the Dockerfile
    // forgot missing. Before this check ran at startup, that image answered `ok` until a run came.
    expect(checkRuntime(binWithout("jq"))).toEqual(["jq"]);
  });

  test("names every one of them, in the spec's order, when there is no PATH at all", () => {
    expect(checkRuntime("")).toEqual([...REQUIRED_BINARIES]);
    expect(checkRuntime("/does/not/exist")).toEqual([...REQUIRED_BINARIES]);
  });

  test("does not count a file that is there but not executable", () => {
    const bin = binWithout("jq");
    const inert = join(bin, "jq");
    writeFileSync(inert, "not a binary\n");
    chmodSync(inert, 0o644);
    expect(checkRuntime(bin)).toEqual(["jq"]);
  });

  test("names an old bash with the version it wanted", () => {
    const bin = binWithout("bash");
    // Whatever the real bash's major is, this is the answer the check has to produce for a bash 3.2,
    // which is the one an engine has actually met.
    const oldBash = join(bin, "bash");
    writeFileSync(oldBash, '#!/bin/sh\nprintf %s 3\n', { mode: 0o755 });
    chmodSync(oldBash, 0o755);
    expect(checkRuntime(bin)).toEqual(["bash (5 or newer)"]);
  });

  test("treats a bash that cannot be asked as too old", () => {
    const bin = binWithout("bash");
    const broken = join(bin, "bash");
    writeFileSync(broken, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    chmodSync(broken, 0o755);
    expect(checkRuntime(bin)).toEqual(["bash (5 or newer)"]);
  });
});

describe("the engine's copy of the check", () => {
  const pipeline = fileURLToPath(new URL("msg-echo.yaml", fixtures));

  test("refuses a run and names the binaries", async () => {
    const engine = new Engine({ store: new FsRunStore(newRoot()), path: binWithout("jq") });
    const error = await refused(() => engine.start(pipeline));
    expect(error.code).toBe("runtime_missing");
    expect(error.message).toBe("missing on PATH: jq");
  });

  test("is asked once per process, so a runtime that appears later needs a restart", async () => {
    const bin = binWithout("jq");
    const engine = new Engine({ store: new FsRunStore(newRoot()), path: bin });
    expect((await refused(() => engine.start(pipeline))).code).toBe("runtime_missing");

    symlinkSync(Bun.which("jq")!, join(bin, "jq"));
    expect(checkRuntime(bin)).toEqual([]);
    expect((await refused(() => engine.start(pipeline))).code).toBe("runtime_missing");
    // Pinned on purpose. The answer a process got at startup is the answer it keeps, so the fix for a
    // degraded container is a new container: repairing a running one would leave the probe and the
    // engine disagreeing about what is installed.
  });
});
