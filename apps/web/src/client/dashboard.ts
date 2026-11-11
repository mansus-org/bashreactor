// The dashboard. BASHR-56 draws it; until then the route says so rather than drawing a placeholder
// that could be mistaken for the screen.

import type { Route } from "./app.js";
import { notImplemented } from "./ui.js";

export function renderDashboard(view: HTMLElement, _route: Route, _signal: AbortSignal): void {
  notImplemented(view, "The dashboard", "BASHR-56");
}
