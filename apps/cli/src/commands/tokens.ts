// Agent tokens, admin only. The secret exists in exactly one response, so `tokens add` prints it
// plainly and says that it will never print it again.

import type { CommandSpec } from "../args.ts";
import { usage } from "../errors.ts";
import { localTime } from "../output.ts";
import type { TokenInfo } from "../types.ts";

export const tokenCommands: CommandSpec[] = [
  {
    group: "tokens",
    name: "ls",
    summary: "the agent tokens, without their secrets (admin)",
    run: async (ctx) => {
      const tokens = await ctx.client.json<TokenInfo[]>("GET", "/v1/tokens");
      ctx.printer.emit(tokens, (p) => {
        if (tokens.length === 0) {
          p.line("no agent tokens");
          return;
        }
        p.table(
          ["ID", "NAME", "SCOPE", "CREATED", "LAST USED"],
          tokens.map((token) => [
            token.id,
            token.name,
            token.scope,
            localTime(token.created_at),
            localTime(token.last_used),
          ]),
        );
      });
      return 0;
    },
  },
  {
    group: "tokens",
    name: "add",
    summary: "create an agent token and print it, once (admin)",
    args: [{ name: "<name>" }],
    flags: [{ name: "scope", help: "what the token may do", value: "string", choices: ["read", "write"] }],
    run: async (ctx) => {
      const scope = ctx.flag("scope");
      if (scope === undefined) {
        throw usage("--scope is needed: read or write", { path: "scope" });
      }
      const created = await ctx.client.json<TokenInfo & { token: string }>("POST", "/v1/tokens", {
        body: { name: ctx.args[0]!, scope },
      });
      ctx.printer.emit(created, (p) => {
        p.fields([
          ["id", created.id],
          ["name", created.name],
          ["scope", created.scope],
          ["token", created.token],
        ]);
        p.note("this token is shown once and stored only as a hash; put it somewhere safe now");
      });
      return 0;
    },
  },
  {
    group: "tokens",
    name: "revoke",
    summary: "revoke a token, effective on its next request (admin)",
    args: [{ name: "<id>" }],
    run: async (ctx) => {
      const id = ctx.args[0]!;
      const answer = await ctx.client.json<{ deleted: string }>("DELETE", `/v1/tokens/${encodeURIComponent(id)}`);
      ctx.printer.emit(answer, (p) => p.line(`revoked ${answer.deleted}`));
      return 0;
    },
  },
];
