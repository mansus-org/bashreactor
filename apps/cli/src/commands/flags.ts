// Flags that more than one command carries, kept in one place so `--version` cannot mean one thing
// to `blocks get` and another to `runs start`.

import type { FlagSpec } from "../args.ts";

/** SPEC 3.4: a library reference names a version; `latest` is the newest one stored. */
export const VERSION_FLAG: FlagSpec = {
  name: "version",
  help: "which version of the name, or `latest`",
  value: "string",
};

export const INTERVAL_FLAG: FlagSpec = {
  name: "interval",
  help: "how long to wait between polls, in milliseconds",
  value: "int",
  min: 50,
};

/** The version segment of a path: `latest` unless the user named a number. */
export function versionOf(ctx: { flag(name: string): string | undefined }): string {
  return ctx.flag("version") ?? "latest";
}
