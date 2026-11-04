import type { Block, Pipeline } from "./types.ts";

export interface ValidationIssue {
  path: string;
  message: string;
}

export function validateBlock(block: Block): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (block.name.trim() === "") issues.push({ path: "name", message: "must not be empty" });
  for (const section of ["inputs", "outputs"] as const) {
    const seen = new Set<string>();
    block[section].forEach((param, index) => {
      const path = `${section}[${index}].name`;
      if (param.name.trim() === "") issues.push({ path, message: "must not be empty" });
      if (seen.has(param.name)) issues.push({ path, message: `duplicate name "${param.name}"` });
      seen.add(param.name);
    });
  }
  return issues;
}

export function validatePipeline(pipeline: Pipeline): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (pipeline.name.trim() === "") issues.push({ path: "name", message: "must not be empty" });
  if (pipeline.steps.length === 0) issues.push({ path: "steps", message: "must not be empty" });

  const ids = new Set<string>();
  pipeline.steps.forEach((step, index) => {
    const path = `steps[${index}]`;
    if (step.id.trim() === "") issues.push({ path: `${path}.id`, message: "must not be empty" });
    if (ids.has(step.id)) issues.push({ path: `${path}.id`, message: `duplicate id "${step.id}"` });
    ids.add(step.id);
    if (step.block.trim() === "") issues.push({ path: `${path}.block`, message: "must not be empty" });
    if (!Number.isInteger(step.retries) || step.retries < 0) {
      issues.push({ path: `${path}.retries`, message: "must be a non-negative integer" });
    }
    if (step.timeoutSeconds !== undefined && !(step.timeoutSeconds > 0 && Number.isFinite(step.timeoutSeconds))) {
      issues.push({ path: `${path}.timeoutSeconds`, message: "must be a positive number" });
    }
  });

  pipeline.steps.forEach((step, index) => {
    step.needs.forEach((need, needIndex) => {
      if (!ids.has(need)) {
        issues.push({ path: `steps[${index}].needs[${needIndex}]`, message: `unknown step "${need}"` });
      }
    });
  });

  for (const cycle of findCycles(pipeline)) {
    issues.push({ path: "steps", message: `dependency cycle: ${cycle.join(" -> ")}` });
  }
  return issues;
}

function findCycles(pipeline: Pipeline): string[][] {
  const needsOf = new Map(pipeline.steps.map((step) => [step.id, step.needs]));
  const done = new Set<string>();
  const cycles: string[][] = [];

  const visit = (id: string, trail: string[]): void => {
    const seenAt = trail.indexOf(id);
    if (seenAt !== -1) {
      cycles.push([...trail.slice(seenAt), id]);
      return;
    }
    if (done.has(id)) return;
    for (const need of needsOf.get(id) ?? []) visit(need, [...trail, id]);
    done.add(id);
  };

  for (const id of needsOf.keys()) visit(id, []);
  return cycles;
}
