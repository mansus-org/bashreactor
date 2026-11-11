// Screenshots of every screen, at a desktop and a phone width, against a throwaway server filled by
// seed.ts. It also prints every page error and every failed request it saw, so a run of it is a smoke
// test even for someone who cannot look at the pictures.
//
//   bun apps/web/scripts/screens.ts [out-dir]          every screen
//   SCREENS=runs,run-failed bun apps/web/scripts/screens.ts   only those
//
// Needs Chromium or Chrome on PATH (or BASHREACTOR_BROWSER), and the runtimes the engine checks for.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, type Page } from "puppeteer-core";
import { seed } from "./seed.ts";

const root = join(import.meta.dir, "../../..");
const out = process.argv[2] ?? join(tmpdir(), `bashr-screens-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const only = (process.env.SCREENS ?? "").split(",").filter((name) => name !== "");
const token = "br_screens_admin";
const port = 20000 + Math.floor(Math.random() * 20000);
const url = `http://127.0.0.1:${port}`;
const home = mkdtempSync(join(tmpdir(), "bashr-screens-home-"));

function findBrowser(): string {
  const named = process.env.BASHREACTOR_BROWSER;
  if (named !== undefined && named !== "") return named;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
      if (dir !== "" && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  throw new Error("no Chromium or Chrome on PATH; set BASHREACTOR_BROWSER");
}

/**
 * The worked example's `count-words` block runs Python through uv, and uv wants a Python on PATH.
 * NixOS has none by default and cannot run the builds uv downloads, so a Python from the Nix store
 * goes on the server's PATH when there is one. The engine hands its PATH to blocks verbatim (SPEC 2.6).
 */
function pathWithPython(): string {
  const path = process.env.PATH ?? "";
  if (Bun.which("python3") !== null || !existsSync("/nix/store")) return path;
  const found = new Bun.Glob("*-python3-3.1[0-9]*/bin/python3").scanSync({ cwd: "/nix/store", onlyFiles: false });
  for (const hit of found) return `/nix/store/${hit.replace(/\/python3$/, "")}:${path}`;
  return path;
}

const server = Bun.spawn(["bun", join(root, "apps/web/src/server.ts")], {
  env: {
    ...process.env,
    PATH: pathWithPython(),
    BASHREACTOR_HOME: home,
    BASHREACTOR_ADMIN_TOKEN: token,
    BASHREACTOR_VERSION: "screens",
    PORT: String(port),
  },
  stdout: "ignore",
  stderr: "pipe",
});

const problems: string[] = [];
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (i > 100) throw new Error(`the server never answered: ${await new Response(server.stderr).text()}`);
    await Bun.sleep(100);
  }
  const runs = await seed(url, token);
  const screens: [string, string][] = [
    ["dashboard", "/app/"],
    ["runs", "/app/runs"],
    ["runs-filtered", "/app/runs?status=failed,cancelled"],
    ["run-succeeded", `/app/runs/${runs.succeeded}`],
    ["run-failed", `/app/runs/${runs.failed}`],
    ["run-retried", `/app/runs/${runs.retried}`],
    ["run-running", `/app/runs/${runs.running}`],
    ["run-waiting", `/app/runs/${runs.waiting}`],
    ["run-steps", `/app/runs/${runs.failed}?tab=steps`],
    ["run-graph", `/app/runs/${runs.failed}?tab=graph`],
    ["run-io", `/app/runs/${runs.retried}?tab=io`],
    ["run-files", `/app/runs/${runs.succeeded}?tab=files`],
    ["pipelines", "/app/pipelines"],
    ["pipeline", "/app/pipelines/word-report"],
    ["pipeline-definition", "/app/pipelines/word-report?tab=definition"],
    ["pipeline-inputs", "/app/pipelines/word-report?tab=inputs"],
    ["editor", "/app/pipelines/word-report/edit"],
    ["editor-new", "/app/pipelines-new"],
    ["blocks", "/app/blocks"],
    ["block", "/app/blocks/count-words"],
    ["block-source", "/app/blocks/count-words?tab=source"],
    ["writer", "/app/blocks/count-words/edit"],
    ["settings", "/app/settings"],
  ];
  mkdirSync(out, { recursive: true });
  const browser = await launch({
    executablePath: findBrowser(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  // One set of listeners per page, reading which screen is up: removing listeners from a Page also
  // removes puppeteer's own, and the next navigation then dies with "frame was detached".
  let current = "";
  const watch = (page: Page): void => {
    page.on("pageerror", (error) => problems.push(`${current}: page error: ${String(error)}`));
    page.on("console", (message) => {
      if (current !== "" && message.type() === "error") problems.push(`${current}: console: ${message.text()}`);
    });
    page.on("response", (response) => {
      if (current !== "" && response.status() >= 400) problems.push(`${current}: ${response.status()} ${response.url()}`);
    });
  };
  try {
    for (const [width, height, suffix] of [
      [1440, 900, "1440"],
      [390, 844, "390"],
    ] as const) {
      const page = await browser.newPage();
      await page.setViewport({ width, height });
      watch(page);
      current = "";
      await page.goto(`${url}/app/`);
      await page.evaluate(
        (base, secret) => {
          localStorage.setItem("bashreactor.url", base);
          localStorage.setItem("bashreactor.token", secret);
        },
        url,
        token,
      );
      for (const [name, path] of screens) {
        if (only.length > 0 && !only.includes(name)) continue;
        const screen = `${name}-${suffix}`;
        current = screen;
        await page.goto(`${url}${path}`, { waitUntil: "domcontentloaded" });
        // The screens poll, so the network is never idle; this is long enough for a first answer.
        await Bun.sleep(1500);
        const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        if (wide) problems.push(`${screen}: scrolls sideways`);
        await page.screenshot({ path: join(out, `${screen}.png`), fullPage: true });
      }
      await page.close();
    }
    if (only.length === 0 || only.includes("signin")) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(`${url}/app/`, { waitUntil: "domcontentloaded" });
      await Bun.sleep(800);
      await page.screenshot({ path: join(out, "signin-1440.png"), fullPage: true });
      await page.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
  await server.exited;
  rmSync(home, { recursive: true, force: true });
}

console.log(`screens in ${out}`);
if (problems.length > 0) {
  console.log(`\n${problems.length} problems:`);
  for (const problem of problems) console.log(`  ${problem}`);
  process.exitCode = 1;
}
