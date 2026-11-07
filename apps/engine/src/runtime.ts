// The runtime contract of docs/SPEC.md section 2.6: the server checks at startup that every binary a
// block may rely on resolves on the PATH it will be handed, and that bash is version 5 or newer.
// The check is synchronous because the startup path is: it runs on the way to binding the socket,
// where there is nothing to await and a promise would only move the failure somewhere later.

import { accessSync, constants } from "node:fs";
import { join } from "node:path";

/**
 * Every binary SPEC 2.6 requires on the engine's PATH, in the order the spec lists them. Coreutils
 * is taken to be there when `cat`, `mv` and `wc` are, because a fixed list of its tools would name
 * binaries no block has ever called.
 */
export const REQUIRED_BINARIES = [
  "bash",
  "uv",
  "bun",
  "awk",
  "curl",
  "grep",
  "gzip",
  "jq",
  "sed",
  "tar",
  "cat",
  "mv",
  "wc",
] as const;

/**
 * The binaries on `pathEnv` that a block is allowed to assume and are not, in the spec's order;
 * empty means the contract holds. `bash` is missing from the answer when it is older than 5, named
 * with its version requirement so the message says what to install and what was found instead.
 *
 * A caller is expected to check once and keep the answer: the server does it before it serves, and
 * an engine does it again the first time it is asked to start a run, which is what catches a
 * runtime that went away after the process came up.
 */
export function checkRuntime(pathEnv: string): string[] {
  const missing: string[] = [];
  for (const name of REQUIRED_BINARIES) {
    if (findOnPath(pathEnv, name) === null) missing.push(name);
  }

  // Only check the bash version when bash is there at all: a missing binary is already in the list,
  // and the version is not the problem a person reading the message has to fix first.
  if (missing.length === 0) {
    const bashPath = findOnPath(pathEnv, "bash")!;
    const major = bashMajor(bashPath);
    if (major === null || major < 5) missing.push("bash (5 or newer)");
  }

  return missing;
}

function findOnPath(pathEnv: string, name: string): string | null {
  for (const dir of pathEnv.split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The major version of the bash at `bashPath`, or null when it cannot be asked. A bash 3.2 (the one
 * macOS shipped, and the one an engine has met) has no `BASH_VERSINFO[1]`, so the script prints the
 * one element every bash since 2.0 has had and the comparison is on the major alone.
 */
function bashMajor(bashPath: string): number | null {
  try {
    const result = Bun.spawnSync([bashPath, "-c", 'printf %s "${BASH_VERSINFO[0]}"'], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    if (result.exitCode !== 0) return null;
    const major = Number.parseInt(result.stdout.toString().trim(), 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}
