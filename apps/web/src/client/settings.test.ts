// Settings: the signed-in token, the server and its disk, and the admin's agent tokens. The screen
// reads each part once, and every action that changes the token list sends the request and then says
// what the server did with it.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { installDom, serveModules, uninstallDom, type FakeElement } from "./client.testkit.ts";

const dom = installDom({ href: "http://x/app/settings" });
const document = dom.document;
const view = (): FakeElement => document.getElementById("view")!;
const announce = (): FakeElement => document.getElementById("announce")!;

const served = serveModules(["settings"]);
const api = (await import(join(served, "api.js"))) as typeof import("./api.ts");
const { renderSettings } = (await import(join(served, "settings.js"))) as typeof import("./settings.ts");

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const calls: { method: string; url: URL; body: string | null }[] = [];
const routes = new Map<string, Reply | (() => Reply | Promise<Reply>)>();
const realFetch = globalThis.fetch;
const realNavigator = globalThis.navigator;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  calls.push({ method, url, body: typeof init?.body === "string" ? init.body : null });
  const found = routes.get(`${method} ${url.pathname}`);
  if (found === undefined) {
    return new Response(JSON.stringify({ code: "not_found", message: `nothing answers ${method} ${url.pathname}` }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  const reply = typeof found === "function" ? await found() : found;
  return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
    status: reply.status ?? 200,
    headers: { "content-type": "application/json", ...reply.headers },
  });
}) as typeof fetch;

const DISK = {
  path: "/data",
  total_bytes: 1024 * 1024,
  used_bytes: 512 * 1024,
  free_bytes: 512 * 1024,
  low: false,
  runs_bytes: 1024,
};

const TOKENS = [
  {
    id: "t1",
    name: "nightly",
    scope: "read",
    created_at: new Date(Date.now() - 3 * 60_000).toISOString(),
    last_used: null,
  },
  {
    id: "t2",
    name: "deploy",
    scope: "write",
    created_at: new Date(Date.now() - 4 * 3_600_000).toISOString(),
    last_used: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  },
];

let reloads = 0;

function answer(method: string, path: string, reply: Reply | (() => Reply | Promise<Reply>)): void {
  routes.set(`${method} ${path}`, reply);
}

async function render(): Promise<FakeElement> {
  announce().textContent = "";
  view().replaceChildren();
  await renderSettings(
    view(),
    { path: "/settings", parts: ["settings"], query: new URLSearchParams() },
    new AbortController().signal,
  );
  return view();
}

async function eventually(what: string, ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200; turn++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`never saw ${what}`);
}

function controls(root: FakeElement): FakeElement[] {
  return [...root.querySelectorAll("button"), ...root.querySelectorAll("a")];
}

function byText(root: FakeElement, label: string): FakeElement {
  const found = controls(root).find((node) => node.textContent.trim() === label);
  if (found === undefined) {
    throw new Error(`no control "${label}"; the screen offers ${controls(root).map((node) => node.textContent.trim()).join(" | ")}`);
  }
  return found;
}

function rowNamed(root: FakeElement, name: string): FakeElement {
  const row = root.querySelectorAll("tbody tr").find((node) => node.textContent.includes(name));
  if (row === undefined) throw new Error(`no token row for ${name}`);
  return row;
}

function dialog(): FakeElement {
  const node = document.body.querySelector("dialog");
  if (node === null) throw new Error("the dialog did not open");
  return node;
}

beforeEach(() => {
  for (const node of document.body.querySelectorAll("dialog")) {
    const parent = node.parent;
    if (parent !== null) {
      const at = parent.children.indexOf(node);
      if (at !== -1) parent.children.splice(at, 1);
      node.parent = null;
    }
  }
  routes.clear();
  calls.length = 0;
  reloads = 0;
  (globalThis.location as unknown as { reload: () => void }).reload = () => {
    reloads += 1;
  };
  api.signIn("http://api.test", "a_token", false);
  api.session.identity = { name: "root", scope: "admin", admin: true };
  answer("GET", "/healthz", { body: { status: "ok", version: "9.9.9" } });
  answer("GET", "/v1/disk", { body: DISK });
  answer("GET", "/v1/tokens", { body: [] });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  (globalThis as unknown as { navigator: Navigator }).navigator = realNavigator;
  api.signOut();
  api.session.onUnauthorized = () => {};
  uninstallDom(dom);
  rmSync(served, { recursive: true, force: true });
});

