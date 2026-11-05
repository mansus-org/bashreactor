import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, FsRunStore } from "@bashreactor/engine";
import { fakeRuntimeDir } from "./helpers.ts";
import { resumeRunningRuns } from "../src/resume.ts";

const BLOCK = `#!/usr/bin/env bash
# ---
# name: quick
# description: Finish at once.
# ---
echo done
`;

const PIPELINE = "name: quick\nsteps:\n  one:\n    uses: ./quick.sh\n";

function procStart(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
}

function fixture(): { root: string; engine: Engine; pipelinePath: string } {
  const root = mkdtempSync(join(tmpdir(), "bashreactor-resume-"));
  const blocks = mkdtempSync(join(tmpdir(), "bashreactor-blocks-"));
  writeFileSync(join(blocks, "quick.sh"), BLOCK);
  const pipelinePath = join(blocks, "quick.yaml");
  writeFileSync(pipelinePath, PIPELINE);
  mkdirSync(join(root, "runs"), { recursive: true });
  return { root, engine: new Engine({ store: new FsRunStore(root), path: fakeRuntimeDir(root) }), pipelinePath };
}

async function finalStatus(engine: Engine, id: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const record = await engine.getRun(id);
    if (record !== null && record.status !== "running") return record.status;
    await Bun.sleep(50);
  }
  return "running";
}

describe("resumeRunningRuns", () => {
  test("a run left running by a dead engine is taken up and driven to the end", async () => {
    const { root, engine, pipelinePath } = fixture();
    try {
      const record = await engine.start(pipelinePath); // created, never driven: this is a crash
      expect(record.status).toBe("running");

      const lines: string[] = [];
      expect(await resumeRunningRuns(engine, (line) => lines.push(line))).toEqual([record.id]);
      expect(await finalStatus(engine, record.id)).toBe("succeeded");
      expect(lines).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a run another live engine holds is left alone, and says so", async () => {
    const { root, engine, pipelinePath } = fixture();
    try {
      const record = await engine.start(pipelinePath);
      const store = engine.store as FsRunStore;
      await store.tryClaim(record.id, { pid: process.pid, pid_start: procStart(process.pid) });

      const lines: string[] = [];
      expect(await resumeRunningRuns(engine, (line) => lines.push(line))).toEqual([record.id]);
      // The resume is taken up in the background, so what it says arrives a moment later.
      for (let attempt = 0; attempt < 100 && lines.length === 0; attempt++) await Bun.sleep(20);
      expect(lines.join("\n")).toInclude("left with the engine that holds it");
      expect((await engine.getRun(record.id))?.status).toBe("running");

      await store.releaseClaim(record.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a run that already finished is not touched", async () => {
    const { root, engine, pipelinePath } = fixture();
    try {
      const record = await engine.start(pipelinePath);
      await engine.drive(record.id);
      expect((await engine.getRun(record.id))?.status).toBe("succeeded");
      expect(await resumeRunningRuns(engine, () => {})).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
