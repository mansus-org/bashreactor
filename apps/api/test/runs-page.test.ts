// `GET /v1/runs` answers with a page, not with the history. Every run here is a directory written
// straight into the data dir rather than a run that started, because what is being tested is what one
// request costs: a server with years of runs must readdir once and read one page of `run.json`, and
// must still answer when a run it is not showing cannot be parsed.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Engine, FsRunStore } from "@bashreactor/engine";
import type { RunRecord } from "@bashreactor/engine";
import { createApi } from "../src/app.ts";
import type { Api } from "../src/app.ts";
import { resolveConfig } from "../src/config.ts";
import { ADMIN_TOKEN } from "./helpers.ts";

/** The store the API would build for itself, keeping a tally of the `run.json` files it was asked for. */
class CountingStore extends FsRunStore {
  readonly reads: string[] = [];

  override async loadRun(runId: string): Promise<RunRecord | null> {
    this.reads.push(runId);
    return super.loadRun(runId);
  }
}

const root = mkdtempSync(join(tmpdir(), "bashreactor-runs-page-"));
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

const list = async (query: string): Promise<Response> =>
  await api.fetch(
    new Request(`http://bashreactor.test/v1/runs${query}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
  );

const idsOf = async (response: Response): Promise<string[]> =>
  ((await response.json()) as { id: string }[]).map((run) => run.id);

/** Every id written so far, newest first — the order the listing owes the caller. */
const all: string[] = [];

/**
 * A run directory with a `run.json` in it, in the shape SPEC 4.2 gives one. `id` is a timestamp to
 * the second, so the hour carries the order and `created_at` is read back out of it.
 */
function writeRun(id: string, status: RunRecord["status"] = "succeeded"): string {
  const [, day, hour] = id.match(/^202611(\d\d)T(\d\d)0000Z/)!.slice(1);
  const dir = join(root, "runs", id);
  mkdirSync(dir, { recursive: true });
  const record: RunRecord = {
    schema: 1,
    id,
    pipeline: "word-report",
    status,
    created_at: `2026-11-${day}T${hour}:00:00.000Z`,
    finished_at: status === "running" ? null : `2026-11-${day}T${hour}:00:05.000Z`,
    cancel_requested_at: null,
    inputs: {},
    outputs: {},
    steps: {},
  };
  writeFileSync(join(dir, "run.json"), JSON.stringify(record, null, 2));
  all.push(id);
  return id;
}

/** Twenty-one runs an hour apart, so lexicographic order is chronological order and nothing is a tie. */
const IDS = Array.from({ length: 21 }, (_, i) => `20261106T${String(i).padStart(2, "0")}0000Z-${i.toString(16).padStart(8, "0")}`);

beforeAll(() => {
  for (const id of IDS) writeRun(id, "running");
});

describe("a page of the run list", () => {
  test("everything that fits comes back newest first, with no cursor to follow", async () => {
    const response = await list("");
    expect(response.status).toBe(200);
    expect(await idsOf(response)).toEqual([...all].toSorted().toReversed());
    expect(response.headers.get("x-next-cursor")).toBeNull();
  });

  test("a page holds `limit` runs and the cursor walks the history exactly once", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; ; pages++) {
      // A cursor that never runs out is the bug, so fail rather than spin.
      expect(pages).toBeLessThan(all.length + 2);
      const response = await list(cursor === null ? "?limit=5" : `?limit=5&cursor=${cursor}`);
      expect(response.status).toBe(200);
      const page = await idsOf(response);
      expect(page.length).toBeLessThanOrEqual(5);
      seen.push(...page);
      cursor = response.headers.get("x-next-cursor");
      if (cursor === null) break;
    }
    // One equality proves both halves: every id once, and newest first across the page joins.
    expect(seen).toEqual([...all].toSorted().toReversed());
  });

  test("a page reads its own runs and no others", async () => {
    store.reads.length = 0;
    const response = await list("?limit=4");
    const page = await idsOf(response);
    expect(page.length).toBe(4);
    expect(store.reads.toSorted()).toEqual([...page].toSorted());
  });

  test("limit=0 and no limit at all are the default page", async () => {
    expect(await idsOf(await list("?limit=0"))).toEqual(await idsOf(await list("")));
  });

  test("a limit that is not a count is the caller's mistake, and says so", async () => {
    for (const bad of ["abc", "-1", "1.5"]) {
      const response = await list(`?limit=${bad}`);
      expect(response.status).toBe(422);
      expect((await response.json()) as object).toMatchObject({ code: "type_mismatch", path: "limit" });
    }
  });
});

describe("the cap on a page", () => {
  test("is what a page holds, however hard the caller asks, and is all it reads", async () => {
    // Five hundred and one more runs, so the cap is the only thing that could hold the page down.
    const extra = Array.from(
      { length: 501 },
      (_, i) => `2026110${5 - (i % 5)}T${String(i % 24).padStart(2, "0")}0000Z-${i.toString(16).padStart(8, "0")}`,
    );
    for (const id of extra) writeRun(id);

    store.reads.length = 0;
    const response = await list("?limit=99999");
    expect(response.status).toBe(200);
    const page = await idsOf(response);
    expect(page.length).toBe(500);
    expect(page).toEqual([...all].toSorted().toReversed().slice(0, 500));
    expect(store.reads.length).toBe(500);
    // There is history below it, so there is somewhere to go next.
    expect(response.headers.get("x-next-cursor")).toBe(page[499]!);
  });
});

describe("a cursor that is not a run id", () => {
  test("is just a cursor: the page comes from the top or empty, never an error", async () => {
    for (const cursor of ["not-a-run-id", "zzz"]) {
      const response = await list(`?limit=5&cursor=${cursor}`);
      expect(response.status).toBe(200);
      expect(await idsOf(response)).toEqual([...all].toSorted().toReversed().slice(0, 5));
    }
    for (const cursor of ["0", "!", "00000000T000000Z-00000000"]) {
      const response = await list(`?limit=5&cursor=${cursor}`);
      expect(response.status).toBe(200);
      expect(await idsOf(response)).toEqual([]);
      expect(response.headers.get("x-next-cursor")).toBeNull();
    }
  });
});

describe("a run the server cannot read", () => {
  // Older than every id above, so it sits outside the first page: the listing must not have to parse
  // it to answer, and must not stop at it when the walk reaches it.
  const BROKEN = "20261105T230000Z-00000000";
  const EMPTY = "20261105T220000Z-00000000";
  const STRAY = "not-a-run-id";

  beforeAll(() => {
    mkdirSync(join(root, "runs", BROKEN), { recursive: true });
    writeFileSync(join(root, "runs", BROKEN, "run.json"), "{ this is not JSON at all");
    mkdirSync(join(root, "runs", EMPTY), { recursive: true });
    mkdirSync(join(root, "runs", STRAY), { recursive: true });
    writeFileSync(join(root, "runs", STRAY, "run.json"), JSON.stringify({ id: STRAY }));
  });

  test("does not stop a page that does not include it", async () => {
    const response = await list("?limit=5");
    expect(response.status).toBe(200);
    expect(await idsOf(response)).toEqual([...all].toSorted().toReversed().slice(0, 5));
  });

  test("is skipped by a walk that reaches it, which still ends", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; ; pages++) {
      expect(pages).toBeLessThan(all.length + 4);
      const response = await list(cursor === null ? "?limit=5" : `?limit=5&cursor=${cursor}`);
      expect(response.status).toBe(200);
      seen.push(...(await idsOf(response)));
      cursor = response.headers.get("x-next-cursor");
      if (cursor === null) break;
    }
    // The unreadable runs are not listed, and the readable ones are all there, once each.
    expect(seen).toEqual([...all].toSorted().toReversed());
    // And the server said so, rather than dropping them quietly: the walk got past them because they
    // were logged, not because they were hidden.
    expect(logs.filter((line) => line.includes(`run ${BROKEN} is not listable`)).length).toBe(1);
  });
});

