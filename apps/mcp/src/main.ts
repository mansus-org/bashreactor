// The listener. Its own process and its own port, so the MCP server can be restarted, scaled or
// taken down without touching the API it fronts — and so it cannot reach the data directory even by
// accident: it has no path to it, only a URL and a token.

import manifest from "../package.json";
import { resolveConfig, resolveVersion } from "./config.ts";
import { createMcpServer } from "./http.ts";

// A variable the environment did not give and that has no default is fatal, with the name in the
// message: there is nothing to degrade into when there is no API to front.
const config = resolveConfig(process.env, resolveVersion(process.env, manifest.version));

const mcp = createMcpServer(config);
const server = Bun.serve({ port: config.port, fetch: mcp.fetch });

console.log(`bashreactor mcp listening on :${server.port}${config.path}, fronting ${config.apiUrl}`);
if (config.token === null) {
  console.log("bashreactor mcp: no BASHREACTOR_TOKEN, so every caller must bring its own token");
}

process.on("SIGTERM", () => {
  void server.stop().then(() => {
    process.exit(0);
  });
});
