// The YAML subset the mockup's documents use: nested maps, lists, flow lists, quoted and plain
// scalars, comments and block text. It exists so the mockup has no dependency, and it keeps the
// line range of every key, which is what lets a click on the graph find its YAML. The product
// should use a real YAML library that reports positions; anything outside the subset fails loudly
// here rather than being misread.

window.BR = window.BR || {};

BR.yaml = (() => {
  class YamlError extends Error {
    constructor(line, message) {
      super(message);
      this.code = "yaml_parse";
      this.line = line;
    }
  }

  // A # opens a comment only at the start or after a space, and never inside quotes.
  function stripComment(raw) {
    let quote = null;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === "#" && (i === 0 || /\s/.test(raw[i - 1]))) {
        return raw.slice(0, i);
      }
    }
    return raw;
  }

  function splitLines(text) {
    return text.split("\n").map((raw, index) => {
      const body = stripComment(raw).replace(/\s+$/, "");
      const lead = body.match(/^[ \t]*/)[0];
      return { raw, n: index + 1, body: body.slice(lead.length), indent: lead.length, tabbed: lead.includes("\t") };
    });
  }

  function scalar(src, line) {
    if (src === "" || src === "~" || src === "null") return null;
    if (src === "true") return true;
    if (src === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(src)) return Number(src);
    const first = src[0];
    if (first === '"' || first === "'") {
      if (src.length < 2 || src[src.length - 1] !== first) throw new YamlError(line, `Closing ${first} is missing.`);
      return src.slice(1, -1).replace(first === '"' ? /\\"/g : /''/g, first);
    }
    if (first === "[") {
      if (src[src.length - 1] !== "]") throw new YamlError(line, "Closing ] is missing.");
      const inner = src.slice(1, -1).trim();
      return inner === "" ? [] : inner.split(",").map((part) => scalar(part.trim(), line));
    }
    if (first === "{" && src !== "{}") throw new YamlError(line, "Flow maps are outside what this mockup parses. Use one key per line.");
    if (src === "{}") return {};
    if (first === "&" || first === "*" || first === "!") throw new YamlError(line, "Anchors, aliases and tags are outside what this mockup parses.");
    return src;
  }

  const KEY = /^("[^"]+"|'[^']+'|[^\s#:'"\-[\]{}][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*))?$/;

  function parse(text) {
    const lines = splitLines(text);
    const locs = {};
    let at = 0;
    let lastContent = 0;

    const skipBlank = () => {
      while (at < lines.length && lines[at].body === "") at++;
    };

    function parseValue(indent, path) {
      skipBlank();
      const line = lines[at];
      if (line.tabbed) throw new YamlError(line.n, "Indent with spaces, not tabs.");
      return /^-(\s|$)/.test(line.body) ? parseList(indent, path) : parseMap(indent, path);
    }

    function parseList(indent, path) {
      const out = [];
      for (;;) {
        skipBlank();
        if (at >= lines.length) break;
        const line = lines[at];
        if (line.indent < indent) break;
        if (line.indent > indent) throw new YamlError(line.n, "This line is indented further than the list it is in.");
        if (!/^-(\s|$)/.test(line.body)) break;
        at++;
        lastContent = line.n;
        const rest = line.body.slice(1).trim();
        if (KEY.test(rest)) throw new YamlError(line.n, "Lists of maps are outside what this mockup parses.");
        out.push(scalar(rest, line.n));
      }
      return out;
    }

    function blockText(indent) {
      const out = [];
      while (at < lines.length) {
        const line = lines[at];
        if (line.raw.trim() !== "" && line.raw.match(/^ */)[0].length <= indent) break;
        out.push(line.raw.trim());
        if (line.raw.trim() !== "") lastContent = line.n;
        at++;
      }
      return out.join("\n").trimEnd();
    }

    function parseMap(indent, path) {
      const out = {};
      for (;;) {
        skipBlank();
        if (at >= lines.length) break;
        const line = lines[at];
        if (line.tabbed) throw new YamlError(line.n, "Indent with spaces, not tabs.");
        if (line.indent < indent) break;
        if (line.indent > indent) throw new YamlError(line.n, "This line is indented further than the key above it allows.");
        const match = line.body.match(KEY);
        if (!match) throw new YamlError(line.n, /^-(\s|$)/.test(line.body) ? "A list item here needs a key above it." : `Expected "key: value" but found "${line.body}".`);
        const key = scalar(match[1], line.n);
        const keyPath = path ? `${path}.${key}` : String(key);
        if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(line.n, `"${key}" is defined twice.`);
        const rest = (match[2] || "").trim();
        at++;
        lastContent = line.n;
        if (rest === "|" || rest === ">") {
          out[key] = blockText(indent);
        } else if (rest !== "") {
          out[key] = scalar(rest, line.n);
        } else {
          skipBlank();
          const next = lines[at];
          const nested = next && (next.indent > indent || (next.indent === indent && /^-(\s|$)/.test(next.body)));
          out[key] = nested ? parseValue(next.indent, keyPath) : null;
        }
        locs[keyPath] = { start: line.n, end: lastContent };
      }
      return out;
    }

    try {
      skipBlank();
      if (at >= lines.length) return { ok: true, value: {}, locs };
      const value = parseValue(lines[at].indent, "");
      skipBlank();
      if (at < lines.length) throw new YamlError(lines[at].n, "This line is outside the document's structure. Check its indent.");
      return { ok: true, value, locs };
    } catch (error) {
      if (error instanceof YamlError) return { ok: false, error: { code: error.code, line: error.line, message: error.message } };
      throw error;
    }
  }

  // Quotes only what would otherwise read back as something else.
  function formatScalar(value) {
    if (value === null || value === undefined) return "";
    if (typeof value !== "string") return String(value);
    const plainStart = !/^[\s#&*!|>'"%@`[\]{},-]/.test(value);
    const looksTyped = /^(~|null|true|false|-?\d+(\.\d+)?)$/.test(value);
    if (value !== "" && plainStart && !looksTyped && !/:\s|\s#|\s$/.test(value)) return value;
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  return { parse, formatScalar };
})();
