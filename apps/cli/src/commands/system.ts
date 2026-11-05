// The two commands that are not about a document: what the server is, and who the token makes you.

import { ENV_TOKEN, ENV_URL, maskToken } from "../connection.ts";
import type { Source } from "../connection.ts";
import type { CommandSpec } from "../args.ts";
import type { Health, Identity } from "../types.ts";

export const systemCommands: CommandSpec[] = [
  {
    group: "",
    name: "health",
    summary: "ask the server whether it is up, without a token",
    anonymous: true,
    run: async (ctx) => {
      const health = await ctx.client.json<Health>("GET", "/healthz", { auth: false });
      ctx.printer.emit(health, (p) => {
        if (health.status === "ok") {
          p.line(`ok        ${health.version}`);
          return;
        }
        p.line(`${health.status}  ${health.version}`);
        if (health.problem !== undefined) p.line(`problem   ${health.problem}`);
      });
      // A degraded server answers 200 on purpose (SPEC 1.5), so the body is the only place the
      // bad news is, and a script should not have to read prose to find it.
      return health.status === "ok" ? 0 : 1;
    },
  },
  {
    group: "",
    name: "whoami",
    summary: "say which URL and token won, and who that token is",
    run: async (ctx) => {
      const identity = await ctx.client.json<Identity>("GET", "/v1/whoami");
      ctx.printer.emit(identity, (p) => {
        p.fields([
          ["url", `${ctx.conn.url}  (from ${where(ctx.conn.urlSource, "--url", ENV_URL, ctx.conn.configFile)})`],
          [
            "token",
            `${maskToken(ctx.conn.token ?? "")}  (from ${where(
              ctx.conn.tokenSource,
              "--token",
              ENV_TOKEN,
              ctx.conn.configFile,
            )})`,
          ],
          ["name", identity.name],
          ["scope", identity.scope],
          ["admin", identity.admin ? "yes" : "no"],
        ]);
      });
      return 0;
    },
  },
];

function where(source: Source | null, flag: string, env: string, file: string): string {
  if (source === "flag") return flag;
  if (source === "environment") return env;
  return file;
}
