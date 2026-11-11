// The filters on `GET /v1/runs`, and what a listed run now says about itself. The runs are written
// straight into the data directory so the test chooses their ids, pipelines and statuses exactly;
// paging is measured through the store's own `loadRun`, because the point is how far a filtered page
// has to read to fill itself.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { Engine, FsRunStore } from "@bashreactor/engine";
import type { RunRecord, StepRecord } from "@bashreactor/engine";
import { createApi } from "../src/app.ts";
import type { Api } from "../src/app.ts";
import { resolveConfig } from "../src/config.ts";
import { ADMIN_TOKEN } from "./helpers.ts";

class CountingStore extends FsRunStore {
  readonly reads: string[] = [];
  inFlight = 0;
  maxInFlight = 0;

  override async loadRun(runId: string): Promise<RunRecord | null> {
    this.reads.push(runId);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      return await super.loadRun(runId);
    } finally {
      this.inFlight -= 1;
    }
  }
}

const root = mkdtempSync(join(tmpdir(), "bashreactor-runs-filter-"));
const store = new CountingStore(root);
const logs: string[] = [];
const api: Api = createApi({
  config: resolveConfig(
    { BASHREACTOR_HOME: root, PORT: "0", BASHREACTOR_ADMIN_TOKEN: ADMIN_TOKEN },
    "test-version",
    { settleMs: 10_000 },
  ),
  engine: new Engine({ store, env: process.env }),
  log: (line) => logs.push(line),
});

afterAll(() => {
  api.close();
  rmSync(root, { recursive: true, force: true });
});

