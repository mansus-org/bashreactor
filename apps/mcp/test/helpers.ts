// A real Bashreactor and a real MCP server, both on real sockets, and a real MCP client between
// them. Nothing in this suite calls a tool function directly: every call is a POST to `/mcp`, which
// is a POST to the API, which is an engine and a store on a throwaway directory. That is the only
// arrangement that would catch this server reaching past the API.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApi, resolveConfig as resolveApiConfig } from "@bashreactor/api";
import type { TokenScope } from "@bashreactor/api";
import { createMcpServer } from "../src/index.ts";
import { resolveConfig } from "../src/config.ts";
import type { ErrorObject } from "../src/errors.ts";

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
  // Not on the spec's list, but it ships with coreutils, which is, and a test block uses it to still
  // be running when a cancel arrives.
  "sleep",
];

export interface ToolResult {
  text: string;
  json: any;
  isError: boolean;
}

export interface Session {
  client: Client;
  /** A tool call, with its text already joined and its JSON parsed when it is JSON. */
  call(tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** The error object a failing call carried, or null when the call succeeded. */
  error(tool: string, args?: Record<string, unknown>): Promise<ErrorObject | null>;
  close(): Promise<void>;
}

export interface TestEnv {
  apiUrl: string;
  mcpUrl: string;
  admin: string;
  /** A token that may read and nothing more. */
  reader: string;
  /** A token that may write. */
  writer: string;
  session(token?: string | null): Promise<Session>;
  /** A raw request to the MCP endpoint, for the things that are not tool calls. */
  raw(
    method: string,
    options?: { token?: string | null; body?: unknown; headers?: Record<string, string> },
  ): Promise<Response>;
  /** A call straight to the API, for setting a test up without going through a tool. */
  api(method: string, path: string, options?: { token?: string; body?: unknown }): Promise<Response>;
  agentToken(scope: TokenScope, name?: string): Promise<string>;
  /** Polls a run until it leaves `running`, the way a client follows one. */
  waitForRun(id: string, timeoutMs?: number): Promise<Record<string, any>>;
  cleanup(): void;
}

export async function startEnv(options: { mcpToken?: string | null; settleMs?: number } = {}): Promise<TestEnv> {
  const root = mkdtempSync(join(tmpdir(), "bashreactor-mcp-"));

  const api = createApi({
    config: resolveApiConfig(
      {
        BASHREACTOR_HOME: root,
        PORT: "0",
        PATH: fakeRuntimeDir(root),
        BASHREACTOR_ADMIN_TOKEN: ADMIN_TOKEN,
      },
      "test-version",
      { settleMs: options.settleMs ?? 10_000 },
    ),
    log: () => {},
  });
  const apiServer = Bun.serve({ port: 0, fetch: (request) => api.fetch(request) });

  const mcp = createMcpServer(
    resolveConfig(
      {
        BASHREACTOR_URL: `http://127.0.0.1:${apiServer.port}`,
        BASHREACTOR_MCP_PORT: "0",
        ...(options.mcpToken === null ? {} : { BASHREACTOR_TOKEN: options.mcpToken ?? ADMIN_TOKEN }),
      },
      "test-version",
    ),
    { log: () => {} },
  );
  const mcpServer = Bun.serve({ port: 0, fetch: (request) => mcp.fetch(request) });

  const mcpUrl = `http://127.0.0.1:${mcpServer.port}/mcp`;
  const apiUrl = `http://127.0.0.1:${apiServer.port}`;

  const env: TestEnv = {
    apiUrl,
    mcpUrl,
    admin: ADMIN_TOKEN,
    reader: "",
    writer: "",
    async session(token = ADMIN_TOKEN) {
      return await connect(mcpUrl, token);
    },
    async raw(method, rawOptions = {}) {
      const headers: Record<string, string> = { ...rawOptions.headers };
      const token = rawOptions.token === undefined ? ADMIN_TOKEN : rawOptions.token;
      if (token !== null) headers.authorization = `Bearer ${token}`;
      const body = rawOptions.body === undefined ? undefined : JSON.stringify(rawOptions.body);
      if (body !== undefined) headers["content-type"] = "application/json";
      return await fetch(mcpUrl, { method, headers, body });
    },
    async api(method, path, apiOptions = {}) {
      const headers: Record<string, string> = { authorization: `Bearer ${apiOptions.token ?? ADMIN_TOKEN}` };
      const body = apiOptions.body === undefined ? undefined : JSON.stringify(apiOptions.body);
      if (body !== undefined) headers["content-type"] = "application/json";
      return await fetch(`${apiUrl}${path}`, { method, headers, body });
    },
    async agentToken(scope, name = `${scope}-agent`) {
      const response = await env.api("POST", "/v1/tokens", { body: { name, scope } });
      return ((await response.json()) as { token: string }).token;
    },
    async waitForRun(id, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const response = await env.api("GET", `/v1/runs/${id}`);
        const record = (await response.json()) as Record<string, any>;
        if (record.status !== "running" || Date.now() > deadline) return record;
        await Bun.sleep(50);
      }
    },
    cleanup: () => {
      apiServer.stop();
      mcpServer.stop();
      api.close();
      rmSync(root, { recursive: true, force: true });
    },
  };

