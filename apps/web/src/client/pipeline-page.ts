// One pipeline and its tabs. BASHR-57 draws it; the route says so until then.

import type { Route } from "./app.js";
import { notImplemented } from "./ui.js";

export function renderPipelinePage(view: HTMLElement, _route: Route, _signal: AbortSignal): void {
  notImplemented(view, "The pipeline page", "BASHR-57");
}
