// A real API over a real socket, and the CLI run as a real subprocess against it. Nothing here
// reaches into the API's functions: the server is started the way apps/api/test/server.test.ts
// starts it, because the CLI's contract is HTTP and the CLI package must not import the API.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ADMIN_TOKEN = "br_cli_test_admin";
export const BIN = join(import.meta.dir, "../src/bin.ts");
const MAIN = join(import.meta.dir, "../../api/src/main.ts");

/** SPEC 2.6: an engine refuses to start without every one of these on its PATH. */
const REQUIRED_BINARIES = [
  "bash",
  "uv",
  "bun",
  "awk",
  "curl",
  "grep",
  "gzip",
  "jq",
  "sed",
  "tar",
  "cat",
  "mv",
  "wc",
];

// Not part of SPEC 2.6, but the test blocks use it to be slow, and a stub that returns at once
// would make a "slow" step finish before anything could follow it.
const OPTIONAL_BINARIES = ["sleep"];

export interface Server {
  url: string;
  /** The data directory, so a test can look at what landed on disk. */
  home: string;
  stop(): Promise<void>;
}

export async function startServer(): Promise<Server> {
  const home = mkdtempSync(join(tmpdir(), "bashreactor-cli-"));
  const proc = Bun.spawn([process.execPath, MAIN], {
    env: {
      PATH: fakeRuntimeDir(home),
      HOME: home,
      PORT: "0",
      BASHREACTOR_HOME: home,
      BASHREACTOR_ADMIN_TOKEN: ADMIN_TOKEN,
      BASHREACTOR_VERSION: "cli-test",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  let port: string | undefined;
  while (port === undefined) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
    port = /listening on :(\d+)/.exec(seen)?.[1];
  }
  if (port === undefined) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`the API did not say its port: ${seen} ${err}`);
  }
  reader.releaseLock();

  return {
    url: `http://127.0.0.1:${port}`,
    home,
    stop: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export interface Result {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * One run of the real binary. The environment is built from nothing: a stray `~/.bashreactor/cli.json`
 * or `BASHREACTOR_URL` in the developer's shell must not decide what a test sees.
 */
export async function cli(
  args: readonly string[],
  options: { url?: string | null; token?: string | null; env?: Record<string, string> } = {},
): Promise<Result> {
  const home = mkdtempSync(join(tmpdir(), "bashreactor-cli-home-"));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    BASHREACTOR_HOME: home,
    ...options.env,
  };
  if (options.url !== null) env.BASHREACTOR_URL = options.url ?? "";
  if (options.token !== null) env.BASHREACTOR_TOKEN = options.token ?? ADMIN_TOKEN;

  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  rmSync(home, { recursive: true, force: true });
  return { stdout, stderr, code };
}

/** The one JSON value a command printed, whatever it was. */
export function parsed(result: Result): any {
  return JSON.parse(result.stdout.trim());
}

/** Every line of a stream, without the trailing newline. */
export function lines(text: string): string[] {
  return text.replace(/\n$/, "").split("\n");
}

/** A PATH with every binary SPEC 2.6 demands, so a test does not depend on what is installed. */
export function fakeRuntimeDir(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of REQUIRED_BINARIES) {
    const target = join(bin, name);
    if (existsSync(target)) continue;
    const real = findOnPath(name);
    if (real !== null) {
      symlinkSync(real, target);
      continue;
    }
    if (name === "bash") throw new Error("this suite needs bash on PATH");
    writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(target, 0o755);
  }
  for (const name of OPTIONAL_BINARIES) {
    const real = findOnPath(name);
    if (real !== null && !existsSync(join(bin, name))) symlinkSync(real, join(bin, name));
  }
  return bin;
}

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const candidate = join(dir, name);
    if (dir !== "" && existsSync(candidate)) return candidate;
  }
  return null;
}

/** A block file, so a test says what its block does instead of repeating the header boilerplate. */
export function blockFile(header: string, script: string): string {
  const commented = header
    .split("\n")
    .map((line) => (line === "" ? "#" : `# ${line}`))
    .join("\n");
  return `#!/usr/bin/env bash\n# ---\n${commented}\n# ---\n\n${script}\n`;
}

export const HELLO_BLOCK = blockFile(
  `name: hello
description: Say hello.
inputs:
  name:
    type: string
    default: world
outputs:
  greeting:
    type: string`,
  `echo "hello $INPUT_NAME"
printf 'hello %s' "$INPUT_NAME" > "$OUTPUT_GREETING"`,
);

export const SLOW_BLOCK = blockFile(
  `name: slow
description: Print one line and take a while.
inputs:
  seconds:
    type: integer
    default: 5`,
  `echo starting
sleep "$INPUT_SECONDS"
echo finished`,
);

/** A one-step pipeline of `hello`, with the pipeline inputs a test may want to pass. */
export function helloPipeline(name: string, extra = ""): string {
  return `name: ${name}
inputs:
  name:
    type: string
    default: world
${extra}steps:
  greet:
    uses: hello@1
    with:
      name: \${{ inputs.name }}
`;
}
