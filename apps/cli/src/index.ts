// The entry point: pick the command, pick the output mode, then get out of the way. Everything a
// command can fail with is caught here, because this is the one place allowed to decide what a
// failure prints and what the process exits with.

import { HELP_COMMAND, parseArgs, usageText } from "./args.ts";
import type { CommandSpec, Ctx } from "./args.ts";
import { ApiClient } from "./client.ts";
import { requireToken, resolveConnection } from "./connection.ts";
import { unexpected } from "./errors.ts";
import { Printer, stdoutIo } from "./output.ts";
import type { Io } from "./output.ts";
import { blockCommands } from "./commands/blocks.ts";
import { pipelineCommands } from "./commands/pipelines.ts";
import { runCommands } from "./commands/runs.ts";
import { systemCommands } from "./commands/system.ts";
import { tokenCommands } from "./commands/tokens.ts";

/** The whole command tree, in the order the help prints it. */
export const COMMANDS: CommandSpec[] = [
  ...systemCommands,
  ...blockCommands,
  ...pipelineCommands,
  ...runCommands,
  ...tokenCommands,
];

export interface CliOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export async function runCli(argv: readonly string[], io: Io = stdoutIo(), options: CliOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  try {
    return await dispatch(argv, io, env, cwd);
  } catch (error) {
    const failure = unexpected(error);
    // The mode is chosen once, at the top, and a failure honours it: under `--json` the error object
    // is the whole of stdout, so a script can read the failure and the success the same way.
    new Printer(io, argv.includes("--json")).error(failure.toBody());
    return failure.exit;
  }
}

async function dispatch(
  argv: readonly string[],
  io: Io,
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<number> {
  const parsed = parseArgs(argv, COMMANDS);
  if (parsed.spec === HELP_COMMAND) {
    io.out(usageText(COMMANDS, parsed.args));
    return 0;
  }

  const conn = resolveConnection(env, { url: parsed.url, token: parsed.token });
  if (!parsed.spec.anonymous) requireToken(conn);

  const ctx: Ctx = {
    client: new ApiClient(conn),
    printer: new Printer(io, parsed.json),
    io,
    conn,
    args: parsed.args,
    env,
    cwd,
    flag: (name) => {
      const value = parsed.flags.get(name);
      return typeof value === "string" ? value : undefined;
    },
    has: (name) => parsed.flags.has(name),
    many: (name) => {
      const value = parsed.flags.get(name);
      if (value === undefined) return [];
      return Array.isArray(value) ? value : [value];
    },
    int: (name, fallback) => {
      const value = parsed.flags.get(name);
      return value === undefined ? fallback : Number(value);
    },
  };

  return await parsed.spec.run(ctx);
}
