import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateBlockSource, validatePipelineSource } from "./validate.ts";
import type { BlockResolver } from "./validate.ts";

const examples = new URL("../../../docs/examples/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, examples), "utf8");

function resolver(blocks: Record<string, string>): BlockResolver {
  return {
    resolve: (uses) => (blocks[uses] ? { ok: true, source: blocks[uses]! } : { ok: false }),
  };
}

const noOutputBlock = `#!/usr/bin/env bash
# ---
# name: sink
# ---
`;

const intOutBlock = `#!/usr/bin/env bash
# ---
# name: ints
# outputs:
#   total:
#     type: integer
# ---
`;

const jsonOutBlock = `#!/usr/bin/env bash
# ---
# name: jsons
# outputs:
#   top:
#     type: json
# ---
`;

void jsonOutBlock;

const strInBlock = `#!/usr/bin/env bash
# ---
# name: echoer
# inputs:
#   x:
#     type: string
# outputs:
#   out:
#     type: string
# ---
`;

const boolInBlock = `#!/usr/bin/env bash
# ---
# name: gate
# inputs:
#   n:
#     type: boolean
# ---
`;

describe("validateBlockSource", () => {
  test("accepts a valid block", () => {
    expect(validateBlockSource(noOutputBlock)).toEqual([]);
  });

  test("reports every broken rule in one header", () => {
    const bad = `#!/usr/bin/env bash
# ---
# name: 1bad
# inputs:
#   A:
#     type: string
#     extra: 1
# ---
`;
    const codes = validateBlockSource(bad).map((issue) => `${issue.path}:${issue.code}`);
    expect(codes).toContain("name:block_schema_invalid");
    expect(codes).toContain("inputs.A:block_schema_invalid");
    expect(codes).toContain("inputs.A.extra:block_schema_invalid");
  });

  test("reports a malformed header as one error", () => {
    expect(validateBlockSource("not a block")).toEqual([
      expect.objectContaining({ code: "block_header_malformed" }),
    ]);
  });
});

describe("validatePipelineSource", () => {
  test("the worked example validates clean", () => {
    const issues = validatePipelineSource(read("word-report.yaml"), resolver({
      "./generate-corpus.sh": read("generate-corpus.sh"),
      "./check-corpus.sh": read("check-corpus.sh"),
      "./count-words.sh": read("count-words.sh"),
      "./render-report.sh": read("render-report.sh"),
    }));
    expect(issues).toEqual([]);
  });

  test("a YAML-level problem is one pipeline_yaml_invalid", () => {
    const issues = validatePipelineSource("name: a\nname: b\nsteps:\n  s:\n    uses: ./x.sh\n", resolver({}));
    expect(issues.map((issue) => issue.code)).toEqual(["pipeline_yaml_invalid"]);
  });

  test("reports several independent schema rules at once", () => {
    const source = [
      "name: a",
      "bogus: 1",
      "steps:",
      "  s:",
      "    uses: ./x.sh",
      "    timeout: 0s",
      "    retry:",
      "      max_attempts: 0",
      "",
    ].join("\n");
    const issues = validatePipelineSource(source, resolver({ "./x.sh": noOutputBlock }));
    const byPath = new Map(issues.map((issue) => [issue.path, issue.code]));
    expect(byPath.get("bogus")).toBe("pipeline_schema_invalid");
    expect(byPath.get("steps.s.timeout")).toBe("pipeline_schema_invalid");
    expect(byPath.get("steps.s.retry.max_attempts")).toBe("pipeline_schema_invalid");
  });

  test("needs naming an undeclared step is unknown_step with the index", () => {
    const source = "name: a\nsteps:\n  s:\n    uses: ./x.sh\n    needs: [ghost]\n";
    const issues = validatePipelineSource(source, resolver({ "./x.sh": noOutputBlock }));
    expect(issues).toEqual([
      expect.objectContaining({ code: "unknown_step", path: "steps.s.needs.0" }),
    ]);
  });

  test("an expression naming an undeclared step is unknown_step", () => {
    const source = 'name: a\nsteps:\n  s:\n    uses: ./x.sh\n    with:\n      x: ${{ steps.ghost.outputs.out }}\n';
    const issues = validatePipelineSource(source, resolver({ "./x.sh": strInBlock }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "unknown_step", path: "steps.s.with.x" }));
  });

  test("an expression naming an undeclared input is unknown_input", () => {
    const source = 'name: a\nsteps:\n  s:\n    uses: ./x.sh\n    with:\n      x: ${{ inputs.ghost }}\n';
    const issues = validatePipelineSource(source, resolver({ "./x.sh": strInBlock }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "unknown_input", path: "steps.s.with.x" }));
  });

  test("an expression naming an undeclared output is unknown_output", () => {
    const source = [
      "name: a",
      "steps:",
      "  a:",
      "    uses: ./a.sh",
      "    with:",
      "      x: ${{ steps.b.outputs.nope }}",
      "  b:",
      "    uses: ./b.sh",
      "",
    ].join("\n");
    const issues = validatePipelineSource(source, resolver({ "./a.sh": strInBlock, "./b.sh": intOutBlock }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "unknown_output", path: "steps.a.with.x" }));
  });

  test("a with key that is not a block input is unknown_input", () => {
    const source = "name: a\nsteps:\n  s:\n    uses: ./x.sh\n    with:\n      nope: 1\n";
    const issues = validatePipelineSource(source, resolver({ "./x.sh": strInBlock }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "unknown_input", path: "steps.s.with.nope" }));
  });

  test("a required input absent from with is missing_input", () => {
    const source = "name: a\nsteps:\n  s:\n    uses: ./x.sh\n";
    const issues = validatePipelineSource(source, resolver({ "./x.sh": strInBlock }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "missing_input", path: "steps.s.with.x" }));
  });

  test("a whole expression with the wrong type is type_mismatch", () => {
    const source = [
      "name: a",
      "steps:",
      "  a:",
      "    uses: ./a.sh",
      "    with:",
      "      n: ${{ steps.b.outputs.total }}",
      "  b:",
      "    uses: ./b.sh",
      "",
    ].join("\n");
    const issues = validatePipelineSource(source, resolver({ "./a.sh": boolInBlock, "./b.sh": intOutBlock }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "type_mismatch", path: "steps.a.with.n" }));
  });

  test("a template binding to a non-string input is type_mismatch", () => {
    const source = [
      "name: a",
      "inputs:",
      "  title:",
      "    type: string",
      "steps:",
      "  s:",
      "    uses: ./x.sh",
      "    with:",
      '      n: "${{ inputs.title }}!"',
      "",
    ].join("\n");
    const issues = validatePipelineSource(source, resolver({ "./x.sh": boolInBlock }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "type_mismatch", path: "steps.s.with.n" }));
  });

  test("a dependency cycle is one error per component", () => {
    const source = "name: a\nsteps:\n  a:\n    uses: ./x.sh\n    needs: [b]\n  b:\n    uses: ./x.sh\n    needs: [a]\n";
    const issues = validatePipelineSource(source, resolver({ "./x.sh": noOutputBlock }));
    expect(issues).toEqual([
      expect.objectContaining({ code: "dependency_cycle", path: "steps.a.needs" }),
    ]);
  });

  test("a step that needs itself is a cycle", () => {
    const source = "name: a\nsteps:\n  a:\n    uses: ./x.sh\n    needs: [a]\n";
    const issues = validatePipelineSource(source, resolver({ "./x.sh": noOutputBlock }));
    expect(issues).toEqual([
      expect.objectContaining({ code: "dependency_cycle", path: "steps.a.needs" }),
    ]);
  });

  test("a pipeline output that is not a whole step expression is expression_invalid", () => {
    const source = "name: a\nsteps:\n  s:\n    uses: ./x.sh\noutputs:\n  out: 5\n";
    const issues = validatePipelineSource(source, resolver({ "./x.sh": noOutputBlock }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "expression_invalid", path: "outputs.out" }));
  });

  test("a step whose block cannot be resolved is block_not_found", () => {
    const source = "name: a\nsteps:\n  s:\n    uses: ./missing.sh\n";
    const issues = validatePipelineSource(source, resolver({}));
    expect(issues).toEqual([
      expect.objectContaining({ code: "block_not_found", path: "steps.s.uses" }),
    ]);
  });

  test("a block with a broken header reports at the referencing key", () => {
    const source = "name: a\nsteps:\n  s:\n    uses: ./bad.sh\n";
    const issues = validatePipelineSource(source, resolver({ "./bad.sh": "#!/usr/bin/env bash\n# ---\n# name: 1bad\n# ---\n" }));
    expect(issues).toEqual([
      expect.objectContaining({ code: "block_schema_invalid", path: "steps.s.uses" }),
    ]);
  });

  test("integer to number and scalar to string whole bindings are allowed", () => {
    const source = [
      "name: a",
      "steps:",
      "  a:",
      "    uses: ./a.sh",
      "    with:",
      "      x: ${{ steps.b.outputs.total }}",
      "  b:",
      "    uses: ./b.sh",
      "",
    ].join("\n");
    const issues = validatePipelineSource(source, resolver({ "./a.sh": strInBlock, "./b.sh": intOutBlock }));
    expect(issues).toEqual([]);
  });
});

