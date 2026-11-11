// The screens in a real browser, at a laptop and a phone width. This is the half of the client tests
// that `client.testkit.ts` cannot be: the CSS is served, parsed and applied, the app's own
// Content-Security-Policy is in force, and a control that is hidden cannot be pressed.
//
// Every test drives the server the image runs (`apps/web/src/server.ts`) with the block and the
// pipeline stored, and fails on anything the page logged as an error. Where a test needs an HTTP
// status of its own — a refused action answers 409 — it says so, because the browser logs a refused
// request the same way it logs a broken one.
//
// Four tests below are `test.skip`, each with the defect it would fail on and who owns the file. They
// are the reason this ticket exists: defects that only exist once CSS and CSP are applied, in files
// another task is editing. Un-skip one to watch it fail.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "puppeteer-core";
import {
  VIEWPORTS,
  designProblems,
  findBrowser,
  goto,
  openBrowser,
  openPage,
  press,
  signIn,
  startApp,
  startRun,
  styleFacts,
  textsOf,
  waitForRun,
  textOf,
  valueOf,
  waitFor,
  visible,
  watch,
  type SeededRun,
  type TestApp,
  type Viewport,
} from "./browser.testkit.ts";

/**
 * With no browser on PATH the whole file skips and says why. The CI job is written so it cannot get
 * here without one: a browser test that skips quietly is a browser test that proves nothing.
 */
const missing = findBrowser() === null;
const suite = missing ? describe.skip : describe;

const DESKTOP: Viewport = VIEWPORTS.find((entry) => entry.name === "desktop")!;

let app: TestApp;
let browser: Browser;
let run: SeededRun;

beforeAll(async () => {
  if (missing) return;
  app = await startApp();
  browser = await openBrowser();
  run = await startRun(app, { text: "hello there" });
  await seedWorkedExample(app);
}, 120_000);

afterAll(async () => {
  if (missing) return;
  await browser.close();
  await app.stop();
});

/** A signed-in page at the given size, with the watcher listening from the first request. */
async function screen(viewport: Viewport, path = "/app/"): Promise<{ page: Page; watch: ReturnType<typeof watch> }> {
  const opened = await openPage(browser, viewport);
  await signIn(opened.page, app, opened.watch);
  if (path !== "/app/") await goto(opened.page, app, path);
  return opened;
}

/** Change part of what is in the YAML pane, which is what an edit is. */
function replaceInYaml(page: Page, from: string, to: string): Promise<unknown> {
  return page.evaluate((before: string, after: string) => {
    const pane = document.querySelector("textarea#doc") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(pane, pane.value.replace(before, after));
    pane.dispatchEvent(new Event("input", { bubbles: true }));
  }, from, to);
}

/** Replace the YAML pane's contents the way a paste does, and let the app see the input event. */
function pasteYaml(page: Page, yaml: string): Promise<unknown> {
  return page.evaluate((text: string) => {
    const pane = document.querySelector("textarea#doc") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(pane, text);
    pane.dispatchEvent(new Event("input", { bubbles: true }));
  }, yaml);
}

/** The blocks of the worked example, which the pipeline names by path. */
const EXAMPLE_BLOCKS = ["generate-corpus", "check-corpus", "count-words", "render-report"];

function exampleFile(kind: "yaml" | "sh", name: string): string {
  return readFileSync(join(import.meta.dir, "..", "..", "..", "..", "docs", "examples", `${name}.${kind}`), "utf8");
}

/**
 * `docs/examples/word-report` stored in this server, because the port names that break mid-word at
 * desktop width (`total_words`, `interrupt_at`) only exist in a real document.
 *
 * The example names its blocks by path, which is what `pipelines validate` stages; stored in the
 * library they become references, and the editor resolves both the same way.
 */
async function seedWorkedExample(server: TestApp): Promise<void> {
  for (const name of EXAMPLE_BLOCKS) {
    const stored = await server.api(`blocks/${name}/versions`, { method: "POST", body: JSON.stringify({ content: exampleFile("sh", name) }) });
    if (stored.status !== 201) throw new Error(`could not store ${name}: ${JSON.stringify(stored.body)}`);
  }
  const yaml = exampleFile("yaml", "word-report").replace(/uses: \.\/([\w-]+)\.sh/g, (_match, block: string) => `uses: ${block}@1`);
  const stored = await server.api("pipelines/word-report/versions", { method: "POST", body: JSON.stringify({ yaml }) });
  if (stored.status !== 201) throw new Error(`could not store word-report: ${JSON.stringify(stored.body)}`);
}

