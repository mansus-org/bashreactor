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
