// The runtime contract of docs/SPEC.md section 2.6: an engine refuses to start unless every binary a
// block may rely on is on PATH, and bash is version 5 or newer.

import { accessSync, constants } from "node:fs";
import { join } from "node:path";

const REQUIRED_BINARIES = [
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

export async function checkRuntime(pathEnv: string): Promise<string[]> {
  const missing: string[] = [];
  for (const binary of REQUIRED_BINARIES) {
    if (findOnPath(binary, pathEnv) === null) missing.push(binary);
  }
  const bash = findOnPath("bash", pathEnv);
  if (bash !== null && missing.length === 0) {
    const version = await bashMajor(bash);
    if (version !== null && version < 5) missing.push("bash (5 or newer)");
  }
  return missing;
}

export function findOnPath(name: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

async function bashMajor(bashPath: string): Promise<number | null> {
  const proc = Bun.spawn([bashPath, "-c", "printf %s \"${BASH_VERSINFO[0]}\""], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const major = Number(text.trim());
  return Number.isFinite(major) ? major : null;
}
