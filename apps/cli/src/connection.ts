// Where the URL and the token come from: a flag beats the environment beats a file in the data
// directory, and `whoami` says which of the three won. The CLI never opens the store or the engine,
// so this is the whole of its configuration.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { usage } from "./errors.ts";

export const ENV_URL = "BASHREACTOR_URL";
export const ENV_TOKEN = "BASHREACTOR_TOKEN";
export const ENV_HOME = "BASHREACTOR_HOME";

/** Which of the three places a value was taken from, worded the way `whoami` prints it. */
export type Source = "flag" | "environment" | "config file";

export interface Connection {
  url: string;
  urlSource: Source;
  /** Null means nothing was configured anywhere; a route that needs one then says so. */
  token: string | null;
  tokenSource: Source | null;
  /** Where a `url`/`token` pair may be kept, whether or not one is there. */
  configFile: string;
}

interface FileConfig {
  url?: string;
  token?: string;
}

export function resolveConnection(
  env: Record<string, string | undefined>,
  flags: { url?: string; token?: string },
): Connection {
  const configFile = configPath(env);
  const file = readFileConfig(configFile);

  const url = pick(flags.url, env[ENV_URL], file.url);
  if (url === undefined) {
    throw usage(
      `no API URL: pass --url, set ${ENV_URL}, or put "url" in ${configFile} ` +
        "(run `bashreactor --help` for the commands)",
    );
  }

  const token = pick(flags.token, env[ENV_TOKEN], file.token);
  return {
    url: normalizeUrl(url.value, flags.url !== undefined),
    urlSource: url.source,
    token: token === undefined ? null : normalizeToken(token.value),
    tokenSource: token === undefined ? null : token.source,
    configFile,
  };
}

/** The token a command needs before it will call a route that has one. */
export function requireToken(conn: Connection): string {
  if (conn.token === null) {
    throw usage(
      `no token: pass --token, set ${ENV_TOKEN}, or put "token" in ${conn.configFile} ` +
        "(the admin token, or an agent token from `bashreactor tokens add`)",
    );
  }
  return conn.token;
}

/** Enough of a token to recognise it without putting the whole thing in a terminal's scrollback. */
export function maskToken(token: string): string {
  if (token.length <= 10) return "****";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function pick(
  flag: string | undefined,
  environment: string | undefined,
  file: string | undefined,
): { value: string; source: Source } | undefined {
  if (flag !== undefined && flag !== "") return { value: flag, source: "flag" };
  if (environment !== undefined && environment !== "") return { value: environment, source: "environment" };
  if (file !== undefined && file !== "") return { value: file, source: "config file" };
  return undefined;
}

/**
 * The same data directory the engine and the API use (SPEC 1.4), so one `BASHREACTOR_HOME` points
 * everything at one place. Duplicated rather than imported: the CLI talks to a deployment over
 * HTTP and must not need the API package on its import graph to find its own config.
 */
function configPath(env: Record<string, string | undefined>): string {
  if (env[ENV_HOME]) return join(env[ENV_HOME], "cli.json");
  if (env.HOME) return join(env.HOME, ".bashreactor", "cli.json");
  return join(process.cwd(), ".bashreactor", "cli.json");
}

function readFileConfig(path: string): FileConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {}; // no file yet is the normal case, not a complaint
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw usage(`${path}: not valid JSON (${(error as Error).message})`, { file: path });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usage(`${path}: expected a JSON object with "url" and/or "token"`, { file: path });
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "url" && key !== "token") {
      throw usage(`${path}: "${key}" is not a setting (the only ones are "url" and "token")`, {
        path: key,
        file: path,
      });
    }
  }
  for (const key of ["url", "token"] as const) {
    const value = record[key];
    if (value !== undefined && typeof value !== "string") {
      throw usage(`${path}: "${key}" must be a string`, { path: key, file: path });
    }
  }
  // A file that is world-readable and holds a token is the user's own doing, but say nothing here:
  // the mode check belongs to whoever wrote the file, and a warning on every command is noise.
  return { url: record.url as string | undefined, token: record.token as string | undefined };
}

function normalizeUrl(value: string, fromFlag: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw usage(`"${value}" is not a URL${fromFlag ? " (--url)" : ""}`, { code: "invalid_argument" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw usage(`the API URL must be http or https, got "${url.protocol}"`);
  }
  return value.replace(/\/+$/, "");
}

function normalizeToken(value: string): string {
  const trimmed = value.trim();
  // A token copied out of an Authorization header keeps its scheme; taking it out here turns a
  // silent 401 into a working command.
  return trimmed.startsWith("Bearer ") ? trimmed.slice("Bearer ".length).trim() : trimmed;
}

/** True when the path is a file that can be read, so a bad argument fails before a request does. */
export function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
