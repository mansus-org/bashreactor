// The browser's files, read as text so they can travel inside the bundle.
//
// This is the one JavaScript file in the package, and it exists because `with { type: "text" }` is a
// thing Bun does and TypeScript has no type for it: every import here would read as "module has no
// default export". So the imports live here, next to raw.d.ts, which says what they really give back.

import indexHtml from "./client/index.html" with { type: "text" };
import styleCss from "./client/style.css" with { type: "text" };
import appSource from "./client/app.ts" with { type: "text" };
import apiSource from "./client/api.ts" with { type: "text" };
import domSource from "./client/dom.ts" with { type: "text" };
import yamlSource from "./client/yaml.ts" with { type: "text" };
import modelSource from "./client/model.ts" with { type: "text" };
import graphSource from "./client/graph.ts" with { type: "text" };
import editorSource from "./client/editor.ts" with { type: "text" };
import runsSource from "./client/runs.ts" with { type: "text" };
import blocksSource from "./client/blocks.ts" with { type: "text" };
import logsSource from "./client/logs.ts" with { type: "text" };

export {
  indexHtml,
  styleCss,
  appSource,
  apiSource,
  domSource,
  yamlSource,
  modelSource,
  graphSource,
  editorSource,
  runsSource,
  blocksSource,
  logsSource,
};