suite("the app over the wire", () => {
  test(
    "the UI is served with the CSP the browser tests depend on",
    async () => {
      const response = await fetch(`${app.base}/app/`);
      expect(response.status).toBe(200);
      const csp = response.headers.get("content-security-policy") ?? "";
      // Without this header in force, "no CSP violations in the console" would prove nothing at all.
      expect(csp).toContain("style-src 'self'");
      expect(csp).toContain("script-src 'self'");
    },
    30_000,
  );

  test(
    "the page's own files all come back",
    async () => {
      // The asset table is the browser's whole filesystem: one module the table does not know about
      // is a 404, the ES module graph stops, and the screen sits on "Loading." forever. No typecheck
      // can see that, and neither can a DOM stand-in that never asks for a file.
      const { page, watch: pageWatch } = await screen(DESKTOP);
      const asked = pageWatch.assets.map((row) => row.url.replace(`${app.base}/app/assets/`, ""));
      for (const file of ["app.js", "api.js", "editor.js", "style.css", "fonts/atkinson-next.woff2"]) {
        expect(asked).toContain(file);
      }
      expect(pageWatch.assets.filter((row) => row.status !== 200 && row.status !== 304)).toEqual([]);
      expect(pageWatch.problems()).toEqual([]);
      await page.close();
    },
    60_000,
  );
});

