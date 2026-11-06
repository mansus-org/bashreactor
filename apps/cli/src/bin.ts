#!/usr/bin/env bun
// The whole binary: read the command line, hand it to `runCli`, exit with the number it says. A
// failure has already been printed by the time this exits, so nothing here adds to it.

import { runCli } from "./index.ts";

// Not process.exit: it drops what a pipe has not taken yet, which cut a multi-megabyte log short
// under `| wc -c`. The process ends by itself once stdout is flushed and the command's sockets are closed.
process.exitCode = await runCli(process.argv.slice(2));
