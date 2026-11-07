// `GET /v1/disk` (SPEC 6): the number a probe or a cron watches, so that a full volume is news
// before it is a failed run.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/app.ts";
import type { ApiConfig } from "../src/config.ts";
import { resolveConfig } from "../src/config.ts";
import { LOW_FREE_BYTES, diskSpace } from "../src/disk.ts";
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
