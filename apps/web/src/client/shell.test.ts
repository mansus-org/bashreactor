// The shell: every route reaches its screen, the two old addresses rewrite in place, the nav says
// where the reader is, and the phone menu opens, traps focus, closes on Escape and gives focus back.
// The screen bodies are the real ones; this file is about what the chrome does around them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { installDom, serveModules, uninstallDom, type FakeElement } from "./client.testkit.ts";

const dom = installDom({ href: "http://x/app/runs" });
const document = dom.document;
const view = (): FakeElement => document.getElementById("view")!;
const button = (): FakeElement => document.getElementById("menu-button")!;
const menu = (): FakeElement => document.getElementById("menu")!;

// Turn the minimal test shell into the shell `index.html` serves: the sidebar's nav, the phone menu
// and the identity column. app.ts fills the two nav containers from its own bitmaps.
document.querySelector(".nav")!.setAttribute("data-nav", "main");
// The stand-in document has no removeEventListener; the screens that poll use it when they leave.
(document as unknown as { removeEventListener: () => void }).removeEventListener = () => {};
const menuBox = document.createElement("div");
menuBox.setAttribute("id", "menu");
menuBox.setAttribute("hidden", "");
menuBox.hidden = true;
const menuNav = document.createElement("nav");
menuNav.setAttribute("data-nav", "menu");
menuNav.setAttribute("hidden", "");
menuNav.hidden = true;
menuBox.append(menuNav);
const menuButton = document.createElement("button");
menuButton.setAttribute("id", "menu-button");
menuButton.setAttribute("aria-controls", "menu");
menuButton.setAttribute("hidden", "");
document.body.append(menuButton, menuBox);

const ANSWER = new Map<string, () => unknown>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input), "http://x").pathname;
  const answer = ANSWER.get(path);
  if (answer === undefined) {
    return new Response(JSON.stringify({ code: "not_found", message: "no answer in this test" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  const body = answer();
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const location = globalThis.location as unknown as { href: string; pathname: string };
function at(url: string | null | undefined): void {
  if (typeof url !== "string") return;
  const next = new URL(url, "http://x");
  location.href = next.href;
  location.pathname = next.pathname;
}
(globalThis as unknown as Record<string, unknown>).history = {
  pushState: (_state: unknown, _title: string, url?: string | null) => at(url),
  replaceState: (_state: unknown, _title: string, url?: string | null) => at(url),
};
(globalThis.localStorage as Storage).setItem("bashreactor.token", "a_good_token");
ANSWER.set("/v1/whoami", () => ({ name: "root", scope: "admin", admin: true }));
ANSWER.set("/v1/runs", () => []);
ANSWER.set("/v1/blocks", () => ({ blocks: [] }));
ANSWER.set("/v1/pipelines", () => ({ pipelines: [] }));

const served = serveModules(["app"]);
const { navigate } = (await import(join(served, "app.js"))) as typeof import("./app.ts");
const api = (await import(join(served, "api.js"))) as typeof import("./api.ts");

async function settle(): Promise<void> {
  for (let turn = 0; turn < 60; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function go(path: string): Promise<void> {
  navigate(path);
  await settle();
}

const text = (node: FakeElement): string => node.textContent;
const currentSections = (): string[] =>
  document.querySelectorAll("a[aria-current='page']").map((link) => link.dataset.section ?? "");

beforeAll(async () => {
  await settle();
});

describe("the routes", () => {
  test("each screen answers at its own address, and the unbuilt ones say so", async () => {
    await go("/");
    expect(text(view())).toContain("BASHR-56");
    expect(text(view())).toContain("not_implemented");

    await go("/runs");
    expect(text(view())).toContain("Runs");

    await go("/blocks");
    expect(text(view())).toContain("Blocks");

    await go("/blocks-new");
    expect(text(view())).toContain("New block");

    await go("/pipelines");
    expect(text(view())).toContain("BASHR-57");

    await go("/pipelines/word-report");
    expect(text(view())).toContain("BASHR-57");

    await go("/settings");
    expect(text(view())).toContain("BASHR-60");
  });

  test("the editor opens new and stored, at its new addresses", async () => {
    await go("/pipelines-new");
    expect(document.getElementById("doc")).not.toBeNull();

    await go("/pipelines/word-report/edit?version=2");
    expect(document.getElementById("doc")).not.toBeNull();
  });

  test("the old editor addresses redirect in place", async () => {
    await go("/pipeline");
    expect(location.pathname).toBe("/app/pipelines-new");

    await go("/pipeline/word-report/3");
    expect(location.pathname).toBe("/app/pipelines/word-report/edit");
    expect(new URL(location.href).searchParams.get("version")).toBe("3");
  });

  test("a detail page counts as its section for aria-current", async () => {
    await go("/runs");
    expect(currentSections()).toEqual(["runs", "runs"]);

    await go("/pipelines-new");
    expect(currentSections()).toEqual(["pipelines", "pipelines"]);

    await go("/blocks-new");
    expect(currentSections()).toEqual(["blocks", "blocks"]);

    navigate("/runs/20261105T201258Z-f1549287");
    await settle();
    expect(currentSections()).toEqual(["runs", "runs"]);

    await go("/");
    expect(currentSections()).toEqual(["dashboard", "dashboard"]);
  });
});

describe("the phone menu", () => {
  test("opens from the button, traps Tab, closes with Escape and returns focus to the button", async () => {
    await go("/runs");
    const links = menu().querySelectorAll(".nav__link");
    expect(links.length).toBeGreaterThan(0);
    const focused: string[] = [];
    for (const link of links) {
      link.focus = () => {
        document.activeElement = link;
        focused.push(text(link));
      };
    }
    const buttonNode = button();
    buttonNode.focus = () => {
      document.activeElement = buttonNode;
      focused.push("Menu");
    };

    buttonNode.fire("click");
    expect(menu().hidden).toBe(false);
    expect(buttonNode.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(links[0]!);

    // Tab from the last item wraps to the first, so focus never leaves the open menu.
    document.activeElement = links[links.length - 1]!;
    menu().fire("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(links[0]!);

    menu().fire("keydown", { key: "Escape" });
    expect(menu().hidden).toBe(true);
    expect(buttonNode.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(buttonNode);
    expect(focused).toContain("Menu");

    // A choice closes the menu too.
    buttonNode.fire("click");
    expect(menu().hidden).toBe(false);
    menu().fire("click", { target: links[0]! });
    expect(menu().hidden).toBe(true);
  });
});

describe("the token's access in the shell", () => {
  test("a read-only token is offered no Settings tokens link", async () => {
    api.session.identity = { name: "agent", scope: "read", admin: false };
    await go("/settings");
    const controls = [...document.querySelectorAll("a"), ...document.querySelectorAll("button")];
    expect(controls.map((node) => text(node)).filter((label) => label === "Tokens" || label === "New token")).toEqual([]);
  });
});

describe("the sign-in gate", () => {
  test("is drawn without the sidebar, and keeps today's words", async () => {
    api.signOut();
    await go("/");
    expect(document.body.classList.contains("gate-only")).toBe(true);
    expect(document.querySelector(".nav")!.hidden).toBe(true);
    expect(text(view())).toContain("The token is what every call to /v1 carries. Nothing is stored on this device until you check it.");
    expect(text(view())).toContain("Where the API is.");
    expect(document.getElementById("gate-token")).not.toBeNull();
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  api.session.identity = null;
  api.signOut();
  api.session.onUnauthorized = () => {};
  uninstallDom(dom);
  rmSync(served, { recursive: true, force: true });
});
