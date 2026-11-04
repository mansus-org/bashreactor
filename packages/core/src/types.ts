// The parsed, in-memory shape of blocks and pipelines. docs/SPEC.md owns the on-disk syntax; the parser
// turns that into these, so nothing here should know how a declaration is spelled.

export interface BlockParam {
  name: string;
}

export interface Block {
  name: string;
  inputs: readonly BlockParam[];
  outputs: readonly BlockParam[];
}

export interface PipelineStep {
  id: string;
  block: string;
  needs: readonly string[];
  retries: number;
  // Seconds, whatever unit the syntax ends up using, so the engine never parses durations. Unset means
  // no timeout: jobs are expected to run for hours.
  timeoutSeconds?: number;
}

export interface Pipeline {
  name: string;
  steps: readonly PipelineStep[];
}
