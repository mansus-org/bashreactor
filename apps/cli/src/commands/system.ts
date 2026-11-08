// The commands that are not about a document: what the server is, who the token makes you, and how
// much room the server has left to write in.

import { ENV_TOKEN, ENV_URL, maskToken } from "../connection.ts";
import type { Source } from "../connection.ts";
import type { CommandSpec } from "../args.ts";
import { sizeText } from "./runs.ts";
import type { Disk, Health, Identity } from "../types.ts";

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
  {
    group: "",
    name: "disk",
    summary: "say how much room the server has left to write in",
    run: async (ctx) => {
      const disk = await ctx.client.json<Disk>("GET", "/v1/disk");
      ctx.printer.emit(disk, (p) => {
        p.fields([
          ["path", disk.path],
          ["free", `${sizeText(disk.free_bytes)} of ${sizeText(disk.total_bytes)}`],
          ["used", `${sizeText(disk.used_bytes)}${share(disk)}`],
          // The filesystem's `used` belongs to a disk that may be far larger than the volume this was
          // given, so the number that can be acted on is what is sitting in `runs/`.
          ["runs/", sizeText(disk.runs_bytes)],
          ["low", disk.low ? "yes" : "no"],
        ]);
      });
      // `low` is the news, and a cron should not have to read prose to get it — the same reason
      // `health` returns 1 for a degraded server.
      return disk.low ? 1 : 0;
    },
  },
];

/** `  (41%)`, or nothing when the filesystem would not say how big it is. */
function share(disk: Disk): string {
  if (disk.total_bytes <= 0) return "";
  return `  (${Math.round((disk.used_bytes / disk.total_bytes) * 100)}%)`;
}

function where(source: Source | null, flag: string, env: string, file: string): string {
  if (source === "flag") return flag;
  if (source === "environment") return env;
  return file;
}
