// The browser's files, read as text so they can travel inside the bundle.
//
// This is the one JavaScript file in the package, and it exists because `with { type: "text" }` is a
// thing Bun does and TypeScript has no type for it: every import here would read as "module has no
// default export". So the imports live here, next to raw.d.ts, which says what they really give back.

// The same reason, for the linter: it resolves `./client/app.ts` to the module and reports that it
// has no default export, which is true of the module and irrelevant to what bun hands back here.
/* eslint-disable import/default */

// One trap, for whoever adds a test here: bun's module cache keys on the resolved path and ignores
// the import attribute, so a file read as text here *is* the file a test imports as a module, and
// whichever loaded first wins. A test that wants a browser module's functions must take them from
// the transpiled text the server serves, under a specifier of its own — see client/logs.test.ts.

// The one thing here that is not a file on disk: the YAML parser the API validates with, bundled for the
// browser when this file is transpiled (see yaml-lib.macro.ts), so it is inside server.js like the rest.
import { yamlLibrary } from "./yaml-lib.macro.ts" with { type: "macro" };
import indexHtml from "./client/index.html" with { type: "text" };
import styleCss from "./client/style.css" with { type: "text" };
import appSource from "./client/app.ts" with { type: "text" };
import apiSource from "./client/api.ts" with { type: "text" };
import domSource from "./client/dom.ts" with { type: "text" };
import yamlSource from "./client/yaml.ts" with { type: "text" };
import yamlEditSource from "./client/yaml-edit.ts" with { type: "text" };
import modelSource from "./client/model.ts" with { type: "text" };
import graphSource from "./client/graph.ts" with { type: "text" };
import editorSource from "./client/editor.ts" with { type: "text" };
import runsSource from "./client/runs.ts" with { type: "text" };
import blocksSource from "./client/blocks.ts" with { type: "text" };
import logsSource from "./client/logs.ts" with { type: "text" };

const yamlLibSource = yamlLibrary();

export {
  yamlLibSource,
  indexHtml,
  styleCss,
  appSource,
  apiSource,
  domSource,
  yamlSource,
  yamlEditSource,
  modelSource,
  graphSource,
  editorSource,
  runsSource,
  blocksSource,
  logsSource,
};
