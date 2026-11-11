// A real browser, for `browser.test.ts`. The client tests beside this file run against
// `client.testkit.ts`, which is a stand-in DOM: it applies no CSS and enforces no CSP, so a screen
// can pass there while it is broken on a phone, or while its own stylesheet is refused by its own
// Content-Security-Policy. This file is the other half: it starts the server the image runs, drives
// the Chromium that is already on this machine, and reports what that browser saw.
//
// It is a `.testkit.ts` file for the same reason `client.testkit.ts` is: the asset table test knows
// it is never shipped. Everything here runs in Node, not in the page — puppeteer is a Node library,
// and the only code that runs inside the browser is the small `page.evaluate` bodies below.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch } from "puppeteer-core";
import type { Browser, ElementHandle, Page } from "puppeteer-core";

/** The two widths the review measured at: a laptop and a phone. */
export interface Viewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

export const VIEWPORTS: readonly Viewport[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

/**
 * The browser to drive, or null when there is none.
 *
 * `BASHREACTOR_BROWSER` names a binary outright, which is how a machine whose Chromium is not on
 * PATH says so. Otherwise the usual names are looked for on PATH. GitHub's ubuntu runner images ship
 * both Google Chrome and Chromium, so on CI this finds one without an install step; the workflow
 * still checks, because a browser test that silently skips is a browser test that proves nothing.
 */
export function findBrowser(): string | null {
  const named = process.env.BASHREACTOR_BROWSER;
  if (named !== undefined && named !== "") {
    if (!existsSync(named)) throw new Error(`BASHREACTOR_BROWSER points at "${named}", which does not exist`);
    return named;
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir === "") continue;
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
      const path = join(dir, name);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/** Why a browser test is skipped when this machine has no browser at all. */
export const NO_BROWSER =
  "no Chromium or Chrome on PATH: install one, or set BASHREACTOR_BROWSER to the binary. The CI job fails rather than skip.";

export async function openBrowser(): Promise<Browser> {
  const executablePath = findBrowser();
  if (executablePath === null) throw new Error(NO_BROWSER);
  return await launch({
    executablePath,
    headless: true,
    // --no-sandbox because a container without user namespaces cannot run Chromium's setuid helper,
    // and the page under test is this repo's own server, not somebody else's site.
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

/** What a page said that means the screen is not clean. */
export interface Watch {
  /** Uncaught exceptions, CSP refusals and anything else the page logged as an error. */
  readonly pageErrors: string[];
  /** Every response of 400 or worse, with its URL. */
  readonly http: { status: number; url: string }[];
  /** Every response for a file under `/app/assets/`, which is the browser's whole filesystem. */
  readonly assets: { status: number; url: string }[];
  /**
   * Everything that has to be empty for a screen to pass. `expectedHttp` is the list of status codes
   * the test itself asked for — a refused action answers 409, and the browser logs that like any
   * other failed request, so the test declares it instead of the watcher guessing.
   */
  problems(expectedHttp?: readonly number[]): string[];
}

export function watch(page: Page): Watch {
  const pageErrors: string[] = [];
  const http: { status: number; url: string }[] = [];
  const assets: { status: number; url: string }[] = [];

  page.on("pageerror", (error) => pageErrors.push(`uncaught: ${error instanceof Error ? error.message : String(error)}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // The browser's own echo of a response it could not load. `http` already carries the status and
    // the URL, which is the half a test can honestly declare as expected; the rest of the console is
    // the app's own voice and has to stay empty.
    if (text.startsWith("Failed to load resource")) return;
    pageErrors.push(`console: ${text}`);
  });
  page.on("requestfailed", (request) => pageErrors.push(`request failed: ${request.url()} ${request.failure()?.errorText ?? ""}`));
  page.on("response", (response) => {
    if (response.url().includes("/app/assets/")) assets.push({ status: response.status(), url: response.url() });
    if (response.status() >= 400) http.push({ status: response.status(), url: response.url() });
  });

  return {
    pageErrors,
    http,
    assets,
    problems: (expectedHttp = []) => {
      const out = [...pageErrors];
      for (const failure of http) {
        // A missing asset is never expected: the ES module graph stops and the screen sits on
        // "Loading." forever, which is exactly the failure only a browser can see.
        if (failure.url.includes("/app/assets/")) out.push(`asset ${failure.status}: ${failure.url}`);
        else if (!expectedHttp.includes(failure.status)) out.push(`http ${failure.status}: ${failure.url}`);
      }
      return out;
    },
  };
}

/** Open a page at the given viewport with a watcher already listening. */
export async function openPage(browser: Browser, viewport: Viewport): Promise<{ page: Page; watch: Watch }> {
  const page = await browser.newPage();
  await page.setViewport({ width: viewport.width, height: viewport.height });
  // Shorter than bun's own per-test timeout, so a screen that never drew is reported as the screen
  // that never drew, with what the page said, and not as a harness timeout.
  page.setDefaultTimeout(15_000);
  return { page, watch: watch(page) };
}

/** The block and the pipeline the tests drive. Both are small on purpose: a smoke test should not
 * wait on real work, it should wait on the screen. */
export const SHOUT_BLOCK = `#!/usr/bin/env bash
# ---
# name: shout
# description: Print one line, and the same line in upper case.
# inputs:
#   text:
#     type: string
#     description: The line to print.
#     default: hello
# outputs:
#   shout:
#     type: string
#     description: The same line, upper case.
# ---
echo "text=$INPUT_TEXT"
printf '%s' "$(printf '%s' "$INPUT_TEXT" | tr a-z A-Z)" > "$OUTPUT_SHOUT"
`;

export const SHOUT_PIPELINE = `name: shout-report
description: Print one line, then shout it.

inputs:
  text:
    type: string
    description: The line.
    default: hello

steps:
  quiet:
    name: Print the line
    uses: shout@1
    with:
      text: \${{ inputs.text }}

  loud:
    name: Shout it
    uses: shout@1
    needs: [quiet]
    with:
      text: \${{ steps.quiet.outputs.shout }}

outputs:
  shout: \${{ steps.loud.outputs.shout }}
`;

export interface TestApp {
  readonly base: string;
  readonly token: string;
  /** The data directory, so a test can read what a run left on disk the way the review did. */
  readonly home: string;
  /** A call to /v1 with the admin token, for setting a screen up and checking what it left behind. */
  api<T = unknown>(path: string, init?: RequestInit): Promise<{ status: number; body: T }>;
  stop(): Promise<void>;
}

/**
 * The server the image runs — `apps/web/src/server.ts`, the API with the UI mounted in front of it —
 * as its own process on a free port, with the block and the pipeline already stored and one run
 * already finished. A test that needs a different state makes it through the API, the way every
 * client does.
 */
export async function startApp(): Promise<TestApp> {
  const home = mkdtempSync(join(tmpdir(), "bashreactor-browser-"));
  const token = "browser_smoke_admin";
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "server.ts")], {
    env: { ...process.env, PORT: "0", BASHREACTOR_HOME: home, BASHREACTOR_ADMIN_TOKEN: token, BASHREACTOR_VERSION: "browser-test" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  let port: string | undefined;
  while (port === undefined) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
    port = /listening on :(\d+)/.exec(seen)?.[1];
  }
  // The rest of stdout and all of stderr have to keep draining, or the process blocks on a full pipe.
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      seen += decoder.decode(value, { stream: true });
    }
  })();
  void (async () => {
    const err = proc.stderr.getReader();
    for (;;) {
      const { value, done } = await err.read();
      if (done) return;
      seen += decoder.decode(value, { stream: true });
    }
  })();
  if (port === undefined) throw new Error(`the server did not say its port: ${seen}`);

  const base = `http://127.0.0.1:${port}`;
  const api = async <T,>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${base}/v1/${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    });
    const text = await response.text();
    return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as T };
  };

  const block = await api("blocks/shout/versions", { method: "POST", body: JSON.stringify({ content: SHOUT_BLOCK }) });
  if (block.status !== 201) throw new Error(`could not store the shout block: ${JSON.stringify(block)}`);
  const pipeline = await api("pipelines/shout-report/versions", { method: "POST", body: JSON.stringify({ yaml: SHOUT_PIPELINE }) });
  if (pipeline.status !== 201) throw new Error(`could not store the pipeline: ${JSON.stringify(pipeline)}`);

  return {
    base,
    token,
    home,
    api,
    stop: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** The finished run every screen that shows a run can use. */
export interface SeededRun {
  readonly id: string;
  readonly status: string;
}

/** Start one run through the API and wait for it to leave `running`. */
export async function startRun(app: TestApp, inputs: Record<string, unknown> = {}): Promise<SeededRun> {
  const started = await app.api<{ id: string; status: string }>("runs", {
    method: "POST",
    body: JSON.stringify({ pipeline: "shout-report", inputs }),
  });
  if (started.status !== 201) throw new Error(`could not start the run: ${JSON.stringify(started.body)}`);
  return await waitForRun(app, started.body.id);
}

/** Read a run until it leaves `running`, which is how long a block takes to run. */
export async function waitForRun(app: TestApp, id: string): Promise<SeededRun> {
  for (let tick = 0; tick < 600; tick++) {
    const run = await app.api<{ status: string }>(`runs/${id}`);
    if (run.body.status !== "running") return { id, status: run.body.status };
    await Bun.sleep(50);
  }
  throw new Error(`run ${id} never finished`);
}

/** Sign in through the gate, the way a person does: type the token, press the button. */
export async function signIn(page: Page, app: TestApp, pageWatch?: Watch): Promise<void> {
  await page.goto(`${app.base}/app/`, { waitUntil: "networkidle0" });
  const gate = await page.waitForSelector("#gate-token", { visible: true, timeout: 10_000 }).catch(() => null);
  if (gate === null) {
    // The usual reason is the asset table: a module it does not know about is a 404, the ES module
    // graph stops, and `#view` never gets past "Loading."
    const said = pageWatch === undefined ? "nothing recorded" : pageWatch.problems().join("\n");
    throw new Error(`the gate never drew on ${app.base}/app/. What the page said:\n${said}`);
  }
  await page.type("#gate-token", app.token);
  await page.click(".gate__form button[type=submit]");
  // The sidebar is hidden below 940 px and the top bar takes its place, so waiting for `.nav` to be
  // visible failed on a phone. The identity column is filled on both layouts once the token works.
  const signedIn = await page
    .waitForFunction(
      () => (document.querySelector("#who")?.textContent ?? "").trim() !== "" && document.querySelector("#gate-token") === null,
      { timeout: 10_000 },
    )
    .catch(() => null);
  if (signedIn === null) throw new Error(`signing in as ${app.token.slice(0, 6)}... left the gate up on ${app.base}/app/`);
}

/** Go somewhere in the app and wait until the screen has stopped drawing. */
export async function goto(page: Page, app: TestApp, path: string): Promise<void> {
  await page.goto(`${app.base}${path}`, { waitUntil: "networkidle0" });
}

/** The text of the first element matching `selector`, or null when there is none. */
export function textOf(page: Page, selector: string): Promise<string | null> {
  return page.evaluate((sel: string) => document.querySelector(sel)?.textContent ?? null, selector);
}

/** The text of every element matching `selector`, in document order. */
export function textsOf(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((sel: string) => [...document.querySelectorAll(sel)].map((node) => node.textContent ?? ""), selector);
}

/** What a field holds, which is not its text content: a textarea's value is a property, not a child. */
export function valueOf(page: Page, selector: string): Promise<string | null> {
  return page.evaluate((sel: string) => {
    const node = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
    return node === null ? null : node.value;
  }, selector);
}

/**
 * The control a person would press, found by the words on it.
 *
 * Matching is exact and case-sensitive on purpose: a screen that offers "Retry" and "Retry 2 steps"
 * has to be clicked by its own words, not by whichever one contains the other.
 */
export async function control(page: Page, label: string): Promise<ElementHandle<Element>> {
  const found = await page.evaluateHandle((text: string) => {
    const nodes = [...document.querySelectorAll("button, a.btn")];
    return nodes.find((node) => (node.textContent ?? "").trim() === text) ?? null;
  }, label);
  const handle = found.asElement() as ElementHandle<Element> | null;
  if (handle === null) {
    const labels = await page.evaluate(() => [...document.querySelectorAll("button, a.btn")].map((n) => (n.textContent ?? "").trim()).filter(Boolean));
    throw new Error(`no control labelled "${label}" on ${page.url()}. It offers: ${labels.join(" | ")}`);
  }
  return handle;
}

/** Press it with the mouse, which is what a person does: a hidden or covered control fails here. */
export async function press(page: Page, label: string): Promise<void> {
  await (await control(page, label)).click();
}

/**
 * Wait for a selector to exist, with a timeout short enough that a screen that never drew reads as
 * a failure rather than as a hang. Visibility is a separate assertion, so that a screen that is
 * there but hidden fails with the reason and not with a timeout.
 */
export function waitFor(page: Page, selector: string, timeout = 10_000): Promise<unknown> {
  return page.waitForSelector(selector, { timeout }).catch((error: unknown) => {
    throw new Error(`${selector} never appeared on ${page.url()}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** Whether a person could see it: laid out, on screen, and not hidden by CSS. */
export async function visible(page: Page, selector: string): Promise<{ shown: boolean; box: { width: number; height: number } | null }> {
  return await page.evaluate((sel: string) => {
    const node = document.querySelector(sel);
    if (node === null) return { shown: false, box: null };
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const laidOut = rect.width > 0 && rect.height > 0;
    const painted = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    const onScreen = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    return { shown: laidOut && painted && onScreen && !node.hasAttribute("hidden"), box: { width: Math.round(rect.width), height: Math.round(rect.height) } };
  }, selector);
}

/** What the stylesheet actually did to the page, as one round trip. */
export interface StyleFacts {
  bodyBackground: string;
  bodyColor: string;
  bodyFont: string;
  titleFont: string;
  titleSizePx: number;
  codeFont: string;
  buttonHeightPx: number;
  buttonBorderPx: number;
  statusRegionWidthPx: number;
  scrollWidth: number;
  clientWidth: number;
  /** Whether the browser says this pointer is a finger, which decides 44 px or 32 px controls. */
  coarsePointer: boolean;
  /** The widest things past the right edge, for the message when the page does overflow. */
  widest: string[];
  faces: { text: boolean; mono: boolean; display: boolean };
}

export function styleFacts(page: Page): Promise<StyleFacts> {
  return page.evaluate(() => {
    // eslint-disable-next-line unicorn/consistent-function-scoping -- this whole body runs in the page
    const style = (selector: string): CSSStyleDeclaration | null => {
      const node = document.querySelector(selector);
      return node === null ? null : getComputedStyle(node);
    };
    // eslint-disable-next-line unicorn/consistent-function-scoping -- as above
    const size = (selector: string): number => {
      const node = document.querySelector(selector);
      return node === null ? 0 : Math.round(node.getBoundingClientRect().height);
    };
    const edge = document.documentElement.clientWidth;
    const widest = [...document.querySelectorAll("body *")]
      .map((node) => ({ node, right: node.getBoundingClientRect().right }))
      .filter((row) => row.right > edge + 1)
      .toSorted((a, b) => b.right - a.right)
      .slice(0, 3)
      .map((row) => `${row.node.tagName.toLowerCase()}${row.node.className === "" ? "" : `.${String(row.node.className).split(" ").join(".")}`} right=${Math.round(row.right)}`);
    return {
      bodyBackground: style("body")?.backgroundColor ?? "",
      bodyColor: style("body")?.color ?? "",
      bodyFont: style("body")?.fontFamily ?? "",
      titleFont: style(".title")?.fontFamily ?? "",
      titleSizePx: Number.parseFloat(style(".title")?.fontSize ?? "0"),
      codeFont: style("code")?.fontFamily ?? style(".mono")?.fontFamily ?? "",
      // The sidebar's Sign out is deliberately a text button, so it is not the control the scale is
      // measured on. A real button is the first one with a border.
      buttonHeightPx: size(".btn:not(.btn--text)"),
      buttonBorderPx: Number.parseFloat(style(".btn:not(.btn--text)")?.borderTopWidth ?? "0"),
      statusRegionWidthPx: Math.round(document.querySelector("#announce")?.getBoundingClientRect().width ?? -1),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: edge,
      coarsePointer: window.matchMedia("(pointer: coarse)").matches,
      widest,
      faces: {
        text: document.fonts.check('16px "Atkinson Hyperlegible Next"'),
        mono: document.fonts.check('16px "Atkinson Hyperlegible Mono"'),
        display: document.fonts.check('16px "Anybody"'),
      },
    };
  });
}

/**
 * The design contract from AGENTS.md, measured in the browser rather than read off the stylesheet:
 * paper and ink, the two faces actually loaded, a display title, a button you can press with a
 * thumb, and a page that does not scroll sideways. Every one of these is invisible to a DOM
 * stand-in, because all four depend on CSS being served, parsed and applied.
 */
export function designProblems(facts: StyleFacts, viewport: Viewport): string[] {
  const problems: string[] = [];
  if (facts.bodyBackground !== "rgb(228, 226, 219)") problems.push(`paper: body background is ${facts.bodyBackground}, expected rgb(228, 226, 219)`);
  if (facts.bodyColor !== "rgb(20, 20, 20)") problems.push(`ink: body colour is ${facts.bodyColor}, expected rgb(20, 20, 20)`);
  if (!facts.bodyFont.startsWith('"Atkinson Hyperlegible Next"')) problems.push(`text face: body is ${facts.bodyFont}`);
  if (!facts.faces.text) problems.push("the text face never loaded");
  if (!facts.faces.display) problems.push("the display face never loaded");
  // A screen with no code on it does not ask the browser to load the mono face. Where there is code,
  // the face has to be loaded and has to be the mono face.
  if (facts.codeFont !== "" && !facts.faces.mono) problems.push("the mono face never loaded");
  if (facts.codeFont !== "" && !facts.codeFont.startsWith('"Atkinson Hyperlegible Mono"')) problems.push(`code face: code is ${facts.codeFont}`);
  if (facts.statusRegionWidthPx !== 1) problems.push(`the screen-reader region is ${facts.statusRegionWidthPx}px wide, so it is not hidden by CSS`);
  if (facts.buttonBorderPx < 2) problems.push(`a button has a ${facts.buttonBorderPx}px border, so the stylesheet is not being applied`);
  const minimumControl = facts.coarsePointer ? 44 : 32;
  if (facts.buttonHeightPx > 0 && facts.buttonHeightPx < minimumControl) {
    problems.push(`a button is ${facts.buttonHeightPx}px tall, under the ${minimumControl}px the design gives it`);
  }
  if (facts.titleSizePx > 0 && (facts.titleSizePx < 28 || !facts.titleFont.startsWith("Anybody"))) {
    problems.push(`the display title is ${facts.titleFont} at ${facts.titleSizePx}px; display text is Anybody at 28px or more`);
  }
  if (facts.scrollWidth > facts.clientWidth) {
    problems.push(`the page scrolls sideways at ${viewport.width}px: scrollWidth ${facts.scrollWidth} > ${facts.clientWidth} [${facts.widest.join(", ")}]`);
  }
  return problems;
}