for (const viewport of VIEWPORTS) {
  suite(`the screens at ${viewport.width}x${viewport.height}`, () => {
    test(
      "the gate asks for a token and says no to a wrong one",
      async () => {
        // An isolated context: a page signed in elsewhere in this file must not answer for this one.
        const context = await browser.createBrowserContext();
        const page = await context.newPage();
        await page.setViewport({ width: viewport.width, height: viewport.height });
        const pageWatch = watch(page);
        const response = await page.goto(`${app.base}/app/`, { waitUntil: "networkidle0" });
        expect(response?.headers()["content-security-policy"]).toContain("style-src 'self'");

        expect(designProblems(await styleFacts(page), viewport)).toEqual([]);
        expect((await visible(page, "#gate-token")).shown).toBe(true);
        expect((await visible(page, ".nav")).shown).toBe(false);

        await page.type("#gate-token", "not-a-token");
        await press(page, "Sign in");
        await page.waitForFunction(() => document.querySelector(".state--error") !== null);

        expect(await textOf(page, ".state--error")).toContain("unauthenticated");
        expect((await visible(page, ".nav")).shown).toBe(false);
        // The 401 is the point of the test; nothing else may have gone wrong on the way to it.
        expect(pageWatch.problems([401])).toEqual([]);
        await context.close();
      },
      60_000,
    );

    test(
      "the dashboard draws its counts, activity and two run tables",
      async () => {
        const { page, watch: pageWatch } = await screen(viewport);
        await waitFor(page, ".dash-counts");
        expect(await textOf(page, ".page-header .title")).toBe("Dashboard");
        expect(await page.evaluate(() => document.querySelectorAll(".dash-count").length)).toBe(4);
        expect(await page.evaluate(() => document.querySelectorAll(".chart__bar").length)).toBe(24);
        expect(await page.evaluate(() => document.querySelectorAll(".dash-panel").length)).toBe(2);
        expect((await visible(page, ".sidebar")).shown).toBe(viewport.width > 940);
        expect((await visible(page, ".topbar")).shown).toBe(viewport.width <= 940);
        expect(designProblems(await styleFacts(page), viewport)).toEqual([]);
        expect(pageWatch.problems()).toEqual([]);
        await page.close();
      },
      60_000,
    );

    test(
      "the pipeline editor opens a stored pipeline and draws its graph",
      async () => {
        const { page, watch: pageWatch } = await screen(viewport, "/app/pipeline/shout-report");
        await waitFor(page, ".node");
        expect(await valueOf(page, "textarea#doc")).toContain("name: shout-report");
        expect(await textOf(page, 'p.help[role="status"]')).toContain("Stored as v1, unchanged.");
        expect(await page.evaluate(() => document.querySelectorAll(".node").length)).toBe(2);
        expect((await visible(page, ".stage")).shown).toBe(true);
        expect((await visible(page, ".node")).shown).toBe(true);
        expect(designProblems(await styleFacts(page), viewport)).toEqual([]);
        expect(pageWatch.problems()).toEqual([]);
        await page.close();
      },
      60_000,
    );

    test(
      "edit the YAML, press Start a run, and the run is the edit",
      async () => {
        const { page, watch: pageWatch } = await screen(viewport, "/app/pipeline/shout-report");
        await waitFor(page, ".node");

        await replaceInYaml(page, "default: hello", "default: changed");
        await page.waitForFunction(() => document.querySelector('p.help[role="status"]')?.textContent === "Unsaved changes.");

        await press(page, "Start a run");
        await waitFor(page, "dialog[open]");
        expect((await visible(page, "dialog[open]")).shown).toBe(true);
        expect(await textOf(page, "dialog[open]")).toContain("unsaved changes");
        // The console is asserted here, at the last moment the screen is still the editor: the run
        // page the next click goes to has a CSP violation of its own, named in the skipped test
        // at the bottom of this file.
        expect(pageWatch.problems()).toEqual([]);

        await press(page, "Start the run");
        await page.waitForFunction(() => location.pathname.startsWith("/app/runs/"), { timeout: 20_000 });
        const id = new URL(page.url()).pathname.split("/").pop()!;

        // The proof comes from the server and the run directory, not the screen: the run is the bytes
        // that were on screen, not the stored version with an input pasted over it.
        const finished = await waitForRun(app, id);
        expect(finished.status).toBe("succeeded");
        const started = await app.api<{ inputs: Record<string, unknown>; steps: Record<string, unknown> }>(`runs/${id}`);
        expect(started.body.inputs.text).toBe("changed");
        expect(Object.keys(started.body.steps)).toEqual(["quiet", "loud"]);
        const snapshot = JSON.parse(readFileSync(join(app.home, "runs", id, "pipeline.yaml"), "utf8")) as {
          inputs: Record<string, { default: unknown }>;
        };
        expect(snapshot.inputs.text?.default).toBe("changed");
        // ...and pressing Start did not quietly store the edit as a new version.
        expect((await app.api("pipelines/shout-report")).body).toMatchObject({ latest: 1 });
        await page.close();
      },
      90_000,
    );

    test(
      "the Blocks detail pane shows the contract and the source",
      async () => {
        const { page, watch: pageWatch } = await screen(viewport, "/app/blocks/shout");
        await waitFor(page, ".detail");
        // The pane beside the list is the whole screen on a phone: at 390 px it used to stay hidden,
        // because nothing in the client ever set the class that shows it.
        expect((await visible(page, ".detail")).shown).toBe(true);
        expect(await textOf(page, ".detail")).toContain("The line to print.");
        expect(await textOf(page, ".detail")).toContain("#!/usr/bin/env bash");
        expect(designProblems(await styleFacts(page), viewport)).toEqual([]);
        expect(pageWatch.problems()).toEqual([]);
        await page.close();
      },
      60_000,
    );

    test(
      "the runs list shows the run with its own state",
      async () => {
        const { page, watch: pageWatch } = await screen(viewport, "/app/runs");
        await waitFor(page, ".runstable tbody tr");
        const rows = await textsOf(page, ".runstable tbody tr");
        expect(rows.filter((row) => row.includes(run.id)).length).toBe(1);
        expect(rows.join(" | ")).toContain("succeeded");
        expect(designProblems(await styleFacts(page), viewport)).toEqual([]);
        expect(pageWatch.problems()).toEqual([]);
        await page.close();
      },
      60_000,
    );

    test(
      "a run that has finished is offered no action that would be refused",
      async () => {
        const { page, watch: pageWatch } = await screen(viewport, `/app/runs/${run.id}`);
        await waitFor(page, ".timeline__step");
        // This run succeeded, so three actions are refusals waiting to happen: `retry` has nothing to
        // reset (SPEC 4.6), `resume` is refused outright (SPEC 4.7) and `cancel` is for a live run.
        // They are hidden, so the keyboard cannot reach them either. Download always works, and a
        // finished run can be deleted (after its dialog).
        for (const action of ["retry", "resume", "cancel"]) {
          expect((await visible(page, `[data-action="${action}"]`)).shown).toBe(false);
        }
        expect((await visible(page, '[data-action="download"]')).shown).toBe(true);
        expect((await visible(page, '[data-action="delete"]')).shown).toBe(true);
        // Nothing failed on the way, which is the same fact from the network's side: no click, no call,
        // no 409. What a refusal looks like when one does happen is covered in runs.test.ts, where the
        // race that causes it can be made to order.
        expect(pageWatch.http).toEqual([]);
        expect(pageWatch.pageErrors.filter((line) => line.startsWith("uncaught:"))).toEqual([]);
        await page.close();
      },
      60_000,
    );
  });
}

