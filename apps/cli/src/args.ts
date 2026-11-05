// The command line, parsed in one place so every command gets the same errors for the same mistake.
// Flags may appear before or after the command name; a value may be `--flag value` or `--flag=value`.

import type { ApiClient } from "./client.ts";
import type { Connection } from "./connection.ts";
import { usage } from "./errors.ts";
import type { Printer } from "./output.ts";
import type { Io } from "./output.ts";

export interface FlagSpec {
  name: string;
  help: string;
  /** Omit it for a boolean. `int` is checked as an integer of `min` or more. */
  value?: "string" | "int";
  min?: number;
  /** May be given more than once; `many()` returns them in order. */
  repeat?: boolean;
  choices?: readonly string[];
}

export interface ArgSpec {
  /** What to call it in the usage line, e.g. `<name>`. */
  name: string;
  optional?: boolean;
}

export interface Ctx {
  client: ApiClient;
  printer: Printer;
  io: Io;
  conn: Connection;
  /** Positional arguments, after the command name. */
  args: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  flag(name: string): string | undefined;
  has(name: string): boolean;
  many(name: string): string[];
  int(name: string, fallback: number): number;
}

export interface CommandSpec {
  /** `""` for a command that sits on its own, such as `whoami`. */
  group: string;
  name: string;
  summary: string;
  args?: ArgSpec[];
  flags?: FlagSpec[];
  /** Set for the one route that needs no token. */
  anonymous?: boolean;
  run: (ctx: Ctx) => number | Promise<number>;
}

export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "json", help: "print the API's own JSON, for jq and other machines" },
  { name: "url", help: `API URL (over ${"BASHREACTOR_URL"})`, value: "string" },
  { name: "token", help: "bearer token (over BASHREACTOR_TOKEN; prefer the environment)", value: "string" },
  { name: "help", help: "show this" },
];

export interface Parsed {
  spec: CommandSpec;
  args: string[];
  flags: Map<string, string | string[]>;
  json: boolean;
  url?: string;
  token?: string;
  help: boolean;
}

/** Every flag name the CLI knows, so a flag can be read before the command it belongs to is. */
function flagTable(table: readonly CommandSpec[]): Map<string, FlagSpec> {
  const flags = new Map<string, FlagSpec>();
  for (const spec of [...GLOBAL_FLAGS, ...table.flatMap((command) => command.flags ?? [])]) {
    if (!flags.has(spec.name)) flags.set(spec.name, spec);
  }
  return flags;
}

export function parseArgs(argv: readonly string[], table: readonly CommandSpec[]): Parsed {
  const known = flagTable(table);
  const flags = new Map<string, string | string[]>();
  const positional: string[] = [];
  let onlyPositional = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (onlyPositional) {
      positional.push(token);
      continue;
    }
    if (token === "--") {
      onlyPositional = true;
      continue;
    }
    if (token === "-h") {
      flags.set("help", "true");
      continue;
    }
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    const spec = known.get(name);
    if (spec === undefined) throw usage(`"--${name}" is not a flag (run \`bashreactor --help\`)`);
    if (spec.value === undefined) {
      if (inline !== undefined) throw usage(`"--${name}" takes no value`);
      set(flags, spec, "true");
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && known.has(next.slice(2)))) {
        throw usage(`"--${name}" needs a value`);
      }
      value = next;
      i += 1;
    }
    if (spec.value === "int") {
      if (!/^-?[0-9]+$/.test(value)) throw usage(`"--${name}" wants a whole number, got "${value}"`);
      const parsed = Number(value);
      if (spec.min !== undefined && parsed < spec.min) {
        throw usage(`"--${name}" wants ${spec.min} or more, got ${parsed}`);
      }
    }
    set(flags, spec, value);
  }

  const json = flags.has("json");
  const help = flags.has("help");
  // Neither of these is repeatable, so a value is always one string.
  const url = flags.get("url") as string | undefined;
  const token = flags.get("token") as string | undefined;

  const head = positional[0];
  if (head === undefined) {
    if (help) return { spec: HELP_COMMAND, args: [], flags, json, url, token, help };
    throw usage("no command given (run `bashreactor --help` for the list)");
  }

  const group = table.filter((spec) => spec.group === head);
  const spec =
    group.length > 0
      ? group.find((candidate) => candidate.name === positional[1])
      : table.find((candidate) => candidate.group === "" && candidate.name === head);
  const rest = group.length > 0 ? positional.slice(2) : positional.slice(1);

  if (group.length > 0 && positional[1] === undefined) {
    if (help) return { spec: HELP_COMMAND, args: [head], flags, json, url, token, help };
    throw usage(
      `"${head}" needs a command: ${group.map((candidate) => `${head} ${candidate.name}`).join(", ")}`,
    );
  }
  if (spec === undefined) {
    const named = group.length > 0 ? `${head} ${positional[1]}` : head;
    throw usage(`"${named}" is not a command (run \`bashreactor --help\` for the list)`);
  }

  if (help) {
    const topic = [spec.group, spec.name].filter((part) => part !== "");
    return { spec: HELP_COMMAND, args: topic, flags, json, url, token, help };
  }

  const declared = spec.args ?? [];
  const required = declared.filter((arg) => !arg.optional).length;
  if (rest.length < required || rest.length > declared.length) {
    const shape = declared.map((arg) => (arg.optional ? `[${arg.name}]` : arg.name)).join(" ");
    throw usage(`usage: bashreactor ${commandName(spec)}${shape === "" ? "" : ` ${shape}`}`);
  }

  for (const name of flags.keys()) {
    const isGlobal = GLOBAL_FLAGS.some((flag) => flag.name === name);
    const isLocal = (spec.flags ?? []).some((flag) => flag.name === name);
    if (!isGlobal && !isLocal) {
      throw usage(`"--${name}" is not a flag of \`bashreactor ${commandName(spec)}\``);
    }
  }
  for (const [name, value] of flags) {
    const spec2 = known.get(name)!;
    if (spec2.choices === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const one of values) {
      if (!spec2.choices.includes(one)) {
        throw usage(`"--${name}" must be one of ${spec2.choices.join(", ")}, got "${one}"`);
      }
    }
  }

  return { spec, args: rest, flags, json, url, token, help };
}

