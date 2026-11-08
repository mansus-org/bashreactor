// `GET /v1/disk` (SPEC 4.11): the number a probe or a cron watches, so that a full volume is news
// before it is a failed run.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/app.ts";
import type { ApiConfig } from "../src/config.ts";
import { resolveConfig } from "../src/config.ts";
import { LOW_FREE_BYTES, diskSpace, runsBytes } from "../src/disk.ts";
import { ADMIN_TOKEN, fakeRuntimeDir, startApi } from "./helpers.ts";

const body = async (response: Response) => (await response.json()) as Record<string, any>;

/** The config a server would have had, for a route test that needs to hand `createApi` something else. */
function apiConfig(root: string): ApiConfig {
  return resolveConfig(
    { BASHREACTOR_HOME: root, PATH: fakeRuntimeDir(root), BASHREACTOR_ADMIN_TOKEN: ADMIN_TOKEN },
    "test-version",
  );
}

describe("diskSpace", () => {
  test("the numbers are the filesystem's own, and they add up", () => {
    const root = mkdtempSync(join(tmpdir(), "bashreactor-disk-"));
    const disk = diskSpace(root);

    expect(disk).not.toBeNull();
    expect(disk!.total_bytes).toBeGreaterThan(0);
    expect(disk!.free_bytes).toBeGreaterThan(0);
    expect(disk!.used_bytes).toBe(disk!.total_bytes - disk!.free_bytes);
    // Whether this particular machine is low is not the test; that the flag follows the threshold is.
    expect(disk!.low).toBe(disk!.free_bytes < LOW_FREE_BYTES);
    rmSync(root, { recursive: true, force: true });
  });

  test("a directory that is not there does not read as a full one", () => {
    // A mount that has not come up yet must not answer `free: 0`: a watcher would page for a full
    // disk when the real fault is a volume that is missing.
    expect(diskSpace(join(tmpdir(), "bashreactor-not-a-mount"))).toBeNull();
  });
});

describe("runsBytes", () => {
  // The filesystem's own numbers can belong to a disk far larger than the volume the deployment was
  // given, so this is the count an operator can compare with what they asked for.
  test("everything under the directory, however it is nested", async () => {
    const root = mkdtempSync(join(tmpdir(), "bashreactor-runs-bytes-"));
    const run = join(root, "runs", "20261106T120000Z-deadbeef");
    mkdirSync(join(run, "blocks", "fetch"), { recursive: true });
    writeFileSync(join(run, "run.json"), "{}");
    writeFileSync(join(run, "blocks", "fetch", "log"), "0123456789");

    expect(await runsBytes(join(root, "runs"))).toBe(12);
    rmSync(root, { recursive: true, force: true });
  });

  test("a home with no runs yet is empty, not an error", async () => {
    const root = mkdtempSync(join(tmpdir(), "bashreactor-runs-bytes-"));
    expect(await runsBytes(join(root, "runs"))).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  test("a symlink counts as the link, not as whatever it reaches", async () => {
    // A block that leaves a symlink out of the volume must not have the whole of that other tree
    // charged to bashreactor, and the walk must not follow it into a loop.
    const root = mkdtempSync(join(tmpdir(), "bashreactor-runs-bytes-"));
    const runs = join(root, "runs");
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(root, "somewhere-else"), "0123456789".repeat(100));
    symlinkSync(join(root, "somewhere-else"), join(runs, "escape"));

    expect(await runsBytes(runs)).toBeLessThan(1000);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("GET /v1/disk", () => {
  test("names the directory it measured and the room left in it", async () => {
    const api = startApi();
    const response = await api.call("GET", "/v1/disk");

    expect(response.status).toBe(200);
    const disk = await body(response);
    expect(disk.path).toBe(api.root);
    expect(disk.total_bytes).toBeGreaterThan(0);
    expect(disk.free_bytes).toBeGreaterThan(0);
    expect(typeof disk.low).toBe("boolean");
    expect(disk.runs_bytes).toBe(0);

    // The number that belongs to bashreactor rather than to the node it is standing on.
    mkdirSync(join(api.root, "runs", "20261106T120000Z-deadbeef"), { recursive: true });
    writeFileSync(join(api.root, "runs", "20261106T120000Z-deadbeef", "run.json"), "0123456789");
    expect((await body(await api.call("GET", "/v1/disk"))).runs_bytes).toBe(10);
    api.cleanup();
  });

  test("a token that can read can see the room left", async () => {
    const api = startApi();
    const response = await api.call("GET", "/v1/disk", { token: await api.agentToken("read") });

    expect(response.status).toBe(200);
    api.cleanup();
  });

  test("nobody gets the shape of the deployment for free", async () => {
    const api = startApi();
    const response = await api.call("GET", "/v1/disk", { token: null });

    expect(response.status).toBe(401);
    api.cleanup();
  });

  test("a filesystem that will not say is a 503, not a zero", async () => {
    const root = mkdtempSync(join(tmpdir(), "bashreactor-disk-"));
    // What a stale mount or a permission the server does not have looks like. Answering
    // `free_bytes: 0` would blame the disk for a mount that never arrived, and a watcher would page
    // for a full volume that is not full.
    const mute = createApi({ config: apiConfig(root), disk: () => null, log: () => {} });

    const response = await mute.fetch(
      new Request("http://bashreactor.test/v1/disk", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
    );
    expect(response.status).toBe(503);
    expect((await body(response)).code).toBe("runtime_missing");

    mute.close();
    rmSync(root, { recursive: true, force: true });
  });
});
