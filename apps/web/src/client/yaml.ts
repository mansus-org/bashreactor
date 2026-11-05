// The YAML subset the pipeline documents use: nested maps, lists, flow lists, quoted and plain
// scalars, comments and block text. Ported from mockup/yaml.js, and it exists for one reason: the
// graph needs the line range of every key, so a click on a node can find its lines in the text.
//
// The API is the authority on what a valid pipeline is (`POST /v1/pipelines/validate` reads it with
// the real parser in @bashreactor/core). This one is a reading aid for the editor: anything outside
// the subset fails loudly with a line number rather than being misread.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Loc {
  start: number;
  end: number;
}

export interface YamlError {
  code: string;
  line: number;
  message: string;
}

export type ParseResult = { ok: true; value: Json; locs: Record<string, Loc> } | { ok: false; error: YamlError };

class YamlErrorSignal extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(message);
    this.line = line;
  }
}

interface Line {
  raw: string;
  n: number;
  body: string;
  indent: number;
  tabbed: boolean;
}

// A # opens a comment only at the start or after a space, and never inside quotes.
function stripComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(raw[i - 1]!))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function splitLines(text: string): Line[] {
  return text.split("\n").map((raw, index) => {
    const body = stripComment(raw).replace(/\s+$/, "");
    const lead = /^[ \t]*/.exec(body)![0]!;
    return { raw, n: index + 1, body: body.slice(lead.length), indent: lead.length, tabbed: lead.includes("\t") };
  });
}

function scalar(src: string, line: number): Json {
  if (src === "" || src === "~" || src === "null") return null;
  if (src === "true") return true;
  if (src === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(src)) return Number(src);
  const first = src[0]!;
  if (first === '"' || first === "'") {
    if (src.length < 2 || src[src.length - 1] !== first) throw new YamlErrorSignal(line, `Closing ${first} is missing.`);
    return src.slice(1, -1).replace(first === '"' ? /\\"/g : /''/g, first);
  }
  if (first === "[") {
    if (src[src.length - 1] !== "]") throw new YamlErrorSignal(line, "Closing ] is missing.");
    const inner = src.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((part) => scalar(part.trim(), line));
  }
  if (first === "{" && src !== "{}") {
    throw new YamlErrorSignal(line, "Flow maps are outside what this editor parses. Use one key per line.");
  }
  if (src === "{}") return {};
  if (first === "&" || first === "*" || first === "!") {
    throw new YamlErrorSignal(line, "Anchors, aliases and tags are outside what this editor parses.");
  }
  return src;
}

const KEY = /^("[^"]+"|'[^']+'|[^\s#:'"\-[\]{}][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*))?$/;

export function parse(text: string): ParseResult {
  const lines = splitLines(text);
  const locs: Record<string, Loc> = {};
  let at = 0;
  let lastContent = 0;

  const skipBlank = (): void => {
    while (at < lines.length && lines[at]!.body === "") at++;
  };

  function parseValue(indent: number, path: string): Json {
    skipBlank();
    const line = lines[at]!;
    if (line.tabbed) throw new YamlErrorSignal(line.n, "Indent with spaces, not tabs.");
    return /^-(\s|$)/.test(line.body) ? parseList(indent, path) : parseMap(indent, path);
  }

  function parseList(indent: number, path: string): Json[] {
    const out: Json[] = [];
    for (;;) {
      skipBlank();
      if (at >= lines.length) break;
      const line = lines[at]!;
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new YamlErrorSignal(line.n, "This line is indented further than the list it is in.");
      }
      if (!/^-(\s|$)/.test(line.body)) break;
      at++;
      lastContent = line.n;
      const rest = line.body.slice(1).trim();
      if (KEY.test(rest)) throw new YamlErrorSignal(line.n, "Lists of maps are outside what this editor parses.");
      out.push(scalar(rest, line.n));
    }
    void path;
    return out;
  }

  function blockText(indent: number): string {
    const out: string[] = [];
    while (at < lines.length) {
      const line = lines[at]!;
      if (line.raw.trim() !== "" && /^ */.exec(line.raw)![0]!.length <= indent) break;
      out.push(line.raw.trim());
      if (line.raw.trim() !== "") lastContent = line.n;
      at++;
    }
    return out.join("\n").trimEnd();
  }

  function parseMap(indent: number, path: string): Json {
    const out: { [key: string]: Json } = {};
    for (;;) {
      skipBlank();
      if (at >= lines.length) break;
      const line = lines[at]!;
      if (line.tabbed) throw new YamlErrorSignal(line.n, "Indent with spaces, not tabs.");
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new YamlErrorSignal(line.n, "This line is indented further than the key above it allows.");
      }
      const match = line.body.match(KEY);
      if (match === null) {
        throw new YamlErrorSignal(
          line.n,
          /^-(\s|$)/.test(line.body)
            ? "A list item here needs a key above it."
            : `Expected "key: value" but found "${line.body}".`,
        );
      }
      const key = String(scalar(match[1]!, line.n));
      const keyPath = path === "" ? key : `${path}.${key}`;
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        throw new YamlErrorSignal(line.n, `"${key}" is defined twice.`);
      }
      const rest = (match[2] ?? "").trim();
      at++;
      lastContent = line.n;
      if (rest === "|" || rest === ">") {
        out[key] = blockText(indent);
      } else if (rest !== "") {
        out[key] = scalar(rest, line.n);
      } else {
        skipBlank();
        const next = lines[at];
        const nested = next !== undefined && (next.indent > indent || (next.indent === indent && /^-(\s|$)/.test(next.body)));
        out[key] = nested ? parseValue(next.indent, keyPath) : null;
      }
      locs[keyPath] = { start: line.n, end: lastContent };
    }
    return out;
  }

  try {
    skipBlank();
    if (at >= lines.length) return { ok: true, value: {}, locs };
    const value = parseValue(lines[at]!.indent, "");
    skipBlank();
    if (at < lines.length) {
      throw new YamlErrorSignal(lines[at]!.n, "This line is outside the document's structure. Check its indent.");
    }
    return { ok: true, value, locs };
  } catch (error) {
    if (error instanceof YamlErrorSignal) {
      return { ok: false, error: { code: "pipeline_yaml_invalid", line: error.line, message: error.message } };
    }
    throw error;
  }
}

/** Quotes only what would otherwise read back as something else. */
export function formatScalar(value: Json): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") return String(value);
  const plainStart = !/^[\s#&*!|>'"%@`[\]{},-]/.test(value);
  const looksTyped = /^(~|null|true|false|-?\d+(\.\d+)?)$/.test(value);
  if (value !== "" && plainStart && !looksTyped && !/:\s|\s#|\s$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function isMap(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
