/**
 * What the sign-in gate does when the server is not on the other end.
 *
 * The gate is the only screen between a person and their token, and it used to tell one story for
 * every failure: it cleared the token and said it was refused. A laptop whose server had not started
 * said the same thing as a token that had expired, and that difference is the whole of the ticket —
 * one of those two is fixed by waiting, the other by making a new token. So each kind of answer gets
 * its own test here, read at the two places the claim is actually made: what the screen says, and
 * whether the token is still there afterwards.
 *
 * The shell is the module that owns the gate, and it renders itself the moment it loads, so the DOM
 * and the fetch stub are in place before it is imported.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { installDom, serveModules, uninstallDom, type FakeElement } from "./client.testkit.ts";

const dom = installDom({ href: "http://x/app/" });
const served = serveModules(["app"]);

// The shell reads `localStorage` while it loads, and the fake storage belongs to the install above,
// so nothing here may import these two statically.
const { session, signIn, signOut } = (await import(join(served, "api.js"))) as typeof import("./api.ts");
const { navigate } = (await import(join(served, "app.js"))) as typeof import("./app.ts");

const BASE = "http://127.0.0.1:5949";
const GOOD = "brv_a_token_that_is_perfectly_fine";
const ROOT = { name: "root", scope: "admin", admin: true };

type Answer = () => { status: number; body: unknown };

const answers = new Map<string, Answer>();
const calls: string[] = [];

const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input), "http://x");
  calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
  const answer = answers.get(url.pathname);
  const sent =
    answer === undefined
      ? { status: 404, body: { code: "not_found", message: "this test has no answer for that route" } }
      : answer();
  return new Response(JSON.stringify(sent.body), {
    status: sent.status,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

/** The router writes the address through `history`, and reads it back off `location.href`. */
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

const view = (): FakeElement => dom.document.getElementById("view")!;
const text = (node: FakeElement): string => node.textContent;
const field = (id: string): FakeElement => dom.document.getElementById(id)!;
/** Where the token lives decides how long it survives: this tab, or this device. */
const onDevice = (): string | null => (globalThis.localStorage as Storage).getItem("bashreactor.token");
const inThisTab = (): string | null => (globalThis.sessionStorage as Storage).getItem("bashreactor.token");

/** Every promise the app queued while it was waiting on the server. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A cold start: no token anywhere, nothing asked of the server, the gate up. */
function cold(): void {
  signOut();
  answers.clear();
  // The entry page reads it for its own "this server" line, and a healthy answer keeps that line out
  // of what these tests are about.
  answers.set("/healthz", () => ({ status: 200, body: { status: "ok", version: "0.1.0" } }));
  calls.length = 0;
  navigate("/");
}

/** What a person does at the gate: fill in the two boxes, press the button. */
async function checkAtGate(token: string): Promise<void> {
  await settle();
  field("gate-base").value = BASE;
  field("gate-token").value = token;
  dom.document.querySelector("form")!.fire("submit");
  await settle();
}

