// `--input name=value`, read the way SPEC section 3.3 says a command line reads it: with the text
// form of section 1.2, against the type the pipeline declares. The types come from the pipeline the
// user named, so `lines=300` arrives as the integer 300 and not as a string the engine must guess.

import { IO_NAME_RE, parseTextForm } from "@bashreactor/core";
import type { Value, ValueType } from "@bashreactor/core";
import { CliError, usage } from "./errors.ts";
import { isReadableFile } from "./connection.ts";
import { isAbsolute, resolve } from "node:path";

export function declaredTypes(
  inputs: readonly { name: string; type: string }[] | undefined,
): Map<string, ValueType> {
  const types = new Map<string, ValueType>();
  for (const input of inputs ?? []) types.set(input.name, input.type as ValueType);
  return types;
}

/**
 * An input the CLI cannot type is passed through as text and left for the engine to refuse: the
 * engine is the one that knows the pipeline's inputs, and a second opinion from here would only be
 * a second place for the answer to be wrong.
 */
export function readInputs(
  pairs: readonly string[],
  types: ReadonlyMap<string, ValueType>,
  cwd: string,
): Record<string, Value> {
  const inputs: Record<string, Value> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf("=");
    if (equals <= 0) throw usage(`--input wants name=value, got "${pair}"`, { path: "inputs" });
    const name = pair.slice(0, equals);
    const text = pair.slice(equals + 1);
    if (!IO_NAME_RE.test(name)) {
      throw usage(`"${name}" is not an input name (lowercase letters, digits and underscores)`, {
        path: `inputs.${name}`,
      });
    }

    const type = types.get(name);
    if (type === undefined) {
      inputs[name] = text;
      continue;
    }
    if (type === "file") {
      const path = isAbsolute(text) ? text : resolve(cwd, text);
      if (!isReadableFile(path)) {
        throw new CliError("file_input_not_found", `"${text}" is not a file`, {
          path: `inputs.${name}`,
          file: path,
          exit: 2,
        });
      }
      inputs[name] = path;
      continue;
    }

    const parsed = parseTextForm(type, text);
    if (!parsed.ok) {
      throw usage(`inputs.${name}: ${parsed.message}`, { code: "type_mismatch", path: `inputs.${name}` });
    }
    inputs[name] = parsed.value;
  }
  return inputs;
}
