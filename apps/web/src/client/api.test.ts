// The client's half of the newer API: run filters and their cursor, the disk and token routes, and
// reading one file out of a run's snapshot. The server has its own tests; this checks the shapes and
// the addresses the screens will call.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { installDom, serveModules, uninstallDom } from "./client.testkit.ts";

const dom = installDom({ href: "http://x/app/runs" });
const served = serveModules(["api"]);
const api = (await import(join(served, "api.js"))) as typeof import("./api.ts");

type Call = { method: string; url: URL; body: string | null };
const calls: Call[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  calls.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? init.body : null });
  if (url.pathname.endsWith("/file")) return new Response("name: word-report\n", { status: 200 });
  if (url.pathname === "/v1/tokens" && init?.method === "POST") {
    return new Response(JSON.stringify({ id: "t1", name: "agent", scope: "read", created_at: "2026-11-05T20:00:00Z", last_used: null, token: "br_secret" }), { status: 201 });
  }
  if (url.pathname === "/v1/tokens") return new Response(JSON.stringify([]), { status: 200 });
  if (url.pathname.startsWith("/v1/tokens/")) return new Response(JSON.stringify({ deleted: "t1" }), { status: 200 });
  if (url.pathname === "/v1/disk") {
    return new Response(
      JSON.stringify({ path: "/data", total_bytes: 100, used_bytes: 40, free_bytes: 60, low: false, runs_bytes: 10 }),
      { status: 200 },
    );
  }
  if (url.pathname.startsWith("/v1/runs/")) return new Response(JSON.stringify({ deleted: "r1" }), { status: 200 });
  return new Response(JSON.stringify([{ id: "r1" }]), { status: 200, headers: { "x-next-cursor": "r0" } });
}) as typeof fetch;

api.signIn("http://api.test", "a_token", false);

describe("the client API", () => {
  test("listRuns sends the filters comma-joined and reads the next cursor off the header", async () => {
    calls.length = 0;
    const page = await api.api.listRuns({ limit: 50, pipeline: "word-report", status: ["failed", "cancelled"], since: "2026-11-01T00:00:00Z" });
    expect(page.runs).toEqual([{ id: "r1" }] as never);
    expect(page.next).toBe("r0");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.pathname).toBe("/v1/runs");
    expect(calls[0]!.url.searchParams.get("limit")).toBe("50");
    expect(calls[0]!.url.searchParams.get("pipeline")).toBe("word-report");
    expect(calls[0]!.url.searchParams.get("status")).toBe("failed,cancelled");
    expect(calls[0]!.url.searchParams.get("since")).toBe("2026-11-01T00:00:00Z");
  });

  test("the old runs list still gets the bare array", async () => {
    const runs = await api.api.runs();
    expect(runs).toEqual([{ id: "r1" }] as never);
  });

  test("deleting a run is a DELETE at the run's own address", async () => {
    await api.api.deleteRun("r1");
    expect(calls.at(-1)!.method).toBe("DELETE");
    expect(calls.at(-1)!.url.pathname).toBe("/v1/runs/r1");
  });

  test("disk and tokens are read, and a created token carries its one secret", async () => {
    const disk = await api.api.disk();
    expect(disk.runs_bytes).toBe(10);
    expect(await api.api.tokens()).toEqual([]);
    const created = await api.api.createToken("agent", "read");
    expect(created.token).toBe("br_secret");
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ name: "agent", scope: "read" });
    await api.api.revokeToken("t1");
    expect(calls.at(-1)!.method).toBe("DELETE");
    expect(calls.at(-1)!.url.pathname).toBe("/v1/tokens/t1");
  });

  test("runFileText reads one file's text from the run's snapshot", async () => {
    const text = await api.api.runFileText("r1", "pipeline.yaml");
    expect(text).toContain("name: word-report");
    expect(calls.at(-1)!.url.pathname).toBe("/v1/runs/r1/file");
    expect(calls.at(-1)!.url.searchParams.get("path")).toBe("pipeline.yaml");
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  api.signOut();
  uninstallDom(dom);
  rmSync(served, { recursive: true, force: true });
});
