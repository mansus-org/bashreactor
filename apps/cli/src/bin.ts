#!/usr/bin/env bun
import { runCli } from "./index.ts";

process.exit(runCli(process.argv.slice(2), { stderr: console.error }));
