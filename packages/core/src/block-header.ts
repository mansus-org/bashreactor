// docs/SPEC.md section 2.2: the comment header of a block file. Parsing never executes the file.

export type SplitHeaderResult = { ok: true; header: string } | { ok: false; error: string };

export function splitBlockHeader(source: string): SplitHeaderResult {
  const lines = source.split("\n");
  if (lines[0] !== "#!/usr/bin/env bash") {
    return { ok: false, error: "line 1 must be exactly '#!/usr/bin/env bash'" };
  }
  if (lines[1] !== "# ---") {
    return { ok: false, error: "line 2 must be exactly '# ---'" };
  }
  const header: string[] = [];
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "# ---") return { ok: true, header: header.join("\n") };
    if (line === "#") {
      header.push("");
      continue;
    }
    if (line.startsWith("# ")) {
      header.push(line.slice(2));
      continue;
    }
    return { ok: false, error: `line ${i + 1} is not a '#' or '# ...' header line` };
  }
  return { ok: false, error: "the header has no closing '# ---'" };
}

// The same rules over raw bytes, so a block whose body is not UTF-8 still parses (section 2.2: the
// header must be valid UTF-8, the rest of the file is opaque bytes).
export function splitBlockHeaderBytes(bytes: Uint8Array): SplitHeaderResult {
  const lines = splitLines(bytes);
  if (!bytesEq(lines[0], text("#!/usr/bin/env bash"))) {
    return { ok: false, error: "line 1 must be exactly '#!/usr/bin/env bash'" };
  }
  if (!bytesEq(lines[1], text("# ---"))) {
    return { ok: false, error: "line 2 must be exactly '# ---'" };
  }
  const header: string[] = [];
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i]!;
    if (bytesEq(line, text("# ---"))) return { ok: true, header: header.join("\n") };
    if (bytesEq(line, text("#"))) {
      header.push("");
      continue;
    }
    if (line.length >= 2 && line[0] === 0x23 && line[1] === 0x20) {
      const decoded = decodeUtf8(line.slice(2));
      if (!decoded.ok) return { ok: false, error: "the header must be valid UTF-8" };
      header.push(decoded.text);
      continue;
    }
    return { ok: false, error: `line ${i + 1} is not a '#' or '# ...' header line` };
  }
  return { ok: false, error: "the header has no closing '# ---'" };
}

function splitLines(bytes: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === 0x0a) {
      lines.push(bytes.slice(start, i));
      start = i + 1;
    }
  }
  return lines;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesEq(left: Uint8Array | undefined, right: Uint8Array): boolean {
  if (left === undefined || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function decodeUtf8(bytes: Uint8Array): { ok: true; text: string } | { ok: false } {
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false };
  }
}
