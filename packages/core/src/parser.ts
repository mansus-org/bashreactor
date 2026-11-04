// The block and pipeline parsers. `parseBlock` turns a block file's header into a Block, and
// `parsePipeline` turns a pipeline file into a Pipeline; both throw a BashreactorError on the first
// problem they find. Full multi-error validation lives in validate.ts.

import { isMap } from "yaml";
import { splitBlockHeader } from "./block-header.ts";
import { BashreactorError } from "./errors.ts";
import { buildBlock, buildPipeline } from "./validate.ts";
import { parseYamlDocument } from "./yaml.ts";
import type { Block, Pipeline } from "./types.ts";

export function parseBlock(source: string): Block {
  const split = splitBlockHeader(source);
  if (!split.ok) throw new BashreactorError("block_header_malformed", split.error);
  return parseBlockHeaderText(split.header);
}

export function parseBlockHeaderText(header: string): Block {
  const yaml = parseYamlDocument(header);
  if (!yaml.ok) throw new BashreactorError("block_header_malformed", yaml.error);
  if (!isMap(yaml.root)) throw new BashreactorError("block_header_malformed", "the header must be a mapping");
  const { block, issues } = buildBlock(yaml.root, yaml.doc);
  if (issues.length > 0) {
    const first = issues[0]!;
    throw new BashreactorError(first.code, first.message, { path: first.path });
  }
  return block!;
}

export function parsePipeline(source: string): Pipeline {
  const yaml = parseYamlDocument(source);
  if (!yaml.ok) throw new BashreactorError("pipeline_yaml_invalid", yaml.error);
  const { pipeline, issues } = buildPipeline(yaml.root, yaml.doc);
  if (issues.length > 0) {
    const first = issues[0]!;
    throw new BashreactorError(first.code, first.message, { path: first.path });
  }
  return pipeline!;
}
