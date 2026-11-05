#!/usr/bin/env bun
// The whole binary: read the command line, hand it to `runCli`, exit with the number it says. A
// failure has already been printed by the time this exits, so nothing here adds to it.

import { runCli } from "./index.ts";

process.exit(await runCli(process.argv.slice(2)));
