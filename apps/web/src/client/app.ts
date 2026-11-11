// The shell: the chrome, the router, the token gate and the sign-in screen. A screen is a function
// that fills `#view` from what the API returned; nothing here keeps a copy of a pipeline, a run or a
// block.

import { api, session, signIn, signOut, ApiError } from "./api.js";
import type { ApiError as GateError } from "./api.js";
import { announce, bitmap, clearAttribute, el, errorBox, stateLine } from "./dom.js";
import { typeStamp } from "./ui.js";
import { renderPipeline } from "./editor.js";
import { renderRunsList } from "./runs-list.js";
import { renderRunPage } from "./run-page.js";
import { renderBlocks } from "./blocks.js";
import { renderDashboard } from "./dashboard.js";
import { renderPipelines } from "./pipelines.js";
import { renderPipelinePage } from "./pipeline-page.js";
import { renderSettings } from "./settings.js";

/** Where the app is mounted. The server answers this path and everything under it. */
export const BASE = "/app";

export interface Route {
  /** The path under the mount point: "/", "/pipelines-new", "/runs/<id>". */
  path: string;
  parts: string[];
  query: URLSearchParams;
}

export type Screen = (view: HTMLElement, route: Route, signal: AbortSignal) => void | Promise<void>;

const view = document.getElementById("view")!;
const who = document.getElementById("who");
const menuButton = document.getElementById("menu-button") as HTMLButtonElement | null;
const menu = document.getElementById("menu");

const NAV_ITEMS = [
  {
    section: "dashboard",
    label: "Dashboard",
    href: "/app/",
    glyph: ["###.###", "###.###", "###.###", ".......", "###.###", "###.###", "###.###"],
  },
  {
    section: "runs",
    label: "Runs",
    href: "/app/runs",
    glyph: ["#......", "###....", "#####..", "#######", "#####..", "###....", "#......"],
  },
  {
    section: "pipelines",
    label: "Pipelines",
    href: "/app/pipelines",
    glyph: ["##...##", "##...##", ".#...#.", ".#####.", "...#...", "..###..", "..###.."],
  },
  {
    section: "blocks",
    label: "Blocks",
    href: "/app/blocks",
    glyph: ["#####..", "#...##.", "#....##", "#.....#", "#.....#", "#.....#", "#######"],
  },
  {
    section: "settings",
    label: "Settings",
    href: "/app/settings",
    glyph: [".#.....", "#######", ".#.....", ".......", "....#..", "#######", "....#.."],
  },
] as const;

const NAV_SECTIONS = new Set<string>(["dashboard", "runs", "pipelines", "blocks", "settings"]);

/** The nav containers in the shell: the sidebar's two, the mobile menu's one, or a test's `.nav`. */
const navContainers: HTMLElement[] = [...document.querySelectorAll<HTMLElement>("[data-nav]")];
if (navContainers.length === 0) {
  const legacy = document.querySelector<HTMLElement>(".nav");
  if (legacy !== null) navContainers.push(legacy);
}

function navLink(item: (typeof NAV_ITEMS)[number]): HTMLElement {
  return el(
    "a",
    {
      class: "nav__link",
      href: item.href,
      "data-link": "",
      "data-section": item.section,
    },
    bitmap(item.glyph, "nav__glyph"),
    item.label,
  );
}

function fillNav(): void {
  for (const container of navContainers) {
    if (container.children.length > 0) continue;
    const which = container.dataset.nav;
    const items =
      which === "settings"
        ? NAV_ITEMS.filter((item) => item.section === "settings")
        : which === "menu"
          ? NAV_ITEMS
          : NAV_ITEMS.filter((item) => item.section !== "settings");
    container.append(el("ul", { class: "nav__list" }, ...items.map((item) => el("li", {}, navLink(item)))));
  }
}
fillNav();

const menuNav = document.querySelector<HTMLElement>('[data-nav="menu"]');

function closeMenu(returnFocus = true): void {
  if (menu === null || menuButton === null) return;
  menu.hidden = true;
  menuButton.setAttribute("aria-expanded", "false");
  if (menuNav !== null) menuNav.hidden = true;
  if (returnFocus) menuButton.focus();
}

function menuFocusables(): HTMLElement[] {
  if (menu === null) return [];
  const links = [...menu.querySelectorAll<HTMLElement>("a[data-link]")];
  const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")].filter((node) => !node.disabled);
  return [...links, ...buttons].filter((node) => !node.hidden);
}

function openMenu(): void {
  if (menu === null || menuButton === null || session.identity === null) return;
  menu.hidden = false;
  menuButton.setAttribute("aria-expanded", "true");
  if (menuNav !== null) menuNav.hidden = false;
  menuFocusables()[0]?.focus();
}

if (menuButton !== null) {
  menuButton.addEventListener("click", () => {
    if (menu?.hidden === false) closeMenu();
    else openMenu();
  });
  menuButton.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Escape" && menu?.hidden === false) {
      (event as KeyboardEvent).preventDefault();
      closeMenu();
    }
  });
}
if (menu !== null) {
  menu.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "Escape") {
      (event as KeyboardEvent).preventDefault();
      closeMenu();
      return;
    }
    if (key !== "Tab") return;
    const focusable = menuFocusables();
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if ((event as KeyboardEvent).shiftKey && active === first) {
      (event as KeyboardEvent).preventDefault();
      last.focus();
    } else if (!(event as KeyboardEvent).shiftKey && active === last) {
      (event as KeyboardEvent).preventDefault();
      first.focus();
    }
  });
  menu.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (target?.closest?.("a[data-link]") != null || target?.closest?.("button") != null) closeMenu();
  });
}

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
 * Which nav item a route sits under. A detail page counts as its section: `/runs/x` is Runs,
 * `/pipelines-new` is Pipelines and `/blocks-new` is Blocks.
 */