suite("the graph at desktop width", () => {
  test.skip(
    "a port label stays on one line, because a name that breaks mid-word is not readable",
    async () => {
      // SKIPPED, AND IT FAILS IF YOU UN-SKIP IT. Finding #33, still here. Open the worked example at
      // 1440x900 and five of its port labels are two lines tall — `interrupt_at`, `line_count`,
      // `total_words` on both the step that produces it and the one that consumes it, and
      // `report_bytes` — each measured 42 px against its own 21 px line height, broken inside the
      // word (`interrupt/_at`). The port column is 88 px inside a 212 px node, and `.port` sets
      // `overflow-wrap: anywhere` (`src/client/styles/editor.css`, the `.port` rule), so a name longer
      // than the column breaks mid-word instead of widening it. At 390 px the graph is one column, the
      // same labels measure 214 px and none of them break, which is why nobody noticed. The fix is to
      // size a node from its longest port name, or give the port column a `max-content` minimum:
      // the stylesheet and graph.ts, both files BASHR-30 is editing.
      const { page } = await screen(DESKTOP, "/app/pipeline/word-report");
      await waitFor(page, ".node");
      const tall = await page.evaluate(() =>
        [...document.querySelectorAll(".port")]
          .map((node) => ({
            name: node.textContent ?? "",
            lines: Math.round(node.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(node).lineHeight)),
          }))
          .filter((row) => row.lines > 1),
      );
      expect(tall).toEqual([]);
      await page.close();
    },
    60_000,
  );
});

suite("what a stylesheet is for", () => {
  test.skip(
    "a long unbroken description does not widen the page",
    async () => {
      // SKIPPED, AND IT FAILS IF YOU UN-SKIP IT. Finding #37, still here, and wider than the review
      // thought. Paste a description of 300 `y` characters into the editor and the document measures
      // 2635 px wide at a 1440 px viewport (2608 px at 390 px) and scrolls sideways. The widest
      // offenders are the `span.yaml__line` marks in `.yaml__paint`, which reach 3931 px: the YAML
      // pane does not clip its own unbroken line, so the page grows instead of the pane scrolling.
      // `.lead` is a second symptom rather than the cause — one 724 px line 26 px tall, because
      // `.title` beside it has `overflow-wrap: anywhere` and `.lead` does not
      // (`src/client/styles/base.css`, the `.lead` rule). Both rules are in the stylesheet.
      for (const viewport of VIEWPORTS) {
        const { page } = await screen(viewport, "/app/pipeline");
        await pasteYaml(page, `name: long-one-line\ndescription: ${"y".repeat(300)}\nsteps:\n  a:\n    uses: shout@1\n`);
        await page.waitForFunction(() => (document.querySelector(".lead")?.textContent ?? "").length === 300);
        expect(designProblems(await styleFacts(page), viewport)).toEqual([]);
        await page.close();
      }
    },
    90_000,
  );
});

suite("the pages that set an inline style", () => {
  test(
    "the run page loads without the app refusing its own style",
    async () => {
      // Finding #30 was one inline `style` attribute on the attempt label. The run page now sets no
      // style attribute at all, so its own CSP has nothing left to refuse.
      const { page, watch: pageWatch } = await screen(DESKTOP, `/app/runs/${run.id}`);
      await waitFor(page, ".timeline__step");
      expect(pageWatch.problems()).toEqual([]);
      await page.close();
    },
    60_000,
  );

  test(
    "the block writer opens without the app refusing its own style",
    async () => {
      // Used to be skipped for two reasons. The inline `style: "margin:0"` on the "Start from" label
      // is gone, so the CSP has nothing left to refuse; and the writer moved to /blocks-new, so the
      // page no longer asks the API for a block called "new" and takes a 404 for its trouble.
      const { page, watch: pageWatch } = await screen(DESKTOP, "/app/blocks-new");
      await waitFor(page, ".detail");
      expect(pageWatch.problems()).toEqual([]);
      await page.close();
    },
    60_000,
  );
});
