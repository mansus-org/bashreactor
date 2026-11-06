// What the browser gets from `./yaml-lib.js`. That file is not a source file: assets.ts serves the
// bundle that yaml-lib.macro.ts builds, so this is only the types the editor's TypeScript needs.
export { isAlias, isMap, isScalar, isSeq, stringify } from "yaml";
export { nodeToJs, parseYamlDocument } from "@bashreactor/core";