describe("the gate, when the server gives an answer of each kind", () => {
  test("with no token at all it asks, and asks nothing of the server", () => {
    cold();

    expect(text(view())).toContain("The token is what every call to /v1 carries");
    expect(calls).toEqual([]);
    // The chrome stays shut while there is no identity to show in it.
    expect(dom.document.querySelector(".nav")!.getAttribute("hidden")).toBe("");
    expect(text(field("who"))).toBe("");
  });

  test("a socket that goes nowhere is not called a refused token, and the token is kept", async () => {
    cold();
    answers.set("/v1/whoami", () => {
      throw new TypeError("The socket connection was closed unexpectedly.");
    });

    await checkAtGate(GOOD);

    // The server said nothing about the token, so neither does the screen: no "refused", no "wrong".
    expect(calls).toContain("GET /v1/whoami");
    expect(text(view())).toContain("unreachable");
    expect(text(view())).toContain("did not answer");
    expect(text(view())).not.toContain("refused");
    expect(text(view())).not.toContain("no longer accepted");
    // Still the gate, and still holding what was typed into it.
    expect(session.token).toBe(GOOD);
    // Kept for this tab, which is what "keep me signed in" was not ticked for. Nothing is written to
    // the device by a check the server has not agreed to.
    expect(inThisTab()).toBe(GOOD);
    expect(onDevice()).toBeNull();

    // Which is what the next try is for: the same token, without typing it again.
    answers.set("/v1/whoami", () => ({ status: 200, body: ROOT }));
    navigate("/");
    await settle();

    expect(text(view())).not.toContain("The token is what every call to /v1 carries");
    expect(text(field("who"))).toContain("root");
  });

  test("a token the server refuses is dropped, and the server's own words say why", async () => {
    cold();
    signIn(BASE, "brv_expired", true);
    answers.set("/v1/whoami", () => ({
      status: 401,
      body: { code: "token_expired", message: "This token expired on 2026-11-01." },
    }));

    navigate("/");
    await settle();

    expect(session.token).toBe("");
    expect(onDevice()).toBeNull();
    expect(inThisTab()).toBeNull();
    expect(text(view())).toContain("token_expired");
    expect(text(view())).toContain("This token expired on 2026-11-01.");
    // The server's answer, and not the app's guess about it. And it is worded as a refusal on
    // arrival: this page never got through with the token, so it cannot claim it used to work.
    expect(text(view())).not.toContain("Nothing has checked this token");
    expect(text(view())).toContain("refused that token");
    expect(text(view())).not.toContain("no longer accepted");
    // The chrome is shut again: there is no identity left to show in it.
    expect(dom.document.querySelector(".nav")!.getAttribute("hidden")).toBe("");
    expect(text(field("who"))).toBe("");
  });

  test("a server that answers 500 is not given a verdict on the token", async () => {
    cold();
    signIn(BASE, GOOD, false);
    answers.set("/v1/whoami", () => ({
      status: 500,
      body: { code: "internal_error", message: "The store is not open." },
    }));

    navigate("/");
    await settle();

    expect(session.token).toBe(GOOD);
    expect(text(view())).toContain("Nothing has checked this token");
    expect(text(view())).toContain("internal_error");
    expect(text(view())).toContain("The store is not open.");
  });

  test("and a server with no such route, which is what an old one looks like", async () => {
    cold();
    signIn(BASE, GOOD, false);

    navigate("/");
    await settle();

    expect(session.token).toBe(GOOD);
    expect(text(view())).toContain("Nothing has checked this token");
    expect(text(view())).toContain("not_found");
  });

  test("a token that stops working after it was accepted comes back to the same gate", async () => {
    cold();
    signIn(BASE, "brv_revoked", true);
    answers.set("/v1/whoami", () => ({ status: 200, body: ROOT }));
    navigate("/");
    await settle();
    expect(text(field("who"))).toContain("root");

    // Revoked between one call and the next, so it is another screen's call that finds out. The
    // reason goes on the gate wherever the person was, and it says "no longer", because it did work.
    answers.set("/v1/blocks/count-words", () => ({
      status: 401,
      body: { code: "token_revoked", message: "This token was revoked." },
    }));
    navigate("/blocks/count-words");
    await settle();

    expect(session.token).toBe("");
    expect(onDevice()).toBeNull();
    expect(inThisTab()).toBeNull();
    expect(text(view())).toContain("token_revoked");
    expect(text(view())).toContain("This token was revoked.");
    expect(text(view())).toContain("no longer accepted");
    expect(dom.document.querySelector(".nav")!.getAttribute("hidden")).toBe("");
  });
});

afterAll(() => {
  // The shell registered a 401 handler on the session object; leave nothing pointing at a torn-down
  // DOM behind.
  session.onUnauthorized = () => {};
  signOut();
  uninstallDom(dom);
  // Put the real one back rather than deleting the global: every test file in this run shares the
  // process, and the browser suite reaches for a live fetch after this one is done.
  globalThis.fetch = realFetch;
  rmSync(served, { recursive: true, force: true });
});
