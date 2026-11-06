// Draws one analysis of the document. Steps are real buttons so the graph is walkable and readable
// without a mouse; the SVG behind them only holds the wires and is hidden from assistive tech.
//
// Two layouts, picked by the room the stage has and not by device: columns by dependency depth when
// every column fits, otherwise one column of steps with the wires in lanes down its left side.
// Ported from mockup/graph.js, which drew a document whose blocks were all local: here the contracts
// arrive from the API after the first paint, and a wire has to cope with that.

import { el, flash, sign } from "./dom.js";
import type { Analysis, Step } from "./model.js";

const NS = "http://www.w3.org/2000/svg";
const PAD = 20;
const GAP = 64;
const MIN_NODE = 184;
const MAX_NODE = 280;
const NODE_GAP = 24;
const LANE = 14;

export interface Graph {
  update(next: { analysis: Analysis; selected: string | null; stale: boolean }): void;
  select(id: string | null): void;
  flash(ids: string[]): void;
  focus(id: string): void;
}

function port(direction: "in" | "out", item: { name: string; source?: { refs: unknown[] } }): HTMLElement {
  const wired = direction === "out" || (item.source?.refs.length ?? 0) > 0;
  return el(
    "span",
    { class: `port port--${direction}`, "data-dir": direction, "data-name": item.name },
    el("span", { class: `port__mark${wired ? "" : " port__mark--value"}` }),
    el("span", { class: "port__name" }, item.name),
  );
}

function wirePath(svg: SVGSVGElement, d: string, edge: { from: string; to: string; kind: string }): void {
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("class", `wire${edge.kind === "needs" ? " wire--needs" : ""}`);
  path.dataset.from = edge.from;
  path.dataset.to = edge.to;
  svg.append(path);
}

// A port only exists once the block's contract has been read, and the contract is the API's, so the
// first paint of a stored pipeline has a wire whose source step has no output ports at all. The
// reference is still real and the wire still has to show, so it meets the step's own edge, which is
// where a `needs` wire meets it anyway. Only the source side can be missing one: a `with:` key makes
// its input port whatever the contract says, so the target always has one to give.
function nodeEdge(node: HTMLElement, side: "in" | "out"): { x: number; y: number } {
  return {
    x: side === "out" ? Math.round(node.offsetLeft + node.offsetWidth) : node.offsetLeft,
    y: node.offsetTop + 22,
  };
}