function set(flags: Map<string, string | string[]>, spec: FlagSpec, value: string): void {
  if (!spec.repeat) {
    flags.set(spec.name, value);
    return;
  }
  const existing = flags.get(spec.name);
  if (Array.isArray(existing)) existing.push(value);
  else if (existing === undefined) flags.set(spec.name, [value]);
  else flags.set(spec.name, [existing, value]);
}

export function commandName(spec: CommandSpec): string {
  return spec.group === "" ? spec.name : `${spec.group} ${spec.name}`;
}

/** A command that is not a command: it prints help and exits 0. Exported so the entry point can
 * recognise it without a second table. */
export const HELP_COMMAND: CommandSpec = {
  group: "",
  name: "help",
  summary: "",
  args: [{ name: "[command]", optional: true }],
  run: () => 0,
};

export function usageText(table: readonly CommandSpec[], topic?: string[]): string {
  if (topic !== undefined && topic.length > 0) {
    const matches = table.filter(
      (spec) =>
        (topic.length === 1 && (spec.group === topic[0] || commandName(spec) === topic[0])) ||
        (topic.length >= 2 && commandName(spec) === `${topic[0]} ${topic[1]}`),
    );
    if (matches.length === 1) return commandHelp(matches[0]!);
    if (matches.length > 1) return groupHelp(topic[0]!, matches);
  }
  const groups = new Map<string, CommandSpec[]>();
  for (const spec of table) {
    const key = spec.group === "" ? "" : spec.group;
    const list = groups.get(key) ?? [];
    list.push(spec);
    groups.set(key, list);
  }
  const lines = [
    "bashreactor — blocks, pipelines and runs, from a shell or a script",
    "",
    "usage: bashreactor <command> [flags]",
    "",
  ];
  for (const [group, specs] of groups) {
    if (group !== "") lines.push(`${group}:`);
    for (const spec of specs) {
      lines.push(`  ${commandName(spec).padEnd(20)}${spec.summary}`);
    }
    lines.push("");
  }
  lines.push("flags, on every command:");
  for (const flag of GLOBAL_FLAGS) lines.push(`  --${flag.name.padEnd(19)}${flag.help}`);
  lines.push("", "Exit codes: 0 ran, 1 the API refused, 2 the command line was wrong.");
  lines.push("`--json` prints the API's own JSON and nothing else; a failure is the SPEC error object.");
  return lines.join("\n");
}

function groupHelp(name: string, specs: readonly CommandSpec[]): string {
  const lines = [`usage: bashreactor ${name} <${specs.map((spec) => spec.name).join("|")}> [flags]`, ""];
  for (const spec of specs) lines.push(commandHelp(spec));
  return lines.join("\n").trimEnd();
}

function commandHelp(spec: CommandSpec): string {
  const declared = (spec.args ?? []).map((arg) => (arg.optional ? `[${arg.name}]` : arg.name));
  const lines = [
    `usage: bashreactor ${commandName(spec)}${declared.length ? ` ${declared.join(" ")}` : ""}`,
    "",
    `  ${spec.summary}`,
    "",
  ];
  const flags = [...(spec.flags ?? []), ...GLOBAL_FLAGS];
  if (flags.length > 0) {
    lines.push("flags:");
    for (const flag of flags) {
      const value = flag.value === undefined ? "" : flag.value === "int" ? " <n>" : " <value>";
      const choices = flag.choices === undefined ? "" : ` [${flag.choices.join("|")}]`;
      lines.push(`  --${flag.name}${value}`.padEnd(28) + flag.help + choices);
    }
  }
  return lines.join("\n");
}