describe("who you are, the server, and its disk", () => {
  test("shows the token's name and access, the server's addresses, and the disk the runs use", async () => {
    const screen = await render();

    expect(screen.textContent).toContain("Settings");
    expect(screen.textContent).toContain("root");
    expect(screen.querySelectorAll(".stamp--type").map((node) => node.textContent)).toContain("admin");
    expect(byText(screen, "Sign out")).not.toBeNull();

    expect(screen.textContent).toContain("Version");
    expect(screen.textContent).toContain("9.9.9");
    expect(screen.textContent).toContain("http://api.test/v1");
    expect(screen.textContent).toContain("http://api.test/mcp");
    const fonts = byText(screen, "Fonts and their licence");
    expect(fonts.getAttribute("href")).toBe("/app/OFL.txt");

    expect(screen.textContent).toContain("50% used");
    expect(screen.textContent).toContain("Used 512 KB");
    expect(screen.textContent).toContain("Free 512 KB of 1.0 MB");
    expect(screen.textContent).toContain("runs 1.0 KB");
    expect(screen.textContent).toContain("/data");
    expect(screen.querySelector(".meter")).not.toBeNull();
    expect(screen.querySelector(".alarm")).toBeNull();
  });

  test("a low disk is an alarm, not another line of numbers", async () => {
    answer("GET", "/v1/disk", { body: { ...DISK, low: true } });
    const screen = await render();

    const notice = screen.querySelector(".alarm");
    expect(notice).not.toBeNull();
    expect(notice!.getAttribute("role")).toBe("alert");
    expect(notice!.textContent).toContain("Disk almost full");
    expect(notice!.textContent).toContain("512 KB free of 1.0 MB");
    // The numbers the alarm is about stay beside it, so the reader can see the same disk.
    expect(screen.textContent).toContain("50% used");
  });

  test("a disk that cannot be read is an error in the disk section, not a zero", async () => {
    answer("GET", "/v1/disk", {
      status: 503,
      body: { code: "runtime_missing", message: 'cannot read the filesystem under "/data"' },
    });
    const screen = await render();

    expect(screen.textContent).toContain("runtime_missing");
    expect(screen.textContent).toContain('cannot read the filesystem under "/data"');
    expect(screen.querySelector(".meter")).toBeNull();
  });

  test("signing out clears the token exactly as the sidebar's does", async () => {
    const screen = await render();
    expect(api.session.token).toBe("a_token");

    byText(screen, "Sign out").fire("click");

    expect(reloads).toBe(1);
    expect(api.session.token).toBe("");
    expect(api.session.identity).toBeNull();
    expect((globalThis.localStorage as Storage).getItem("bashreactor.token")).toBeNull();
    expect((globalThis.sessionStorage as Storage).getItem("bashreactor.token")).toBeNull();
  });
});

