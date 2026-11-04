// What all three screens share: a small DOM helper, the 7x7 state signs, the browser-side store for
// edits made in the mockup, the demo-state switch and duration formatting.

window.BR = window.BR || {};

(() => {
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === false || value === null || value === undefined) continue;
      if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key === "value") node.value = value;
      else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child);
    }
    return node;
  }

  // Each state has a shape as well as a word, so a row can be read at a glance in two inks.
  const SIGNS = {
    queued: ["#######", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#######"],
    running: ["#.#.#.#", ".#.#.#.", "#.#.#.#", ".#.#.#.", "#.#.#.#", ".#.#.#.", "#.#.#.#"],
    succeeded: ["#######", "#######", "#######", "#######", "#######", "#######", "#######"],
    failed: ["#.....#", ".#...#.", "..#.#..", "...#...", "..#.#..", ".#...#.", "#.....#"],
    cancelled: ["#######", "#....##", "#...#.#", "#..#..#", "#.#...#", "##....#", "#######"],
  };

  function sign(state, className) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 7 7");
    svg.setAttribute("shape-rendering", "crispEdges");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("class", className || "sign");
    let d = "";
    SIGNS[state].forEach((row, y) => {
      [...row].forEach((cell, x) => {
        if (cell === "#") d += `M${x} ${y}h1v1h-1z`;
      });
    });
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "currentColor");
    svg.append(path);
    return svg;
  }

  function stateStamp(state) {
    return el("span", { class: "stamp" }, sign(state), state);
  }

  // Edits live in the browser so they survive moving between the screens. Firefox gives each file://
  // page its own storage, so there the screens fall back to the fixture.
  const PREFIX = "bashreactor.mockup.";
  const store = {
    get(key) {
      try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw === null ? null : JSON.parse(raw);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
      } catch {
        // Storage refused: the edit still holds for this page.
      }
    },
    clear() {
      try {
        Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => localStorage.removeItem(k));
      } catch {
        // Nothing stored, nothing to clear.
      }
    },
  };

  function library() {
    const made = store.get("blocks") || [];
    const merged = window.BashreactorData.blocks.map((b) => ({ ...b, versions: [...b.versions] }));
    for (const block of made) {
      const known = merged.find((b) => b.name === block.name);
      if (known) known.versions.push(...block.versions);
      else merged.push(block);
    }
    return merged;
  }

  function publish(name, source, note) {
    const made = store.get("blocks") || [];
    const all = library().find((b) => b.name === name);
    const version = all ? BR.model.latest(all).version + 1 : 1;
    let mine = made.find((b) => b.name === name);
    if (!mine) {
      mine = { name, versions: [] };
      made.push(mine);
    }
    mine.versions.push({ version, published: new Date().toISOString().slice(0, 10), note, source });
    store.set("blocks", made);
    return version;
  }

  function pipelineText() {
    return store.get("doc") || window.BashreactorData.pipeline;
  }

  function duration(total) {
    const seconds = Math.max(0, Math.floor(total));
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const pad = (n) => String(n).padStart(2, "0");
    if (d) return `${d} d ${h} h`;
    if (h) return `${h} h ${pad(m)} m`;
    if (m) return `${m} m ${pad(s)} s`;
    return `${s} s`;
  }

  function clock(total) {
    const seconds = Math.max(0, Math.floor(total));
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
  }

  // ?state=loading|empty|error shows a screen in that state, for review. The footer links set it.
  const demoState = new URLSearchParams(location.search).get("state") || "loaded";

  function flash(node) {
    node.classList.remove("is-new");
    // Reading layout restarts the animation when the same node repaints twice in a row.
    void node.offsetWidth;
    node.classList.add("is-new");
  }

  function announce(message) {
    const region = document.getElementById("announce");
    if (region) region.textContent = message;
  }

  function errorBox(error, ...actions) {
    return el(
      "div",
      { class: "state state--error", role: "alert" },
      el("p", { class: "state__head" }, el("span", { class: "stamp" }, sign("failed"), "error"), " ", el("code", {}, error.code)),
      el("p", {}, error.message),
      actions.length ? el("div", { class: "row" }, actions) : null,
    );
  }

  document.addEventListener("DOMContentLoaded", () => {
    const current = demoState;
    document.querySelectorAll("[data-demo-state]").forEach((link) => {
      if (link.dataset.demoState === current) link.setAttribute("aria-current", "true");
    });
    const reset = document.getElementById("reset");
    if (reset) {
      reset.addEventListener("click", () => {
        store.clear();
        location.href = location.pathname;
      });
    }
  });

  Object.assign(BR, { el, sign, stateStamp, store, library, publish, pipelineText, duration, clock, demoState, flash, announce, errorBox });
})();
