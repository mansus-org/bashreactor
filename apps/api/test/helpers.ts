// One API over one throwaway data directory, plus the request helper every route test uses. Nothing
// here calls a route handler directly: every call goes through the fetch entry point with a Request,
// the same one Bun.serve hands it.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "../src/app.ts";
import { createApi } from "../src/app.ts";
import { resolveConfig } from "../src/config.ts";
import type { TokenScope } from "../src/tokens.ts";

export const ADMIN_TOKEN = "br_admin_for_tests";

/** SPEC 2.6: an engine refuses to start without all of these on its PATH. */
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

export interface TestApi {
  api: Api;
  root: string;
  /** A call through the HTTP entry point. The admin token is sent unless you pass one. */
  call(
    method: string,
    path: string,
    options?: { token?: string | null; body?: unknown; headers?: Record<string, string> },
  ): Promise<Response>;
  /** Mints an agent token through the API and returns its clear text. */
  agentToken(scope: TokenScope, name?: string): Promise<string>;
  /** Polls a run until it reaches a final status, the way a client follows one. */
  waitForRun(id: string, timeoutMs?: number): Promise<Record<string, any>>;
  cleanup(): void;
}

export function startApi(options: { settleMs?: number; admin?: string | null } = {}): TestApi {
  const root = mkdtempSync(join(tmpdir(), "bashreactor-api-"));
  const config = resolveConfig(
    {
      BASHREACTOR_HOME: root,
      PORT: "0",
      PATH: fakeRuntimeDir(root),
      ...(options.admin === null ? {} : { BASHREACTOR_ADMIN_TOKEN: options.admin ?? ADMIN_TOKEN }),
    },
    "test-version",
    { settleMs: options.settleMs ?? 10_000 },
  );
  const api = createApi({ config, log: () => {} });

  const roots = [root];
  const test: TestApi = {
    api,
    root,
    async call(method, path, callOptions = {}) {
      const headers: Record<string, string> = { ...callOptions.headers };
      const token = callOptions.token === undefined ? ADMIN_TOKEN : callOptions.token;
      if (token !== null) headers.authorization = `Bearer ${token}`;
      let body: string | undefined;
      if (callOptions.body !== undefined) {
        body = typeof callOptions.body === "string" ? callOptions.body : JSON.stringify(callOptions.body);
        if (headers["content-type"] === undefined) headers["content-type"] = "application/json";
      }
      return await api.fetch(new Request(`http://bashreactor.test${path}`, { method, headers, body }));
    },
    async agentToken(scope, name = `${scope}-agent`) {
      const response = await test.call("POST", "/v1/tokens", { body: { name, scope } });
      const created = (await response.json()) as { token: string };
      return created.token;
    },
    async waitForRun(id, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const response = await test.call("GET", `/v1/runs/${id}`);
        const record = (await response.json()) as Record<string, any>;
        if (record.status !== "running" || Date.now() > deadline) return record;
        await Bun.sleep(50);
      }
    },
    cleanup: () => {
      api.close();
      for (const dir of roots) rmSync(dir, { recursive: true, force: true });
    },
  };
  return test;
}

/**
 * A PATH with every binary SPEC 2.6 demands, so a test does not depend on what happens to be
 * installed: the real one where it exists, and a stub for the ones a test block never calls.
 */
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
export function blockFile(
  name: string,
  header: string,
  script: string,
): { name: string; content: string } {
  const commented = header
    .split("\n")
    .map((line) => (line === "" ? "#" : `# ${line}`))
    .join("\n");
  return {
    name,
    content: `#!/usr/bin/env bash\n# ---\n${commented}\n# ---\n\n${script}\n`,
  };
}

export const HELLO_BLOCK = blockFile(
  "hello",
  `name: hello
description: Say hello and report the greeting.
inputs:
  name:
    type: string
    default: world
outputs:
  greeting:
    type: string
  bytes:
    type: integer`,
  `echo "attempt $BR_ATTEMPT of run $BR_RUN_ID"
echo "hello $INPUT_NAME"
printf 'hello %s' "$INPUT_NAME" > "$OUTPUT_GREETING"
wc -c < "$OUTPUT_GREETING" > "$OUTPUT_BYTES"`,
);

export const SLOW_BLOCK = blockFile(
  "slow",
  `name: slow
description: Sleep until it is cancelled.
inputs:
  seconds:
    type: integer
    default: 30`,
  `echo starting
sleep "$INPUT_SECONDS"
echo never gets here`,
);

export const FAILING_BLOCK = blockFile(
  "failing",
  `name: failing
description: Fail with a plain non-zero exit.`,
  `echo about to fail
exit 3`,
);

export function pipelineYaml(name: string, steps: string, extra = ""): string {
  return `name: ${name}\n${extra}steps:\n${steps}\n`;
}

export const HELLO_PIPELINE = pipelineYaml("test-pipeline", "  greet:\n    uses: hello@1\n");