describe("the admin's tokens", () => {
  test("are a table of name, access, created, last used and a Revoke for each", async () => {
    answer("GET", "/v1/tokens", { body: TOKENS });
    const screen = await render();

    const nightly = rowNamed(screen, "nightly");
    expect(nightly.textContent).toContain("read");
    expect(nightly.textContent).toContain("3 min ago");
    expect(nightly.textContent).toContain("never");
    const created = nightly.querySelectorAll("time")[0]!;
    expect(created.getAttribute("datetime")).toBe(TOKENS[0]!.created_at);
    expect(created.getAttribute("title")).toContain("202");
    expect(byText(nightly, "Revoke")).not.toBeNull();

    const deploy = rowNamed(screen, "deploy");
    expect(deploy.textContent).toContain("write");
    expect(deploy.textContent).toContain("2 h ago");
  });

  test("are not on screen at all for a token that is not the admin", async () => {
    api.session.identity = { name: "agent", scope: "read", admin: false };
    const screen = await render();

    expect(screen.textContent).not.toContain("Tokens");
    expect(screen.textContent).not.toContain("New token");
    expect(screen.textContent).not.toContain("No agent tokens yet.");
    expect(calls.some((call) => call.url.pathname === "/v1/tokens")).toBe(false);
    expect(screen.querySelectorAll(".stamp--type").map((node) => node.textContent)).toContain("read");
  });

  test("Revoke asks first, then deletes the token and updates the table", async () => {
    answer("GET", "/v1/tokens", { body: [TOKENS[0]!] });
    answer("DELETE", "/v1/tokens/t1", { body: { deleted: "t1" } });
    const screen = await render();

    byText(rowNamed(screen, "nightly"), "Revoke").fire("click");
    await eventually("the confirmation", () => document.body.querySelector("dialog") !== null);
    const confirm = dialog();
    expect(confirm.textContent).toContain("Revoke nightly?");
    // Nothing has been deleted while the question is open.
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);

    byText(confirm, "Revoke").fire("click");
    await eventually("the row to go", () => !screen.textContent.includes("nightly"));

    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.url.pathname)).toEqual(["/v1/tokens/t1"]);
    expect(screen.textContent).toContain("No agent tokens yet.");
    expect(announce().textContent).toContain("nightly");
    expect(announce().textContent).toContain("revoked");
    expect(document.body.querySelector("dialog")).toBeNull();
  });

  test("a new token shows its secret once, copies it, and forgets it when the dialog closes", async () => {
    const created = {
      id: "t3",
      name: "ci",
      scope: "write",
      created_at: new Date().toISOString(),
      last_used: null,
      token: "br_secret_once",
    };
    answer("POST", "/v1/tokens", { status: 201, body: created });
    const screen = await render();

    byText(screen, "New token").fire("click");
    await eventually("the new-token dialog", () => document.body.querySelector("dialog") !== null);
    const form = dialog();
    expect(form.textContent).toContain("New token");
    const name = form.querySelector('[id="settings-token-name"]')!;
    name.value = "ci";
    const write = form.querySelectorAll(".segmented__btn").find((node) => node.textContent.trim() === "write");
    expect(write).toBeDefined();
    write!.fire("click");

    byText(form, "Create token").fire("click");
    await eventually("the secret", () => form.querySelector('[id="settings-token-secret"]')?.value === "br_secret_once");

    const post = calls.find((call) => call.method === "POST" && call.url.pathname === "/v1/tokens");
    expect(post).toBeDefined();
    expect(JSON.parse(post!.body!)).toEqual({ name: "ci", scope: "write" });
    expect(form.textContent).toContain("This is the only time it is shown.");
    const secret = form.querySelector('[id="settings-token-secret"]')!;
    expect(secret.value).toBe("br_secret_once");
    expect(screen.textContent).toContain("ci");
    expect(announce().textContent).toContain("created");

    let selected = false;
    secret.select = () => {
      selected = true;
    };
    (globalThis as unknown as { navigator: { clipboard: { writeText: (text: string) => Promise<void> } } }).navigator = {
      clipboard: {
        writeText: async () => {
          throw new Error("the browser refused the clipboard");
        },
      },
    };
    byText(form, "Copy").fire("click");
    await eventually("the secret to be selected", () => selected);

    let copied = "";
    (globalThis as unknown as { navigator: { clipboard: { writeText: (text: string) => Promise<void> } } }).navigator = {
      clipboard: {
        writeText: async (text: string) => {
          copied = text;
        },
      },
    };
    byText(form, "Copy").fire("click");
    await eventually("the secret to be copied", () => copied === "br_secret_once");

    byText(form, "Close").fire("click");
    await eventually("the dialog to close", () => document.body.querySelector("dialog") === null);
    expect(document.body.textContent).not.toContain("br_secret_once");
    expect(secret.value).toBe("");
  });

  test("a refusal from the server stays in the dialog with its code and message", async () => {
    answer("POST", "/v1/tokens", {
      status: 422,
      body: { code: "invalid_argument", message: "give the token a name, such as the agent's" },
    });
    const screen = await render();

    byText(screen, "New token").fire("click");
    await eventually("the new-token dialog", () => document.body.querySelector("dialog") !== null);
    const form = dialog();
    byText(form, "Create token").fire("click");
    await eventually("the refusal", () => form.textContent.includes("invalid_argument"));

    expect(form.textContent).toContain("give the token a name, such as the agent's");
    expect(form.querySelector('[id="settings-token-secret"]')).toBeNull();
    expect(screen.textContent).not.toContain("give the token a name");
    byText(form, "Cancel").fire("click");
    expect(document.body.querySelector("dialog")).toBeNull();
  });
});
