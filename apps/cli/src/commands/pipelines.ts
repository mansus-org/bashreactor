// Pipeline versions: `pipelines ls|get|validate|add`. A local file goes through
// `publishRelativeBlocks` first, because the API resolves `uses` against itself and not against
// your disk — see ../local.ts.

import type { CommandSpec } from "../args.ts";
import { localTime } from "../output.ts";
import { publishRelativeBlocks, readPipelineFile } from "../local.ts";
import { VERSION_FLAG, versionOf } from "./flags.ts";
import type { PipelineList, PipelineVersion, ValidationReport } from "../types.ts";

export const pipelineCommands: CommandSpec[] = [
  {
    group: "pipelines",
    name: "ls",
    summary: "every version of one pipeline",
    args: [{ name: "<name>" }],
    run: async (ctx) => {
      const list = await ctx.client.json<PipelineList>("GET", `/v1/pipelines/${encodeURIComponent(ctx.args[0]!)}`);
      ctx.printer.emit(list, (p) => {
        p.line(`${list.name} — ${list.versions.length} version(s), latest ${list.latest}`);
        p.table(
          ["NAME", "VERSION", "SHA256", "CREATED"],
          list.versions.map((version) => [
            version.name,
            String(version.version),
            version.sha256.slice(0, 12),
            localTime(version.created_at),
          ]),
        );
      });
      return 0;
    },
  },
  {
    group: "pipelines",
    name: "get",
    summary: "one version, with its YAML",
    args: [{ name: "<name>" }],
    flags: [VERSION_FLAG],
    run: async (ctx) => {
      const record = await ctx.client.json<PipelineVersion>(
        "GET",
        `/v1/pipelines/${encodeURIComponent(ctx.args[0]!)}/${versionOf(ctx)}`,
      );
      ctx.printer.emit(record, (p) => {
        p.fields([
          ["name", record.name],
          ["version", String(record.version)],
          ["sha256", record.sha256],
          ["created", localTime(record.created_at)],
        ]);
        if (record.yaml !== undefined) {
          p.line("");
          p.line(record.yaml.replace(/\n$/, ""));
        }
      });
      return 0;
    },
  },
  {
    group: "pipelines",
    name: "validate",
    summary: "check a pipeline file and every block it uses, running nothing",
    args: [{ name: "<file>" }],
    run: async (ctx) => {
      const file = readPipelineFile(ctx.args[0]!);
      const prepared = await publishRelativeBlocks(ctx.client, file, (line) => ctx.printer.note(line));
      const report = await ctx.client.json<ValidationReport>("POST", "/v1/pipelines/validate", {
        body: { yaml: prepared.yaml },
      });
      ctx.printer.emit(report, (p) => {
        if (report.valid) {
          p.line(`valid  ${file.path}`);
          return;
        }
        p.line(`invalid  ${file.path}`);
        p.table(
          ["CODE", "PATH", "MESSAGE"],
          report.issues.map((issue) => [issue.code, issue.path ?? "-", issue.message]),
        );
      });
      // The route answers 200 with every issue whatever it finds (apps/api/README.md), so the
      // verdict is in the body and a script wants it in the exit code.
      return report.valid ? 0 : 1;
    },
  },
  {
    group: "pipelines",
    name: "add",
    summary: "store a version of a pipeline from a file",
    args: [{ name: "<name>" }, { name: "<file>" }],
    run: async (ctx) => {
      const name = ctx.args[0]!;
      const file = readPipelineFile(ctx.args[1]!);
      const prepared = await publishRelativeBlocks(ctx.client, file, (line) => ctx.printer.note(line));
      const stored = await ctx.client.json<PipelineVersion>("POST", `/v1/pipelines/${encodeURIComponent(name)}/versions`, {
        body: { yaml: prepared.yaml },
      });
      ctx.printer.emit(stored, (p) => {
        p.line(`stored ${stored.name}@${stored.version}  ${stored.sha256.slice(0, 12)}`);
      });
      return 0;
    },
  },
];
