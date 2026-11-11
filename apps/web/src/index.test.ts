// The mount, over HTTP, against a real API in the same process — which is exactly how it is deployed:
// one socket, `/app` answered here and everything else handed to the API. The API's own contract is
// re-probed here on purpose: what `GET /` and `GET /healthz` answer is what the CI image job checks,
// and the UI must not disturb it.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi, resolveConfig } from "@bashreactor/api";
import { mountApp } from "./index.ts";

const ADMIN = "web_test_admin";
const EXAMPLES = join(import.meta.dir, "../../../docs/examples");

interface Mounted {
  base: string;
  call(method: string, path: string, options?: { token?: string | null; body?: unknown }): Promise<Response>;
  close(): void;
}

function mount(): Mounted {
  const root = mkdtempSync(join(tmpdir(), "bashreactor-web-"));
  const config = resolveConfig(
    {
      BASHREACTOR_HOME: root,
      PORT: "0",
      // The engine checks SPEC 2.6's binaries on its PATH before it will run anything.
      PATH: process.env.PATH ?? "/bin:/usr/bin",
      BASHREACTOR_ADMIN_TOKEN: ADMIN,
    },
    "web-test",
    { settleMs: 10_000 },
  );
  const api = createApi({ config, log: () => {} });
  const handler = mountApp((request) => api.fetch(request));
  const server = Bun.serve({ port: 0, fetch: (request) => handler(request) });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    base,
    async call(method, path, options = {}) {
      const headers: Record<string, string> = {};
      const token = options.token === undefined ? ADMIN : options.token;
      if (token !== null) headers.authorization = `Bearer ${token}`;
      let body: string | undefined;
      if (options.body !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(options.body);
      }
      return await fetch(`${base}${path}`, { method, headers, body });
    },
    close: () => {
      server.stop();
      api.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("the mount", () => {
  test("leaves every route the API already had exactly as it was", async () => {
    const app = mount();
    try {
      // The CI image job probes this redirect; the UI lives under /app, so `/` has somewhere to send
      // a person who typed the host into a browser. Read by hand, because `call` would follow it.
      const root = await fetch(`${app.base}/`, { redirect: "manual" });
      expect(root.status).toBe(302);
      expect(root.headers.get("location")).toBe(`${app.base}/app/`);

      const health = await app.call("GET", "/healthz");
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok", version: "web-test" });

      const anonymous = await app.call("GET", "/v1/whoami", { token: null });
      expect(anonymous.status).toBe(401);
      expect(((await anonymous.json()) as { code: string }).code).toBe("unauthenticated");
      const admin = await app.call("GET", "/v1/whoami", { token: ADMIN });
      expect(await admin.json()).toEqual({ name: "admin", scope: "admin", admin: true });
    } finally {
      app.close();
    }
  });

  test("sends anything that is not a GET back to the API, which answers 404", async () => {
    const app = mount();
    try {
      const post = await app.call("POST", "/app/anything", { body: {} });
      expect(post.status).toBe(404);
      expect(((await post.json()) as { code: string }).code).toBe("not_found");
    } finally {
      app.close();
    }
  });

  test("serves the app at /app/ and every route the client draws itself", async () => {
    const app = mount();
    try {
      const bare = await fetch(`${app.base}/app`, { redirect: "manual" });
      expect(bare.status).toBe(301);
      expect(bare.headers.get("location")).toBe(`${app.base}/app/`);

      const index = await app.call("GET", "/app/");
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toContain("text/html");
      expect(index.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(index.headers.get("x-content-type-options")).toBe("nosniff");
      const html = await index.text();
      expect(html).toContain('<main id="view"');
      expect(html).toContain('<script type="module" src="/app/assets/app.js">');
      expect(html).toContain("noscript");

      // A deep link survives a reload: it is the same document, and the client routes from the path.
      const deep = await app.call("GET", "/app/runs/20261104T101500Z-3fa9c2d1");
      expect(deep.status).toBe(200);
      expect(await deep.text()).toBe(html);

      const etag = index.headers.get("etag");
      expect(etag).toBeTruthy();
      const cached = await app.call("GET", "/app/");
      expect(cached.status).toBe(200);
      const notModified = await fetch(`${app.base}/app/`, { headers: { "if-none-match": etag! } });
      expect(notModified.status).toBe(304);
    } finally {
      app.close();
    }
  });

  test("serves the client as JavaScript the browser can run, and the stylesheet that styles it", async () => {
    const app = mount();
    try {
      const modules = ["app", "api", "dom", "yaml", "model", "graph", "editor", "run-shared", "runs-list", "run-page", "blocks", "logs"];
      for (const name of modules) {
        const response = await app.call("GET", `/app/assets/${name}.js`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/javascript");
        const source = await response.text();
        // The transpiled module: no TypeScript left in it, and no import attribute a browser would
        // choke on, and it still says which module it is.
        expect(source).not.toContain("with {");
        expect(source).not.toContain("interface ");
        expect(source.length).toBeGreaterThan(0);
      }
      const appJs = await (await app.call("GET", "/app/assets/app.js")).text();
      expect(appJs).toContain('from "./editor.js"');

      const css = await app.call("GET", "/app/assets/style.css");
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toContain("text/css");
      const sheet = await css.text();
      expect(sheet).toContain("--paper: #e4e2db");
      expect(sheet).toContain("--ink: #141414");
      // The fonts are routes of this app, served from the bytes embedded beside it.
      expect(sheet).toContain('url("/app/assets/fonts/anybody.woff2")');
    } finally {
      app.close();
    }
  });

  test("the three faces come back as fonts, with the bytes that were embedded", async () => {
    const app = mount();
    try {
      for (const [name, file] of [
        ["anybody.woff2", "anybody.woff2"],
        ["atkinson-next.woff2", "atkinson-next.woff2"],
        ["atkinson-mono.woff2", "atkinson-mono.woff2"],
      ] as const) {
        const response = await app.call("GET", `/app/assets/fonts/${name}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("font/woff2");
        expect(response.headers.get("cache-control")).toContain("immutable");
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("wOF2");
        const source = await Bun.file(join(import.meta.dir, "../fonts", file)).bytes();
        expect(bytes.length).toBe(source.length);
      }
    } finally {
      app.close();
    }
  });

  test("the font licence ships where a person can find it", async () => {
    const app = mount();
    try {
      const ofl = await app.call("GET", "/app/OFL.txt");
      expect(ofl.status).toBe(200);
      expect(ofl.headers.get("content-type")).toContain("text/plain");
      expect(await ofl.text()).toContain("SIL OPEN FONT LICENSE");
    } finally {
      app.close();
    }
  });

  test("an asset that is not there is a 404, not the app", async () => {
    const app = mount();
    try {
      const missing = await app.call("GET", "/app/assets/nothing.js");
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { code: string }).code).toBe("not_found");
    } finally {
      app.close();
    }
  });
});

describe("the screens' calls, through the one handler", () => {
  test("word-report can be published, validated, stored, started and followed without leaving the app", async () => {
    expect(existsSync(join(EXAMPLES, "word-report.yaml"))).toBe(true);
    const app = mount();
    try {
      // What the Blocks screen does for each file: post the exact bytes under the name it declares.
      const blocks = ["generate-corpus", "check-corpus", "count-words", "render-report"];
      for (const name of blocks) {
        const content = await Bun.file(join(EXAMPLES, `${name}.sh`)).text();
        const published = await app.call("POST", `/v1/blocks/${name}/versions`, { body: { content } });
        expect(published.status).toBe(201);
      }
      const listed = await (await app.call("GET", "/v1/blocks/count-words")).json();
      expect(listed).toMatchObject({ name: "count-words", latest: 1 });

      // The editor reads a block's contract from its own bytes, the way the Blocks screen does.
      const content = await app.call("GET", "/v1/blocks/count-words/latest/content");
      expect(content.status).toBe(200);
      expect(await content.text()).toContain("# name: count-words");

      // The example addresses its blocks as files beside the pipeline; the library is what the API
      // runs, so the editor's "use the library version" rewrite is what a person would do here.
      const yaml = (await Bun.file(join(EXAMPLES, "word-report.yaml")).text()).replace(
        /uses: \.\/([a-z-]+)\.sh/g,
        (_all, name: string) => `uses: ${name}@1`,
      );

      const invalid = await app.call("POST", "/v1/pipelines/validate", {
        body: { yaml: yaml.replace("count-words@1", "count-words@9") },
      });
      const report = (await invalid.json()) as { valid: boolean; issues: { code: string; path: string }[] };
      expect(report.valid).toBe(false);
      expect(report.issues.some((issue) => issue.code === "block_not_found" && issue.path === "steps.count.uses")).toBe(true);

      const valid = await (await app.call("POST", "/v1/pipelines/validate", { body: { yaml } })).json();
      expect(valid).toEqual({ valid: true, issues: [] });

      const saved = await app.call("POST", "/v1/pipelines/word-report/versions", { body: { yaml } });
      expect(saved.status).toBe(201);
      const stored = (await saved.json()) as { version: number; name: string };
      expect(stored).toMatchObject({ version: 1, name: "word-report" });
      const history = await (await app.call("GET", "/v1/pipelines/word-report")).json();
      expect(history).toMatchObject({ name: "word-report", latest: 1 });

      const started = await app.call("POST", "/v1/runs", { body: { pipeline: "word-report", version: 1, inputs: { lines: 120 } } });
      expect(started.status).toBe(201);
      const run = (await started.json()) as { id: string; status: string; steps: Record<string, unknown> };
      expect(run.status).toBe("running");

      // The run screen polls GET /v1/runs/:id until the run is final, then stops.
      let record = run as unknown as { id: string; status: string; steps: Record<string, { status: string; attempts: { n: number }[] }> };
      const deadline = Date.now() + 60_000;
      while (record.status === "running" && Date.now() < deadline) {
        await Bun.sleep(100);
        record = (await (await app.call("GET", `/v1/runs/${run.id}`)).json()) as typeof record;
      }
      expect(record.status).toBe("succeeded");
      expect(Object.keys(record.steps)).toEqual(["generate", "check", "count", "report"]);

      // The log pane follows an attempt by offset and passes the returned offset back.
      const first = (await (await app.call("GET", `/v1/runs/${run.id}/logs/generate/1?offset=0`)).json()) as {
        next_offset: number;
        text: string;
        offset: number;
      };
      expect(first.offset).toBe(0);
      expect(first.text.length).toBeGreaterThan(0);
      expect(first.next_offset).toBe(new TextEncoder().encode(first.text).length);
      const rest = (await (await app.call("GET", `/v1/runs/${run.id}/logs/generate/1?offset=${first.next_offset}`)).json()) as {
        text: string;
        offset: number;
      };
      expect(rest.offset).toBe(first.next_offset);
      expect(rest.text).toBe("");

      const list = (await (await app.call("GET", "/v1/runs")).json()) as { id: string; status: string }[];
      expect(list.map((entry) => entry.id)).toContain(run.id);
    } finally {
      app.close();
    }
  });

  test("a read-only token is refused the writes the screens would otherwise offer", async () => {
    const app = mount();
    try {
      const created = (await (await app.call("POST", "/v1/tokens", { body: { name: "reader", scope: "read" } })).json()) as {
        token: string;
      };
      const whoami = await app.call("GET", "/v1/whoami", { token: created.token });
      expect(await whoami.json()).toEqual({ name: "reader", scope: "read", admin: false });

      const refused = await app.call("POST", "/v1/pipelines/anything/versions", { token: created.token, body: { yaml: "name: anything\n" } });
      expect(refused.status).toBe(403);
      const body = (await refused.json()) as { code: string; message: string };
      expect(body.code).toBe("forbidden");
      expect(body.message.length).toBeGreaterThan(0);
    } finally {
      app.close();
    }
  });
});
