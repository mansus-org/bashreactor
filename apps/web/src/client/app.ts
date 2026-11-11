// The shell: the chrome, the router, the token gate and the entry page. A screen is a function that
// fills `#view` from what the API returned; nothing here keeps a copy of a pipeline, a run or a block.

import { api, canWrite, session, signIn, signOut, ApiError } from "./api.js";
import type { ApiError as GateError } from "./api.js";
import { announce, el, errorBox, sign, stateLine } from "./dom.js";
import { renderPipeline } from "./editor.js";
import { renderRunsList } from "./runs-list.js";
import { renderRunPage } from "./run-page.js";
import { renderBlocks } from "./blocks.js";

/** Where the app is mounted. The server answers this path and everything under it. */
export const BASE = "/app";

export interface Route {
  /** The path under the mount point: "/", "/pipeline", "/runs/<id>". */
  path: string;
  parts: string[];
  query: URLSearchParams;
}

export type Screen = (view: HTMLElement, route: Route, signal: AbortSignal) => void | Promise<void>;

const view = document.getElementById("view")!;
const nav = document.querySelector<HTMLElement>(".nav")!;
const who = document.getElementById("who")!;
const footNote = document.getElementById("foot-note")!;

/** Guards against a slow screen answering after the reader has already moved on. */
let renderCount = 0;
/** Screens that poll or wait get told when they are off screen, so nothing keeps asking the API. */
let leaving: AbortController | null = null;

export function routeNow(): Route {
  const url = new URL(location.href);
  let path = url.pathname;
  if (path.startsWith(`${BASE}/`)) path = path.slice(BASE.length);
  else if (path === BASE) path = "/";
  else path = "/";
  if (path !== "/" && path.endsWith("/")) path = path.slice(0, -1);
  return { path, parts: path.split("/").filter((part) => part !== ""), query: url.searchParams };
}

/** Every in-app link goes through here, so the address bar and the back button stay honest. */
export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const href = `${BASE}${path === "/" ? "" : path}`;
  if (options.replace) history.replaceState({}, "", href);
  else history.pushState({}, "", href);
  void render({ focus: true });
}

/**
 * Which nav item a route sits under. `/blocks-new` is the writer for a block that does not exist
 * yet, and it is still the Blocks screen: a new block cannot live at `/blocks/new`, because `new`
 * is a legal block name and that address belongs to the block called `new`.
 */
const SECTION: Record<string, string> = { "blocks-new": "blocks" };

