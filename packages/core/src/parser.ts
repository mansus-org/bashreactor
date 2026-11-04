import { NotImplementedError } from "./errors.ts";
import type { Block, Pipeline } from "./types.ts";

// TODO(parser): the block declaration and pipeline YAML parsers land here, once docs/SPEC.md (BASHR-1)
// fixes the syntax. They produce the types in types.ts and report problems through validate.ts.

export function parseBlock(_source: string): Block {
  throw new NotImplementedError("parseBlock");
}

export function parsePipeline(_source: string): Pipeline {
  throw new NotImplementedError("parsePipeline");
}