const list = async (query = ""): Promise<Response> =>
  await api.fetch(
    new Request(`http://bashreactor.test/v1/runs${query}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
  );

const bodyOf = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const idAt = (seconds: number, salt = 0): string =>
  `${new Date(Date.UTC(2026, 10, 11, 0, 0, seconds)).toISOString().replace(/[-:]/g, "").replace(".000", "")}-${salt
    .toString(16)
    .padStart(8, "0")}`;

interface WriteRunOptions {
  pipeline?: string;
  status?: RunRecord["status"];
  steps?: RunRecord["steps"];
  pipelineVersion?: number | null;
}

function writeRun(id: string, options: WriteRunOptions = {}): string {
  const status = options.status ?? "succeeded";
  const created = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(
    11,
    13,
  )}:${id.slice(13, 15)}.000Z`;
  const dir = join(root, "runs", id);
  mkdirSync(dir, { recursive: true });
  const record: RunRecord = {
    schema: 1,
    id,
    pipeline: options.pipeline ?? "word-report",
    pipeline_version: options.pipelineVersion ?? null,
    status,
    created_at: created,
    finished_at: status === "running" ? null : created,
    cancel_requested_at: null,
    inputs: {},
    outputs: {},
    steps: options.steps ?? {},
  };
  writeFileSync(join(dir, "run.json"), JSON.stringify(record, null, 2));
  return id;
}

const INDICES = Array.from({ length: 25 }, (_, i) => i);
const baseId = (i: number): string => idAt(i, i + 1);
const idsWhere = (match: (i: number) => boolean): string[] =>
  INDICES.filter(match)
    .toReversed()
    .map(baseId);

const pipelineOf = (i: number) => (i % 5 === 0 ? "alpha" : "beta");
const statusOf = (i: number): RunRecord["status"] =>
  i % 3 === 0 ? "failed" : i % 3 === 1 ? "succeeded" : "running";

for (const i of INDICES) writeRun(baseId(i), { pipeline: pipelineOf(i), status: statusOf(i) });

const idsOf = async (response: Response): Promise<string[]> =>
  (await bodyOf<{ id: string }[]>(response)).map((run) => run.id);

describe("each run filter on its own", () => {
  test("pipeline keeps only runs of that pipeline", async () => {
    const response = await list("?pipeline=alpha");
    expect(response.status).toBe(200);
    expect(await idsOf(response)).toEqual(idsWhere((i) => pipelineOf(i) === "alpha"));
  });

  test("status keeps any run whose status is in the comma-separated list", async () => {
    expect(await idsOf(await list("?status=failed"))).toEqual(idsWhere((i) => statusOf(i) === "failed"));
    expect(await idsOf(await list("?status=running,failed"))).toEqual(
      idsWhere((i) => statusOf(i) === "running" || statusOf(i) === "failed"),
    );
  });

  test("since keeps runs created at or after the instant, read from the id", async () => {
    expect(await idsOf(await list("?since=2026-11-11T00:00:20Z"))).toEqual(idsWhere((i) => i >= 20));
    expect(await idsOf(await list("?since=2026-11-11T00:00:20.000Z"))).toEqual(idsWhere((i) => i >= 20));
  });

  test("an empty filter value is the filter being absent", async () => {
    expect(await idsOf(await list("?pipeline=&status=&since="))).toEqual(await idsOf(await list()));
  });
});

describe("filters together", () => {
  test("pipeline, status and since all have to match", async () => {
    const response = await list("?pipeline=alpha&status=failed,running&since=2026-11-11T00:00:10Z");
    expect(response.status).toBe(200);
    expect(await idsOf(response)).toEqual(
      idsWhere((i) => i >= 10 && pipelineOf(i) === "alpha" && (statusOf(i) === "failed" || statusOf(i) === "running")),
    );
  });
});

describe("paging a filtered list", () => {
  test("sparse matches take more than one page, and every match is seen exactly once", async () => {
    const expected = idsWhere((i) => pipelineOf(i) === "alpha");
    const seen: string[] = [];
    let cursor: string | null = null;
    let firstPageReads = 0;

    for (let pages = 0; ; pages += 1) {
      expect(pages).toBeLessThan(expected.length + 2);
      store.reads.length = 0;
      store.maxInFlight = 0;
      const query = cursor === null ? "?pipeline=alpha&limit=3" : `?pipeline=alpha&limit=3&cursor=${cursor}`;
      const response = await list(query);
      expect(response.status).toBe(200);
      const page = await idsOf(response);
      if (pages === 0) firstPageReads = store.reads.length;
      seen.push(...page);
      expect(store.maxInFlight).toBeLessThanOrEqual(32);
      cursor = response.headers.get("x-next-cursor");
      if (cursor === null) break;
    }

    expect(seen).toEqual(expected);
    // One match in five means a three-run page cannot be filled by reading only three records.
    expect(firstPageReads).toBeGreaterThan(3);
  });

  test("a since that excludes everything answers an empty page with no cursor", async () => {
    const response = await list("?since=2026-11-12T00:00:00Z");
    expect(response.status).toBe(200);
    expect(await idsOf(response)).toEqual([]);
    expect(response.headers.get("x-next-cursor")).toBeNull();
  });
});

describe("a malformed filter value", () => {
  test("is 400 type_mismatch with the parameter as its path", async () => {
    const malformed: [string, string][] = [
      ["pipeline=Alpha", "pipeline"],
      ["pipeline=1alpha", "pipeline"],
      ["status=done", "status"],
      ["status=running,", "status"],
      ["status=running,,failed", "status"],
      ["since=2026-11-11", "since"],
      ["since=2026-13-11T00:00:00Z", "since"],
      ["since=2026-02-30T00:00:00Z", "since"],
      ["since=2026-11-11T00:00:00%2B00:00", "since"],
      ["since=not-an-instant", "since"],
    ];
    for (const [query, path] of malformed) {
      const response = await list(`?${query}`);
      expect(response.status).toBe(400);
      expect(await bodyOf<Record<string, unknown>>(response)).toMatchObject({ code: "type_mismatch", path });
    }
  });
});

describe("what a listed run says about itself", () => {
  test("step_counts has every status, even at zero, and counts the mixed steps", async () => {
    const statuses: StepRecord["status"][] = [
      "pending",
      "running",
      "waiting_retry",
      "succeeded",
      "failed",
      "skipped",
      "cancelled",
    ];
    const steps = Object.fromEntries(
      statuses.map((status, index) => [`step_${index}`, { status }]),
    ) as unknown as RunRecord["steps"];
    const id = writeRun(idAt(30, 99), { pipeline: "counts", steps });

    const response = await list("?pipeline=counts");
    const runs = await bodyOf<{ id: string; step_counts: Record<string, number> }[]>(response);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(id);
    expect(runs[0]!.step_counts).toEqual({
      total: 7,
      pending: 1,
      running: 1,
      waiting_retry: 1,
      succeeded: 1,
      failed: 1,
      skipped: 1,
      cancelled: 1,
    });
  });

  test("pipeline_version is the record's, and null for a run that did not have one", async () => {
    const versioned = writeRun(idAt(31, 99), { pipeline: "counts", pipelineVersion: 4 });
    const old = writeRun(idAt(32, 99), { pipeline: "counts" });

    const response = await list("?pipeline=counts&limit=3");
    const runs = await bodyOf<{ id: string; pipeline_version: number | null }[]>(response);
    expect(runs.find((run) => run.id === versioned)!.pipeline_version).toBe(4);
    expect(runs.find((run) => run.id === old)!.pipeline_version).toBeNull();
  });
});
