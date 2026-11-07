// The block library: `blocks ls|get|content|add`, one per route. The bytes of a block are its
// identity (SPEC 2), so `content` writes them untouched and `add` sends them untouched.

import { readFileSync } from "node:fs";
import type { CommandSpec } from "../args.ts";
import { usage } from "../errors.ts";
import { localTime } from "../output.ts";
import { isReadableFile } from "../connection.ts";
import { blockUploadBody } from "../local.ts";
import { VERSION_FLAG, versionOf } from "./flags.ts";
import type { BlockList, BlockVersion } from "../types.ts";

const SHORT_SHA = 12;

export const blockCommands: CommandSpec[] = [
  {
    group: "blocks",
    name: "ls",
    summary: "every version of one block",
    args: [{ name: "<name>" }],
    run: async (ctx) => {
      const list = await ctx.client.json<BlockList>("GET", `/v1/blocks/${encodeURIComponent(ctx.args[0]!)}`);
      ctx.printer.emit(list, (p) => {
        p.line(`${list.name} — ${list.versions.length} version(s), latest ${list.latest}`);
        p.table(
          ["NAME", "VERSION", "SHA256", "SIZE", "CREATED"],
          list.versions.map((version) => [
            version.name,
            String(version.version),
            version.sha256.slice(0, SHORT_SHA),
            String(version.size),
            localTime(version.created_at),
          ]),
        );
      });
      return 0;
    },
  },
  {
    group: "blocks",
    name: "get",
    summary: "one version's metadata",
    args: [{ name: "<name>" }],
    flags: [VERSION_FLAG],
    run: async (ctx) => {
      const record = await ctx.client.json<BlockVersion>(
        "GET",
        `/v1/blocks/${encodeURIComponent(ctx.args[0]!)}/${versionOf(ctx)}`,
      );
      ctx.printer.emit(record, (p) => {
        p.fields([
          ["name", record.name],
          ["version", String(record.version)],
          ["sha256", record.sha256],
          ["size", `${record.size} bytes`],
          ["created", localTime(record.created_at)],
        ]);
      });
      return 0;
    },
  },
  {
    group: "blocks",
    name: "content",
    summary: "the exact bytes of one version",
    args: [{ name: "<name>" }],
    flags: [VERSION_FLAG],
    run: async (ctx) => {
      const name = ctx.args[0]!;
      const version = versionOf(ctx);
      const response = await ctx.client.bytes("GET", `/v1/blocks/${encodeURIComponent(name)}/${version}/content`);
      const sha256 = response.headers.get("x-block-sha256") ?? "";
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (ctx.printer.json) {
        // `--json` is for machines, and a machine wants to know which version it got, so `latest` is
        // resolved to the number the library answered with.
        const resolved = /^\d+$/.test(version)
          ? { version: Number(version), sha256 }
          : await ctx.client.json<BlockVersion>("GET", `/v1/blocks/${encodeURIComponent(name)}/latest`);
        ctx.printer.emit(
          { name, version: resolved.version, sha256: resolved.sha256, content: new TextDecoder().decode(bytes) },
          () => {},
        );
        return 0;
      }
      ctx.io.bytes(bytes);
      return 0;
    },
  },
  {
    group: "blocks",
    name: "add",
    summary: "add a version of a block from a file",
    args: [{ name: "<name>" }, { name: "<file>" }],
    run: async (ctx) => {
      const name = ctx.args[0]!;
      const path = ctx.args[1]!;
      if (!isReadableFile(path)) {
        throw usage(`"${path}" is not a file`, { code: "file_input_not_found", file: path });
      }
      // The file's bytes, not its text: SPEC 2 makes the SHA-256 of those bytes the version's
      // identity, and reading a block as UTF-8 text would rewrite whatever is not.
      const created = await ctx.client.json<BlockVersion>(
        "POST",
        `/v1/blocks/${encodeURIComponent(name)}/versions`,
        { body: blockUploadBody(readFileSync(path)) },
      );
      ctx.printer.emit(created, (p) => {
        p.line(`added ${created.name}@${created.version}  ${created.size} bytes  ${created.sha256.slice(0, SHORT_SHA)}`);
      });
      return 0;
    },
  },
];
