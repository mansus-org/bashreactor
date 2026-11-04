import { BashreactorError, NotImplementedError, type Pipeline, validatePipeline } from "@bashreactor/core";

export function startRun(pipeline: Pipeline): never {
  const issues = validatePipeline(pipeline);
  if (issues.length > 0) {
    const detail = issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new BashreactorError("invalid_pipeline", detail);
  }
  throw new NotImplementedError("the run engine (BASHR-3)");
}