function setChrome(route: Route): void {
  const identity = session.identity;
  nav.hidden = identity === null;
  if (identity === null) {
    who.replaceChildren();
    return;
  }
  who.replaceChildren(
    el(
      "span",
      { class: "stamp stamp--type" },
      identity.name,
      identity.admin ? ", admin" : identity.scope === "write" ? ", write" : ", read only",
    ),
    el(
      "button",
      {
        class: "btn",
        type: "button",
        onclick: () => {
          signOut();
          void render({ focus: true });
        },
      },
      "Sign out",
    ),
  );
  const section = SECTION[route.parts[0] ?? ""] ?? route.parts[0] ?? "";
  nav.querySelectorAll<HTMLAnchorElement>("a[data-link]").forEach((link) => {
    const name = (link.getAttribute("href") ?? "").slice(BASE.length + 1);
    if (name === section) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

/**
 * Whether the gate is what is on screen. Its own check puts its own errors in its own box; a 401
 * from anywhere else is the gate's to announce.
 */
let gateIsShown = false;

/** The gate: the first screen, and the one a 401 comes back to. */
function renderGate(message: string, error?: GateError): void {
  gateIsShown = true;
  setChrome(routeNow());
  const base = el("input", {
    id: "gate-base",
    type: "url",
    value: session.base,
    spellcheck: "false",
    autocomplete: "off",
    "aria-describedby": "gate-base-help",
  });
  const token = el("input", {
    id: "gate-token",
    type: "password",
    spellcheck: "false",
    autocomplete: "off",
    "aria-describedby": "gate-token-help",
  });
  const remember = el("input", { id: "gate-remember", type: "checkbox" });
  const busy = el("p", { class: "state", role: "status", hidden: true });
  // A 401 comes back to this screen, and the server's own words about the token go at the top of it.
  const box = el("div", {}, error !== undefined ? errorBox(error) : null);
  const submit = el("button", { class: "btn btn--ink", type: "submit" }, "Check the token");

  async function check(): Promise<void> {
    busy.hidden = false;
    submit.disabled = true;
    try {
      session.identity = await api.whoami();
      busy.hidden = true;
      announce(`Signed in as ${session.identity.name}.`);
      await render({ focus: true });
    } catch (caught) {
      submit.disabled = false;
      busy.hidden = true;
      token.focus();
      token.select();
      box.replaceChildren(
        errorBox(caught instanceof ApiError ? caught : { code: "internal_error", message: String(caught) }),
      );
    }
  }

  const form = el(
    "form",
    {
      class: "gate__form",
      onsubmit: (event) => {
        event.preventDefault();
        const href = base.value.trim().replace(/\/+$/, "");
        const secret = token.value.trim();
        if (href === "" || secret === "") return;
        signIn(href, secret, remember.checked);
        box.replaceChildren();
        void check();
      },
    },
    el(
      "div",
      { class: "field" },
      el("label", { class: "label", for: "gate-base" }, "Server"),
      base,
      el(
        "p",
        { class: "help", id: "gate-base-help" },
        "Where the API is. Leave it as this address unless the API lives somewhere else: a browser only lets a page call another origin if that server says so, and this one does not.",
      ),
    ),
    el(
      "div",
      { class: "field" },
      el("label", { class: "label", for: "gate-token" }, "Token"),
      token,
      el(
        "p",
        { class: "help", id: "gate-token-help" },
        "The admin token, or an agent token from ",
        el("code", {}, "POST /v1/tokens"),
        ". It goes out as ",
        el("code", {}, "Authorization: Bearer"),
        " on every call and is kept in this browser only.",
      ),
    ),
    el(
      "label",
      { class: "check" },
      remember,
      el("span", {}, el("strong", {}, "Keep me signed in on this device"), " Otherwise the token is kept for this tab only."),
    ),
    box,
    busy,
    submit,
  );

  view.replaceChildren(
    el(
      "div",
      { class: "gate" },
      el(
        "div",
        { class: "head" },
        el(
          "div",
          { class: "head__text" },
          el("h1", { class: "title" }, "Bashreactor"),
          el(
            "p",
            { class: "lead" },
            "A resumable pipeline runner for bash: one YAML file says what runs, every step is one bash file, and a run is a directory you can restart.",
          ),
          el("p", { class: "help" }, message),
        ),
        el("span", { class: "stamp" }, sign("queued"), "sign in"),
      ),
      form,
    ),
  );
  token.focus();
}

/** The entry page, once signed in: the three screens and what the server says about itself. */
async function renderHome(): Promise<void> {
  const health = await api.health().catch(() => null);
  const identity = session.identity!;
  footNote.textContent = health === null ? "One API at /v1." : `bashreactor ${health.version}, one API at /v1.`;
  view.replaceChildren(
    el(
      "div",
      { class: "gate" },
      el(
        "div",
        { class: "head" },
        el(
          "div",
          { class: "head__text" },
          el("h1", { class: "title" }, "Bashreactor"),
          el(
            "p",
            { class: "lead" },
            "A resumable pipeline runner for bash: one YAML file says what runs, every step is one bash file, and a run is a directory you can restart.",
          ),
        ),
        el("span", { class: "stamp" }, sign(health?.status === "ok" ? "succeeded" : "failed"), health?.status ?? "no answer"),
      ),
      el(
        "section",
        { "aria-labelledby": "screens-title" },
        el("h2", { class: "h2", id: "screens-title" }, "The three screens"),
        el(
          "div",
          { class: "screens" },
          screenCard("1", "editor", "Pipeline", "/pipeline", "Write the YAML. The graph is drawn from it, never stored beside it, so the two cannot drift."),
          screenCard("2", "live", "Runs", "/runs", "A run streaming its logs by byte offset, with cancel, retry and resume."),
          screenCard("3", "library", "Blocks", "/blocks", "The library of bash files. Their front matter says what goes in and what comes out."),
        ),
      ),
      el(
        "section",
        { class: "status", "aria-labelledby": "status-title" },
        el("h2", { class: "h2", id: "status-title" }, "This server"),
        el(
          "p",
          {},
          health === null
            ? `${session.base} did not answer /healthz.`
            : health.status === "ok"
              ? `bashreactor ${health.version}, API at ${session.base}/v1.`
              : `bashreactor ${health.version} is degraded: ${health.problem ?? "no reason given"}.`,
        ),
        el(
          "ul",
          { class: "truth" },
          el(
            "li",
            {},
            "Signed in as ",
            el("strong", {}, identity.name),
            ", ",
            identity.admin ? "the admin token." : `${identity.scope} scope.`,
          ),
          el(
            "li",
            {},
            canWrite()
              ? "This token can store pipelines, publish blocks and start runs."
              : "This token can read only, so the write controls are switched off rather than hidden.",
          ),
          el(
            "li",
            {},
            "The graph is derived from the YAML, the run view from ",
            el("code", {}, "run.json"),
            ", the block contract from its own header.",
          ),
        ),
      ),
    ),
  );
}

function screenCard(num: string, kind: string, name: string, href: string, text: string): HTMLElement {
  return el(
    "a",
    { class: "screen", href: `/app${href}`, "data-link": "" },
    el(
      "span",
      { class: "screen__head" },
      el("span", { class: "screen__num" }, num),
      el("span", { class: "stamp stamp--type" }, kind),
    ),
    el("span", { class: "screen__name" }, name),
    el("span", { class: "screen__text" }, text),
  );
}

const screens: Record<string, Screen> = {
  pipeline: renderPipeline,
  runs: (target, route, signal) => {
    const id = route.parts[1];
    if (id === undefined) renderRunsList(target, route, signal);
    else return renderRunPage(target, id, signal);
  },
  blocks: renderBlocks,
  "blocks-new": renderBlocks,
};

async function render(options: { focus: boolean }): Promise<void> {
  gateIsShown = false;
  const mine = ++renderCount;
  leaving?.abort();
  leaving = new AbortController();
  const signal = leaving.signal;
  const route = routeNow();
  // The writer's address is not a name, so the tab does not read like one either.
  const words = route.parts[0] === "blocks-new" ? ["New block"] : route.parts;
  document.title = route.parts.length === 0 ? "Bashreactor" : `${words.join(" ")} — Bashreactor`;

  if (session.token === "") {
    renderGate("The token is what every call to /v1 carries. Nothing is stored on this device until you check it.");
    return;
  }

  if (session.identity === null) {
    setChrome(route);
    view.replaceChildren(stateLine("Checking the token."));
    try {
      session.identity = await api.whoami();
    } catch (caught) {
      if (mine !== renderCount) return;
      // A 401 has already been answered: `onUnauthorized` has cleared the token and put the gate up
      // with the server's own reason, and a second gate would only overwrite it.
      if (caught instanceof ApiError && caught.status === 401) return;
      // Anything else — no server, a 500, a wrong path — says nothing about the token, so it stays
      // where it is. Dropping good credentials because a socket timed out is its own kind of lie.
      renderGate(
        "Nothing has checked this token yet, and nothing about it has changed.",
        caught instanceof ApiError ? caught : undefined,
      );
      return;
    }
  }
  if (mine !== renderCount) return;
  setChrome(route);

  const name = route.parts[0];
  if (name === undefined) {
    await renderHome();
    if (mine === renderCount && options.focus) view.focus();
    return;
  }

  const screen = screens[name];
  if (screen === undefined) {
    view.replaceChildren(
      errorBox(
        { code: "not_implemented", message: `There is no Bashreactor screen at ${route.path}.` },
        el("a", { class: "btn btn--ink", href: "/app/", "data-link": "" }, "The entry page"),
      ),
    );
    return;
  }

  view.replaceChildren(stateLine("Loading."));
  try {
    await screen(view, route, signal);
  } catch (caught) {
    if (mine !== renderCount) return;
    // A 401 has already been answered where it was raised; a second gate would wipe the first one's
    // reason. This is the same rule as the token check above, one screen further down.
    if (caught instanceof ApiError && caught.status === 401) return;
    view.replaceChildren(
      errorBox(caught instanceof ApiError ? caught : { code: "internal_error", message: String(caught) }),
    );
  }
  if (mine === renderCount && options.focus) view.focus();
}

/**
 * A 401 is the server saying the token is gone, so it is cleared here and nowhere else: a refused
 * token left in storage comes back on the next page load and asks the same question.
 *
 * The message says which of the two it was. A token this page had already used had it taken away;
 * a token it never got through with was refused on arrival. "No longer" is the difference between
 * a token you still have and a token you have to go and mint.
 */
session.onUnauthorized = (error) => {
  const hadWorked = session.identity !== null;
  signOut();
  // The gate's own check already shows the server's words in the gate, and re-rendering it here
  // would wipe what the reader is typing.
  if (gateIsShown) return;
  // Whatever was drawing when the token died has to be told to stop, and told before the gate goes
  // up: a run page left running finishes over the gate with an error card of its own, and its poller
  // goes on asking with an empty bearer — whose late 401 would then clear a token typed since.
  leaving?.abort();
  renderCount++;
  renderGate(
    hadWorked
      ? "A call came back 401, so this token is no longer accepted. It has been cleared from this browser: sign in with one that works."
      : "The server refused that token, and it has been cleared from this browser. Nothing else was changed.",
    error,
  );
};

document.addEventListener("click", (event) => {
  const target = event.target as Element | null;
  const link = target?.closest?.("a[data-link]") as HTMLAnchorElement | null;
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  const href = link.getAttribute("href") ?? "";
  if (!href.startsWith(BASE)) return;
  event.preventDefault();
  navigate(href.slice(BASE.length) || "/");
});
window.addEventListener("popstate", () => void render({ focus: true }));

void render({ focus: false });