export function createGraph(stage: HTMLElement, handlers: { onSelect: (id: string, from: "graph") => void }): Graph {
  let analysis: Analysis | null = null;
  let selected: string | null = null;
  let stale = false;
  let width = 0;

  function nodeLabel(step: Step): string {
    if (analysis === null) return `Step ${step.id}`;
    const parts = [`Step ${step.id}`];
    if (step.title) parts.push(step.title);
    parts.push(step.uses !== null ? `runs ${step.uses}` : "no block set");
    if (step.deps.length > 0) parts.push(`waits for ${step.deps.join(", ")}`);
    const feeds = analysis.edges.filter((edge) => edge.from === step.id).map((edge) => edge.to);
    if (feeds.length > 0) parts.push(`feeds ${[...new Set(feeds)].join(", ")}`);
    const problems = analysis.problems.filter((problem) => problem.step === step.id).length;
    if (problems > 0) parts.push(`${problems} ${problems === 1 ? "problem" : "problems"}`);
    return parts.join(", ");
  }

  function buildNode(step: Step): HTMLButtonElement {
    if (analysis === null) return el("button", { type: "button" });
    const problems = analysis.problems.filter((problem) => problem.step === step.id).length;
    const meta: string[] = [];
    if (step.timeout !== null) meta.push(`timeout ${step.timeout}`);
    if (step.maxAttempts !== null) meta.push(`${step.maxAttempts} attempts`);
    return el(
      "button",
      {
        type: "button",
        class: "node",
        "data-step": step.id,
        "aria-pressed": String(step.id === selected),
        "aria-label": nodeLabel(step),
        tabindex: "-1",
        disabled: stale,
        onclick: () => handlers.onSelect(step.id, "graph"),
      },
      el(
        "span",
        { class: "node__head" },
        el("span", { class: "node__id" }, step.id),
        step.contract !== null ? el("span", { class: "stamp stamp--type" }, step.contract.runtime) : null,
      ),
      step.title !== "" ? el("span", { class: "node__title" }, step.title) : null,
      el("span", { class: "node__uses" }, step.uses ?? "no block"),
      meta.length > 0 ? el("span", { class: "node__meta" }, meta.join(", ")) : null,
      problems > 0
        ? el("span", { class: "node__problem" }, el("span", { class: "stamp" }, sign("failed"), problems === 1 ? "1 problem" : `${problems} problems`))
        : null,
      step.inputs.length > 0 || step.outputs.length > 0
        ? el(
            "span",
            { class: "node__ports" },
            el("span", { class: "ports ports--in" }, step.inputs.map((input) => port("in", input))),
            el("span", { class: "ports ports--out" }, step.outputs.map((output) => port("out", output))),
          )
        : null,
    );
  }

  function setRovingTab(): void {
    const nodes = [...stage.querySelectorAll<HTMLButtonElement>(".node")];
    const target = nodes.find((node) => node.dataset.step === selected) ?? nodes[0];
    nodes.forEach((node) => {
      node.tabIndex = node === target ? 0 : -1;
    });
  }

  function markSelection(): void {
    stage.querySelectorAll(".node").forEach((node) => node.setAttribute("aria-pressed", String(node.getAttribute("data-step") === selected)));
    stage.querySelectorAll<SVGPathElement>(".wire").forEach((wire) => {
      wire.classList.toggle("is-on", wire.dataset.from === selected || wire.dataset.to === selected);
    });
    setRovingTab();
  }

  function layoutFlow(canvas: HTMLElement, svg: SVGSVGElement, available: number): void {
    if (analysis === null) return;
    const model = analysis;
    const count = model.layers.length;
    const nodeWidth = Math.min(MAX_NODE, Math.floor((available - PAD * 2 - GAP * (count - 1)) / count));
    const longEdges = model.edges.filter((edge) => model.byId[edge.to]!.layer - model.byId[edge.from]!.layer !== 1);
    const lanes = [...new Set(longEdges.map((edge) => `${edge.from}:${edge.out ?? edge.to}`))];
    const top = PAD + lanes.length * LANE;

    const heights = model.layers.map((ids) => {
      let total = 0;
      for (const id of ids) {
        const node = canvas.querySelector<HTMLElement>(`[data-step="${CSS.escape(id)}"]`)!;
        node.style.width = `${nodeWidth}px`;
        total += node.offsetHeight;
      }
      return total + NODE_GAP * (ids.length - 1);
    });
    const tallest = Math.max(...heights);
    const totalWidth = count * nodeWidth + (count - 1) * GAP + PAD * 2;
    const height = tallest + top + PAD;
    canvas.style.width = `${Math.max(totalWidth, available)}px`;
    canvas.style.height = `${height}px`;
    const left = Math.max(PAD, Math.floor((available - totalWidth) / 2) + PAD);

    model.layers.forEach((ids, column) => {
      let y = top + Math.floor((tallest - heights[column]!) / 2);
      for (const id of ids) {
        const node = canvas.querySelector<HTMLElement>(`[data-step="${CSS.escape(id)}"]`)!;
        node.style.left = `${left + column * (nodeWidth + GAP)}px`;
        node.style.top = `${y}px`;
        y += node.offsetHeight + NODE_GAP;
      }
    });

    const box = canvas.getBoundingClientRect();
    const centre = (element: Element) => {
      const r = element.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2 - box.left), y: Math.round(r.top + r.height / 2 - box.top) };
    };
    // Where each end of a wire sits: on its port when the contract has named one, on the step otherwise.
    const portAt = (node: HTMLElement, selector: string, side: "in" | "out") => {
      const mark = node.querySelector(selector);
      return mark !== null ? centre(mark) : nodeEdge(node, side);
    };
    // Wires that share a source output share a track, which reads as one line branching.
    const tracks: Record<string, string[]> = {};
    const trackIn = (gap: string, key: string) => {
      const list = (tracks[gap] ??= []);
      if (!list.includes(key)) list.push(key);
    };
    for (const edge of model.edges) {
      const from = model.byId[edge.from]!;
      const to = model.byId[edge.to]!;
      trackIn(String(from.layer), `${edge.from}:${edge.out ?? edge.to}`);
      if (to.layer - from.layer !== 1) trackIn(String(to.layer - 1), `${edge.from}:${edge.out ?? edge.to}:end`);
    }
    const trackX = (gap: number, key: string) => {
      const list = tracks[String(gap)] ?? [key];
      const base = left + (gap + 1) * nodeWidth + gap * GAP;
      return base + Math.round((GAP * (list.indexOf(key) + 1)) / (list.length + 1));
    };

    for (const edge of model.edges) {
      const key = `${edge.from}:${edge.out ?? edge.to}`;
      const fromNode = canvas.querySelector<HTMLElement>(`[data-step="${CSS.escape(edge.from)}"]`)!;
      const toNode = canvas.querySelector<HTMLElement>(`[data-step="${CSS.escape(edge.to)}"]`)!;
      const fromLayer = model.byId[edge.from]!.layer;
      const toLayer = model.byId[edge.to]!.layer;
      const a =
        edge.kind === "data"
          ? portAt(fromNode, `.port--out[data-name="${CSS.escape(edge.out ?? "")}"] .port__mark`, "out")
          : nodeEdge(fromNode, "out");
      const b =
        edge.kind === "data"
          ? portAt(toNode, `.port--in[data-name="${CSS.escape(edge.in ?? "")}"] .port__mark`, "in")
          : nodeEdge(toNode, "in");
      const mid = trackX(fromLayer, key);
      if (toLayer - fromLayer === 1) {
        wirePath(svg, `M${a.x} ${a.y}H${mid}V${b.y}H${b.x}`, edge);
      } else {
        // A wire that skips a column runs along the top, so it never crosses a step.
        const lane = PAD + lanes.indexOf(key) * LANE;
        const end = trackX(toLayer - 1, `${key}:end`);
        wirePath(svg, `M${a.x} ${a.y}H${mid}V${lane}H${end}V${b.y}H${b.x}`, edge);
      }
    }
  }

  function layoutLanes(canvas: HTMLElement, svg: SVGSVGElement, available: number): void {
    if (analysis === null) return;
    const model = analysis;
    const position: Record<string, number> = Object.fromEntries(model.order.map((id, index) => [id, index]));
    // Wires leaving the same output share a lane, the rest take the first lane free over their span.
    const groups = new Map<string, { key: string; from: number; to: number }>();
    for (const edge of model.edges) {
      const key = `${edge.from}:${edge.out ?? edge.to}`;
      const group = groups.get(key) ?? { key, from: position[edge.from]!, to: position[edge.from]! };
      group.to = Math.max(group.to, position[edge.to]!);
      group.from = Math.min(group.from, position[edge.to]!);
      groups.set(key, group);
    }
    const laneEnds: number[] = [];
    const laneOf: Record<string, number> = {};
    for (const group of [...groups.values()].toSorted((a, b) => a.from - b.from || a.to - b.to)) {
      let lane = laneEnds.findIndex((end) => end <= group.from);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = group.to;
      laneOf[group.key] = lane;
    }
    const lanes = laneEnds.length;
    const left = Math.max(PAD, 10 + (lanes + 1) * LANE);
    const nodeWidth = Math.max(MIN_NODE, available - left - 14);

    let y = PAD;
    for (const id of model.order) {
      const node = canvas.querySelector<HTMLElement>(`[data-step="${CSS.escape(id)}"]`)!;
      node.style.width = `${nodeWidth}px`;
      node.style.left = `${left}px`;
      node.style.top = `${y}px`;
      y += node.offsetHeight + NODE_GAP;
    }
    canvas.style.width = `${Math.max(left + nodeWidth + 14, available)}px`;
    canvas.style.height = `${y - NODE_GAP + PAD}px`;

    const box = canvas.getBoundingClientRect();
    const centreY = (element: Element) => {
      const r = element.getBoundingClientRect();
      return Math.round(r.top + r.height / 2 - box.top);
    };
    // Same as in the flow layout, one axis: the lane a wire runs down is set by its endpoints, not by
    // where they attach, so a wire without ports keeps the same lane.
    const portY = (node: HTMLElement, selector: string) => {
      const mark = node.querySelector(selector);
      return mark !== null ? centreY(mark) : node.offsetTop + 22;
    };
    for (const edge of model.edges) {
      const key = `${edge.from}:${edge.out ?? edge.to}`;
      const fromNode = canvas.querySelector<HTMLElement>(`[data-step="${CSS.escape(edge.from)}"]`)!;
      const toNode = canvas.querySelector<HTMLElement>(`[data-step="${CSS.escape(edge.to)}"]`)!;
      const fromY =
        edge.kind === "data"
          ? portY(fromNode, `.port--out[data-name="${CSS.escape(edge.out ?? "")}"] .port__mark`)
          : fromNode.offsetTop + 22;
      const toY =
        edge.kind === "data"
          ? portY(toNode, `.port--in[data-name="${CSS.escape(edge.in ?? "")}"] .port__mark`)
          : toNode.offsetTop + 22;
      const x = LANE + laneOf[key]! * LANE;
      wirePath(svg, `M${left} ${fromY}H${x}V${toY}H${left}`, edge);
    }
  }

  function draw(): void {
    if (analysis === null) return;
    const active = document.activeElement !== null && stage.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.step : null;
    stage.textContent = "";
    stage.classList.toggle("stage--stale", stale);
    width = stage.clientWidth;

    if (analysis.steps.length === 0) {
      stage.append(
        el(
          "div",
          { class: "stage__empty" },
          sign("queued", "sign sign--large"),
          el("p", {}, "No steps yet. Press Add step, or type a step under ", el("code", {}, "steps:"), " in the YAML."),
        ),
      );
      return;
    }

    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "wires");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("shape-rendering", "crispEdges");
    const canvas = el("div", { class: "canvas" });
    canvas.append(svg);
    for (const id of analysis.order) canvas.append(buildNode(analysis.byId[id]!));
    stage.append(canvas);

    const count = analysis.layers.length;
    const flowFits = width >= count * MIN_NODE + (count - 1) * GAP + PAD * 2;
    stage.classList.toggle("stage--flow", flowFits);
    stage.classList.toggle("stage--lanes", !flowFits);
    if (flowFits) layoutFlow(canvas, svg, width);
    else layoutLanes(canvas, svg, width);
    svg.setAttribute("width", String(canvas.offsetWidth));
    svg.setAttribute("height", String(canvas.offsetHeight));

    markSelection();
    if (active !== null && active !== undefined) {
      const again = stage.querySelector<HTMLElement>(`[data-step="${CSS.escape(active)}"]`);
      if (again !== null) again.focus();
    }
  }

  stage.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    const node = target?.closest?.(".node") as HTMLElement | null;
    if (node === null || node === undefined || analysis === null) return;
    const id = node.dataset.step!;
    const order = analysis.order;
    const index = order.indexOf(id);
    let next: string | undefined;
    if (event.key === "ArrowDown") next = order[index + 1];
    if (event.key === "ArrowUp") next = order[index - 1];
    if (event.key === "ArrowRight") next = analysis.edges.find((edge) => edge.from === id)?.to;
    if (event.key === "ArrowLeft") next = analysis.edges.find((edge) => edge.to === id)?.from;
    if (event.key === "Home") next = order[0];
    if (event.key === "End") next = order[order.length - 1];
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (next === undefined) return;
    handlers.onSelect(next, "graph");
    const target2 = stage.querySelector<HTMLElement>(`[data-step="${CSS.escape(next)}"]`);
    if (target2 !== null) target2.focus();
  });

  new ResizeObserver(() => {
    if (stage.clientWidth !== width) draw();
  }).observe(stage);

  return {
    update(next) {
      analysis = next.analysis;
      selected = next.selected;
      stale = next.stale;
      draw();
    },
    select(id) {
      selected = id;
      markSelection();
    },
    flash(ids) {
      for (const id of ids) flash(stage.querySelector(`[data-step="${CSS.escape(id)}"]`));
    },
    focus(id) {
      stage.querySelector<HTMLElement>(`[data-step="${CSS.escape(id)}"]`)?.focus();
    },
  };
}
