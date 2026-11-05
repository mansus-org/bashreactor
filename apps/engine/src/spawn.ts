// Spawning a block (docs/SPEC.md section 2.6): bash -euo pipefail, a new session/process group via
// setsid, /dev/null stdin, and the attempt's log file as stdout and stderr.

import { closeSync, openSync } from "node:fs";
import type { Subprocess } from "bun";

export function spawnBlock(options: {
  blockPath: string;
  cwd: string;
  env: Record<string, string>;
  logPath: string;
}): Subprocess {
  // O_CREAT|O_APPEND, per section 4.8; the child inherits it directly, with no pipe through us.
  const logFd = openSync(options.logPath, "a", 0o644);
  try {
    return Bun.spawn({
      cmd: ["bash", "-euo", "pipefail", options.blockPath],
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      detached: true,
    });
  } finally {
    closeSync(logFd);
  }
}
