// One MCP server per request, built for the caller who sent it — the stateless shape, where nothing
// survives a request and a pod restart loses nothing. The caller's identity is fixed at build time,
// which is how a tool knows whose token it is spending without any session of our own.
//
// The low-level `Server` rather than the high-level `McpServer` on purpose: the high level one takes
// zod shapes for arguments and answers a bad one with its own sentence, and this server owes the
// caller the spec's error object instead. Arguments are described in args.ts and checked here.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ApiClient, Identity } from "./api.ts";
import type { McpConfig } from "./config.ts";
import { checkArgs } from "./args.ts";
import { errorBodyOf, errorText, type ErrorObject } from "./errors.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import { findTool, refusalFor, TOOLS, toolListing } from "./tools.ts";

export function buildMcpServer(
  config: McpConfig,
  identity: Identity,
  client: ApiClient,
  /** Told which tool ran and whether it failed, so the caller can log it. */
  called?: (name: string, isError: boolean) => void,
): Server {
  const server = new Server(
    { name: "bashreactor", version: config.version },
    { instructions: INSTRUCTIONS, capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(toolListing),
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request.params.name;
    const tool = findTool(name);
    if (tool === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `there is no tool "${name}"`);
    }

    // The scope check is the tool's own, so a read token sees the tool and is told what it lacks
    // rather than finding it quietly missing from tools/list.
    const refusal = refusalFor(tool, identity);
    if (refusal !== null) {
      called?.(name, true);
      return toolError(refusal);
    }

    let args;
    try {
      args = checkArgs(name, request.params.arguments, tool.args);
    } catch (error) {
      called?.(name, true);
      return toolError(errorBodyOf(error));
    }

    try {
      const result = { content: [{ type: "text" as const, text: render(await tool.run(client, args)) }] };
      called?.(name, false);
      return result;
    } catch (error) {
      called?.(name, true);
      return toolError(errorBodyOf(error));
    }
  });

  return server;
}

/** A tool result that says it failed, carrying the error object as its text. */
function toolError(body: ErrorObject) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: errorText(body) }],
  };
}

/** What a successful tool leaves in the text: the API's own JSON, unchanged. */
function render(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