function sectionOf(route: Route): string {
  const first = route.parts[0] ?? "";
  if (first === "" || first === "dashboard") return "dashboard";
  if (first === "pipeline" || first === "pipelines-new") return "pipelines";
  if (first === "blocks-new") return "blocks";
  if (NAV_SECTIONS.has(first)) return first;
  return "dashboard";
}

function setChrome(route: Route): void {
  const identity = session.identity;
  for (const container of navContainers) container.hidden = identity === null;
  if (menuNav !== null) menuNav.hidden = identity === null || menu?.hidden !== false;
  if (menuButton !== null) menuButton.hidden = identity === null;
  if (identity === null) {
    who?.replaceChildren();
    document.querySelectorAll<HTMLElement>("[data-who]").forEach((node) => node.replaceChildren());
    return;
  }
  const section = sectionOf(route);
  document.querySelectorAll<HTMLElement>("a[data-section]").forEach((link) => {
    if (link.dataset.section === section) link.setAttribute("aria-current", "page");
    else clearAttribute(link, "aria-current");
  });
  const identityNodes = () => [
    el("span", { class: "who__name" }, identity.name),
    typeStamp(identity.admin ? "admin" : identity.scope),
    el(
      "button",
      {
        class: "btn btn--text",
        type: "button",
        onclick: () => {
          signOut();
          void render({ focus: true });
        },
      },
      "Sign out",
    ),
  ];
  who?.replaceChildren(...identityNodes());
  document.querySelectorAll<HTMLElement>("[data-who]").forEach((node) => node.replaceChildren(...identityNodes()));
}

/**
 * Whether the gate is what is on screen. Its own check puts its own errors in its own box; a 401
 * from anywhere else is the gate's to announce.
 */
let gateIsShown = false;

/** The gate: the first screen, and the one a 401 comes back to. It is drawn without the sidebar. */
function renderGate(message: string, error?: GateError): void {
  gateIsShown = true;
  document.body.classList.add("gate-only");
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
          el("h1", { class: "wordmark" }, "Bashreactor"),
          el(
            "p",
            { class: "lead" },
            "A resumable pipeline runner for bash: one YAML file says what runs, every step is one bash file, and a run is a directory you can restart.",
          ),
          el("p", { class: "help" }, message),
        ),
      ),
      form,
    ),
  );
  token.focus();
}

/**
 * The old editor addresses, rewritten in place so Back does not send the reader round the loop again.
 * `/pipeline` was the editor for a new document; `/pipeline/:name/:version` was the same document at
 * a version. `/pipeline/:name` is kept too, because it was a legal address for a long time.
 */
function redirectFor(route: Route): string | null {
  if (route.parts[0] !== "pipeline") return null;
  const name = route.parts[1];
  if (name === undefined) return "/pipelines-new";
  if (route.parts[2] !== undefined) {
    return `/pipelines/${encodeURIComponent(name)}/edit?version=${encodeURIComponent(route.parts[2])}`;
  }
  return `/pipelines/${encodeURIComponent(name)}/edit`;
}

function screenFor(route: Route): Screen | null {
  const first = route.parts[0];
  if (first === undefined) return renderDashboard;
  switch (first) {
    case "runs": {
      const id = route.parts[1];
      return id === undefined ? renderRunsList : (target, _route, signal) => renderRunPage(target, id, signal);
    }
    case "pipelines-new":
      return renderPipeline;
    case "pipelines":
      if (route.parts.length === 1) return renderPipelines;
      if (route.parts[2] === "edit") return renderPipeline;
      return renderPipelinePage;
    case "blocks":
    case "blocks-new":
      return renderBlocks;
    case "settings":
      return renderSettings;
    default:
      return null;
  }
}

function titleFor(route: Route): string {
  const first = route.parts[0];
  if (first === undefined) return "Dashboard";
  if (first === "runs") return route.parts[1] === undefined ? "Runs" : `Run ${route.parts[1]}`;
  if (first === "pipelines-new") return "New pipeline";
  if (first === "pipelines") return route.parts[1] === undefined ? "Pipelines" : route.parts[1]!;
  if (first === "blocks-new") return "New block";
  if (first === "blocks") return route.parts[1] === undefined ? "Blocks" : route.parts[1]!;
  if (first === "settings") return "Settings";
  return route.parts.join(" ");
}

async function render(options: { focus: boolean }): Promise<void> {
  gateIsShown = false;
  document.body.classList.remove("gate-only");
  const mine = ++renderCount;
  leaving?.abort();
  leaving = new AbortController();
  const signal = leaving.signal;
  let route = routeNow();
  const redirect = redirectFor(route);
  if (redirect !== null) {
    history.replaceState({}, "", `${BASE}${redirect}`);
    route = routeNow();
  }
  document.title = `${titleFor(route)} — Bashreactor`;

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

  const screen = screenFor(route);
  if (screen === null) {
    view.replaceChildren(
      errorBox(
        { code: "not_implemented", message: `There is no Bashreactor screen at ${route.path}.` },
        el("a", { class: "btn btn--ink", href: "/app/", "data-link": "" }, "The dashboard"),
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
