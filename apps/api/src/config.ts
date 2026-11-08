// Everything the server takes from the environment, resolved once at startup the way `myself serve`
// does it: a port, one data directory, and the admin token (as a hash, so the clear text never has
// to sit in a pod spec).

import { createHash } from "node:crypto";
import { join } from "node:path";
import { BashreactorError, parseDuration } from "@bashreactor/core";

const DEFAULT_PORT = 8080;

// How long a run operation (retry, resume) is given to fail fast or finish before the API answers
// 202 Accepted instead. Long enough for a short run to finish inside the request, short enough that
// a client never waits on a job that takes hours.
const DEFAULT_SETTLE_MS = 250;

export interface ApiConfig {
  port: number;
  /** `$BASHREACTOR_HOME`: the engine's run directory root and the store's parent (SPEC 1.4). */
  dataDir: string;
  storeDir: string;
  tokensPath: string;
  /** Lowercase hex sha256 of the admin token; null means the API is disabled (SPEC: no token, no API). */
  adminHash: string | null;
  /** PATH the engine resolves `bash`, `uv` and `bun` on (SPEC 2.6). */
  enginePath: string;
  version: string;
  settleMs: number;
  /**
   * How long a run that has finished is kept before the server deletes it, in milliseconds; null
   * when the server never removes anything on its own (SPEC 6, `BASHREACTOR_RETENTION`).
   */
  retentionMs: number | null;
}

export function resolvePort(env: Record<string, string | undefined>): number {
  const raw = env.PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new BashreactorError("runtime_missing", `PORT must be an integer from 0 to 65535, got "${raw}"`);
  }
  return port;
}

// The image sets BASHREACTOR_VERSION to the tag it was built as. An image built by hand leaves it
// empty, and then the manifest's version is the honest answer.
export function resolveVersion(env: Record<string, string | undefined>, fallback: string): string {
  return env.BASHREACTOR_VERSION || fallback;
}

export function resolveDataDir(env: Record<string, string | undefined>): string {
  const home = env.BASHREACTOR_HOME;
  if (home !== undefined && home !== "") return home;
  const userHome = env.HOME;
  if (userHome !== undefined && userHome !== "") return join(userHome, ".bashreactor");
  return join(process.cwd(), ".bashreactor");
}

// The admin token arrives either as the token itself or as its sha256, which is what a deployment
// should set: the clear text then never appears in a pod spec, a shell history or a log.
export function resolveAdminHash(env: Record<string, string | undefined>): string | null {
  const sha = env.BASHREACTOR_ADMIN_TOKEN_SHA256?.trim();
  if (sha !== undefined && sha !== "") {
    if (!/^[0-9a-f]{64}$/.test(sha.toLowerCase())) {
      throw new BashreactorError(
        "runtime_missing",
        "BASHREACTOR_ADMIN_TOKEN_SHA256 must be 64 hexadecimal characters",
      );
    }
    return sha.toLowerCase();
  }
  const token = env.BASHREACTOR_ADMIN_TOKEN;
  if (token !== undefined && token !== "") return sha256Hex(token);
  return null;
}

/**
 * `BASHREACTOR_RETENTION` (SPEC 6): how long a run that has finished is kept before the server
 * deletes it, written in the SPEC 1.3 duration format (`7d`, `12h`, `90m`).
 *
 * Unset, empty, `off`, `none` and `0` all mean one thing, and it is the default: the server never
 * deletes a run by itself. That is a decision rather than an omission — a run directory is the only copy of
 * what a pipeline produced and nothing in v1 can tell which runs a person still wants — so the
 * default is the one that fills up until someone says otherwise, and it says so at startup.
 *
 * A value that does not parse is fatal, the way a bad port is. Starting with retention that was asked
 * for and not understood is how a deployment deletes the wrong year.
 */
export const MAX_RETENTION_MS = 100 * 365 * 24 * 3_600_000;
export function resolveRetentionMs(env: Record<string, string | undefined>): number | null {
  const raw = env.BASHREACTOR_RETENTION?.trim().toLowerCase();
  // `0` is included with `off` because it is what a Helm value renders for "not set", and because
  // the alternative reading — a retention of no time at all — is the worst possible one.
  if (raw === undefined || raw === "" || raw === "off" || raw === "none" || raw === "0") return null;
  const seconds = parseDuration(raw);
  if (seconds === null) {
    throw new BashreactorError(
      "runtime_missing",
      `BASHREACTOR_RETENTION must be a duration like 7d or 12h, or "off", got "${raw}"`,
    );
  }
  // Anything under a second is the same instruction as `off`, and rounding it to zero would be the
  // one reading worse than deleting nothing: deleting everything.
  if (seconds < 1) return null;
  const ms = seconds * 1000;
  // A `Date` stops at about 275,000 years, and past it the sweep throws on `toISOString` every pass
  // forever. A window nobody can wait out is a typo, and a typo is worth stopping the server for.
  if (ms > MAX_RETENTION_MS) {
    throw new BashreactorError(
      "runtime_missing",
      `BASHREACTOR_RETENTION "${raw}" is longer than the 100 years the server can name; it reads as a mistake, not as a window`,
    );
  }
  return ms;
}

export function resolveConfig(
  env: Record<string, string | undefined>,
  version: string,
  options: { settleMs?: number } = {},
): ApiConfig {
  const dataDir = resolveDataDir(env);
  return {
    port: resolvePort(env),
    dataDir,
    storeDir: join(dataDir, "store"),
    tokensPath: join(dataDir, "tokens.json"),
    adminHash: resolveAdminHash(env),
    enginePath: env.PATH ?? process.env.PATH ?? "",
    version,
    settleMs: options.settleMs ?? DEFAULT_SETTLE_MS,
    retentionMs: resolveRetentionMs(env),
  };
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
