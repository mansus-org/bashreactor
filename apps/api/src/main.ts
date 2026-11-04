import manifest from "../package.json";
import { createHandler, resolvePort, resolveVersion } from "./index.ts";

const server = Bun.serve({
  port: resolvePort(process.env),
  fetch: createHandler({ version: resolveVersion(process.env, manifest.version) }),
});

console.log(`bashreactor listening on :${server.port}`);

// A container's PID 1 gets no default signal handling, so without this every rollout would wait out the
// pod's whole termination grace period before being killed.
process.on("SIGTERM", () => {
  void server.stop().then(() => process.exit(0));
});