  env.reader = await env.agentToken("read", "reader");
  env.writer = await env.agentToken("write", "writer");
  return env;
}

/** Connect an MCP client over HTTP, carrying a token on every request it makes. */
export async function connect(url: string, token: string | null): Promise<Session> {
  const client = new Client({ name: "bashreactor-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      if (token !== null) headers.set("authorization", `Bearer ${token}`);
      return globalThis.fetch(input, { ...init, headers });
    },
  });
  await client.connect(transport);

  const session: Session = {
    client,
    async call(tool, args) {
      const result = (await client.callTool({ name: tool, arguments: args ?? {} })) as {
        content?: { type: string; text?: string }[];
        isError?: boolean;
      };
      const text = (result.content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { text, json, isError: result.isError === true };
    },
    async error(tool, args) {
      const result = await session.call(tool, args);
      return result.isError ? (result.json as ErrorObject) : null;
    },
    close: () => client.close(),
  };
  return session;
}

/**
 * A PATH with every binary SPEC 2.6 demands, so a test does not depend on what happens to be
 * installed: the real one where it exists, and a stub for the ones a test block never calls. The
 * API's own suite keeps the same list; a test helper cannot import another package's test helper,
 * so the two are kept short and identical.
 */
function fakeRuntimeDir(root: string): string {
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
export function blockFile(name: string, header: string, script: string): string {
  const commented = header
    .split("\n")
    .map((line) => (line === "" ? "#" : `# ${line}`))
    .join("\n");
  return `#!/usr/bin/env bash\n# ---\n${commented}\n# ---\n\n${script}\n`;
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

export const SLEEP_BLOCK = blockFile(
  "sleeper",
  `name: sleeper
description: Print a line, then sleep until it is cancelled.
inputs:
  seconds:
    type: integer
    default: 30`,
  `echo starting to sleep
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

export function helloPipeline(name = "hello-pipeline"): string {
  return `name: ${name}\nsteps:\n  greet:\n    uses: hello@1\n`;
}

/** A pipeline of one step that prints and then sleeps, for the asynchronous paths. */
export function sleepPipeline(name = "sleep-pipeline"): string {
  return `name: ${name}\nsteps:\n  nap:\n    uses: sleeper@1\n`;
}

export function failingPipeline(name = "fail-pipeline"): string {
  return `name: ${name}\nsteps:\n  boom:\n    uses: failing@1\n`;
}

/** Store a block and a pipeline through the API, so a test's setup is one line. */
export async function seed(env: TestEnv): Promise<void> {
  await env.api("POST", "/v1/blocks/hello/versions", { body: { content: HELLO_BLOCK } });
  await env.api("POST", "/v1/blocks/sleeper/versions", { body: { content: SLEEP_BLOCK } });
  await env.api("POST", "/v1/blocks/failing/versions", { body: { content: FAILING_BLOCK } });
  await env.api("POST", "/v1/pipelines/hello-pipeline/versions", { body: { yaml: helloPipeline() } });
  await env.api("POST", "/v1/pipelines/sleep-pipeline/versions", { body: { yaml: sleepPipeline() } });
  await env.api("POST", "/v1/pipelines/fail-pipeline/versions", { body: { yaml: failingPipeline() } });
}
