// The files the browser asks for, read into memory once at startup.
//
// The deployed image is one bundled `server.js` with nothing beside it — the Dockerfile copies that
// one file out of the build stage — so every asset has to be inside the bundle. Text comes in
// through `with { type: "text" }` imports, which bun build inlines; the three woff2 faces come in as
// base64 from fonts.ts, which apps/web/scripts/embed-fonts.ts generates from apps/web/fonts/.
//
// The browser code is TypeScript, because the repo is TypeScript and `bun run check` should read it.
// The browser is not, so each module is transpiled here, once, at startup, and served as `.js`.
// There is still no build step for the UI: what the server holds is what the source files say.

import { createHash } from "node:crypto";
import {
  apiSource,
  appSource,
  blocksSource,
  domSource,
  editorSource,
  graphSource,
  indexHtml,
  logsSource,
  modelSource,
  runPageSource,
  runSharedSource,
  runsListSource,
  styleBase,
  styleBlocks,
  styleDashboard,
  styleEditor,
  stylePipelines,
  styleRunPage,
  styleRunsList,
  styleSettings,
  styleShell,
  yamlEditSource,
  yamlLibSource,
  yamlSource,
} from "./raw.js";
import { FONT_BASE64, FONT_LICENCE } from "./fonts.ts";

export interface Asset {
  data: Uint8Array<ArrayBuffer>;
  ctype: string;
  etag: string;
  /** Fonts never change under a name; everything else is revalidated on every load. */
  immutable: boolean;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

const CLIENT_MODULES: Record<string, string> = {
  app: appSource,
  api: apiSource,
  dom: domSource,
  yaml: yamlSource,
  "yaml-edit": yamlEditSource,
  model: modelSource,
  graph: graphSource,
  editor: editorSource,
  "runs-list": runsListSource,
  "run-shared": runSharedSource,
  "run-page": runPageSource,
  blocks: blocksSource,
  logs: logsSource,
};

/** The stylesheet's files, in the one order the browser gets them. */
export const STYLE_FILES = [
  "base.css",
  "shell.css",
  "dashboard.css",
  "runs-list.css",
  "run-page.css",
  "pipelines.css",
  "editor.css",
  "blocks.css",
  "settings.css",
] as const;

const STYLE_SOURCES: Record<(typeof STYLE_FILES)[number], string> = {
  "base.css": styleBase,
  "shell.css": styleShell,
  "dashboard.css": styleDashboard,
  "runs-list.css": styleRunsList,
  "run-page.css": styleRunPage,
  "pipelines.css": stylePipelines,
  "editor.css": styleEditor,
  "blocks.css": styleBlocks,
  "settings.css": styleSettings,
};

/** The one file the browser loads, joined from the folder in a fixed order so the cascade is stable. */
export function buildStyleSheet(): string {
  return STYLE_FILES.map((name) => STYLE_SOURCES[name]).join("\n");
}

function asset(data: Uint8Array | string, name: string): Asset {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const dot = name.lastIndexOf(".");
  return {
    data: bytes,
    ctype: TYPES[name.slice(dot)] ?? "application/octet-stream",
    etag: `"${hash}"`,
    immutable: name.startsWith("assets/fonts/"),
  };
}

/** The table the mount serves: every path under `/app/` that is a file, keyed by the rest of the URL. */
export function buildAssets(): { index: Asset; files: Map<string, Asset> } {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const files = new Map<string, Asset>();
  for (const [name, source] of Object.entries(CLIENT_MODULES)) {
    // transformSync is typed for every loader Bun has; with loader "ts" it answers with a string.
    files.set(`assets/${name}.js`, asset(String(transpiler.transformSync(source)), `assets/${name}.js`));
  }
  // Already JavaScript, and a bundle of someone else's code: it is served as it was built.
  files.set("assets/yaml-lib.js", asset(yamlLibSource, "assets/yaml-lib.js"));
  files.set("assets/style.css", asset(buildStyleSheet(), "assets/style.css"));
  for (const [name, base64] of Object.entries(FONT_BASE64)) {
    files.set(`assets/fonts/${name}`, asset(Buffer.from(base64, "base64"), `assets/fonts/${name}`));
  }
  files.set("OFL.txt", asset(FONT_LICENCE, "OFL.txt"));
  return { index: asset(indexHtml, "index.html"), files };
}