// Section 3.4: `pass_env` copies out of the engine's environment, which is the server's own. Nothing
// the server keeps there may reach a step, or a pipeline could read the token it was run with.
const passEnvRun = (names: string[]) =>
  validatePipelineSource(
    [
      "name: a",
      "steps:",
      "  s:",
      "    uses: ./x.sh",
      `    pass_env: [${names.map((name) => `"${name}"`).join(", ")}]`,
      "",
    ].join("\n"),
    resolver({ "./x.sh": noOutputBlock }),
  );

describe("pass_env names", () => {
  test("a server secret is pipeline_schema_invalid at its own index", () => {
    expect(passEnvRun(["BASHREACTOR_ADMIN_TOKEN"])).toEqual([
      expect.objectContaining({
        code: "pipeline_schema_invalid",
        path: "steps.s.pass_env.0",
        message: "pass_env entry is not a passable environment variable name",
      }),
    ]);
  });

  test("every name the server reads off its own environment is refused", () => {
    const names = [
      "BASHREACTOR_ADMIN_TOKEN",
      "BASHREACTOR_ADMIN_TOKEN_SHA256",
      "BASHREACTOR_TOKEN",
      "BASHREACTOR_URL",
      "BASHREACTOR_HOME",
      "BASHREACTOR_VERSION",
      "BASHREACTOR_MCP_PORT",
      "BASHREACTOR_MCP_PATH",
      "PORT",
    ];
    expect(passEnvRun(names).map((issue) => issue.path)).toEqual(names.map((_, i) => `steps.s.pass_env.${i}`));
  });

  test("the BASHREACTOR_ prefix is refused in any case", () => {
    expect(passEnvRun(["bashreactor_admin_token", "Bashreactor_Token", "BASHREACTOR_WHATEVER"])).toHaveLength(3);
  });

  test("an ordinary name is still passable", () => {
    // `path` on purpose: only the prefixes are matched case-insensitively, and a lowercase name
    // cannot shadow the engine's own `PATH` in a block's environment.
    expect(passEnvRun(["SSL_CERT_FILE", "AWS_SECRET_ACCESS_KEY", "path"])).toEqual([]);
  });

  test("the names reserved before are reserved still", () => {
    const names = [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "TZ",
      "PYTHONUNBUFFERED",
      "NO_COLOR",
      "BR_RUN_ID",
      "INPUT_X",
      "OUTPUT_X",
    ];
    expect(passEnvRun(names)).toHaveLength(names.length);
  });
});
