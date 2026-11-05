// All the mockup's fake data. Nothing else in mockup/ holds a pipeline, a block, a run or a log line.
//
// The pipeline is stored as YAML text because in the product the YAML is the document: the graph
// is derived from it, never stored next to it. A block's inputs and outputs are not listed here
// either, they are read from the front matter of its source.
//
// The shape of everything below now follows docs/SPEC.md:
//   - `pipeline` is the exact bytes of a pipeline.yaml snapshot (section 3).
//   - `blocks` are the block files (section 2); a version's identity is the SHA-256 of its bytes,
//     so each version carries the real hash. `published` and `note` are store metadata, which the
//     store task (BASHR-4) owns; the block file itself is the source of truth.
//   - `runs` are run.json documents (section 4.9): string ids, ISO times, steps in declaration
//     order with the spec's statuses, attempts with exit_code, signal and failure.code, file
//     values stored as paths relative to the run directory.
//   - `logs` and `failures` are the attempt log files the run view streams. The product keeps one
//     log per attempt under steps/<id>/attempts/<n>/log; the mockup has no engine to write them,
//     so it replays these. They are keyed by block only so the simulator can reuse them.
//
// The numbers are much bigger than docs/examples/word-report.yaml so a run lasts hours, and two
// block files print progress so a log has something to stream.

window.BR = window.BR || {};

window.BashreactorData = (() => {
  // A block version's identity is the SHA-256 of the file's exact bytes (SPEC 2). This is the one
  // synchronous hash the mockup needs; the real store computes it the same way.
  function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const K = new Uint32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]);
    const len = bytes.length;
    const total = Math.ceil((len + 9) / 64) * 64;
    const padded = new Uint8Array(total);
    padded.set(bytes);
    padded[len] = 0x80;
    const bitLen = len * 8;
    const dv = new DataView(padded.buffer);
    dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
    dv.setUint32(total - 4, bitLen >>> 0);

    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    for (let i = 0; i < total; i += 64) {
      for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
      for (let t = 16; t < 64; t++) {
        const x = w[t - 15];
        const y = w[t - 2];
        const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let t = 0; t < 64; t++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K[t] + w[t]) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    return Array.from(h).map((x) => x.toString(16).padStart(8, "0")).join("");
  }
  window.BR.sha256Hex = sha256Hex;

  const pipeline = `name: word-report
description: Generate a corpus, gate it, count its words and render a report.

max_parallel: 2

inputs:
  lines:
    type: integer
    description: How many lines of corpus to generate.
    default: 20000000
  seed:
    type: integer
    description: The same seed and line count always produce the same report.
    default: 7
  title:
    type: string
    description: The heading of the report.
    default: Word report

steps:
  generate:
    name: Generate the corpus
    uses: ./generate-corpus.sh
    with:
      lines: \${{ inputs.lines }}
      seed: \${{ inputs.seed }}
      # Attempt 1 stops here and exits 75, attempt 2 carries on from the work directory.
      interrupt_at: 12000000
    timeout: 6h
    retry:
      max_attempts: 3
      delay: 1s

  check:
    name: Check the corpus is long enough
    uses: ./check-corpus.sh
    with:
      corpus: \${{ steps.generate.outputs.corpus }}
      min_lines: 100
    timeout: 1m
    retry:
      # A corpus that is too short exits 78, which never spends this budget.
      max_attempts: 2
      delay: 1s

  count:
    name: Count the words
    uses: ./count-words.sh
    with:
      corpus: \${{ steps.generate.outputs.corpus }}
      top: 5
    timeout: 8h

  report:
    name: Render the report
    uses: ./render-report.sh
    # The report reads nothing from check, it only must not run on a corpus that failed it.
    needs: [check]
    with:
      title: "\${{ inputs.title }}: \${{ steps.generate.outputs.line_count }} lines"
      total_words: \${{ steps.count.outputs.total_words }}
      top_words: \${{ steps.count.outputs.top_words }}
      counts: \${{ steps.count.outputs.counts }}
    timeout: 10m

outputs:
  report: \${{ steps.report.outputs.report }}
  total_words: \${{ steps.count.outputs.total_words }}
`;

  const generateV1 = `#!/usr/bin/env bash
# ---
# name: generate-corpus
# description: Write a reproducible text corpus, one line of words per line of output.
# inputs:
#   lines:
#     type: integer
#     description: How many lines to write.
#     default: 200
#   seed:
#     type: integer
#     description: The same seed and line count always produce the same bytes.
#     default: 7
# outputs:
#   corpus:
#     type: file
#     description: The corpus text.
# ---

words=(amber birch cedar delta ember fjord grove heron inlet juniper kestrel larch)
RANDOM=$INPUT_SEED

for (( n = 1; n <= INPUT_LINES; n++ )); do
  printf '%s %s %s\\n' "\${words[RANDOM % 12]}" "\${words[RANDOM % 12]}" "\${words[RANDOM % 12]}" >> "$OUTPUT_CORPUS"
done
`;

  const generateV2 = `#!/usr/bin/env bash
# ---
# name: generate-corpus
# description: Write a reproducible text corpus, one line of words per line of output.
# inputs:
#   lines:
#     type: integer
#     description: How many lines to write.
#     default: 200
#   seed:
#     type: integer
#     description: The same seed and line count always produce the same bytes.
#     default: 7
#   interrupt_at:
#     type: integer
#     description: On attempt 1, stop after this many lines and ask to be retried. 0 never stops.
#     default: 0
# outputs:
#   corpus:
#     type: file
#     description: The corpus text.
#   line_count:
#     type: integer
#     description: How many lines the corpus has.
# ---

words=(amber birch cedar delta ember fjord grove heron inlet juniper kestrel larch)

# Each line depends only on the seed and its own number, so the result is byte-identical no matter
# how many attempts it took to write.
write_line() {
  local state=$(( (INPUT_SEED * 31 + $1) & 0x7fffffff ))
  local count=$(( 4 + state % 6 ))
  local line="" i
  for (( i = 0; i < count; i++ )); do
    state=$(( (state * 1103515245 + 12345) & 0x7fffffff ))
    line+="\${words[(state >> 16) % \${#words[@]}]} "
  done
  printf '%s\\n' "\${line% }" >> corpus.partial
}

touch corpus.partial
written=$(wc -l < corpus.partial)

for (( n = written + 1; n <= INPUT_LINES; n++ )); do
  if (( BR_ATTEMPT == 1 && INPUT_INTERRUPT_AT > 0 && n > INPUT_INTERRUPT_AT )); then
    exit 75
  fi
  write_line "$n"
done

wc -l < corpus.partial > "$OUTPUT_LINE_COUNT"
mv corpus.partial "$OUTPUT_CORPUS"
`;

  const generateV3 = `#!/usr/bin/env bash
# ---
# name: generate-corpus
# description: Write a reproducible text corpus, one line of words per line of output.
# inputs:
#   lines:
#     type: integer
#     description: How many lines to write.
#     default: 200
#   seed:
#     type: integer
#     description: The same seed and line count always produce the same bytes.
#     default: 7
#   interrupt_at:
#     type: integer
#     description: On attempt 1, stop after this many lines and ask to be retried. 0 never stops.
#     default: 0
# outputs:
#   corpus:
#     type: file
#     description: The corpus text.
#   line_count:
#     type: integer
#     description: How many lines the corpus has.
# ---

words=(amber birch cedar delta ember fjord grove heron inlet juniper kestrel larch)

# Each line depends only on the seed and its own number, so the result is byte-identical no matter
# how many attempts it took to write.
write_line() {
  local state=$(( (INPUT_SEED * 31 + $1) & 0x7fffffff ))
  local count=$(( 4 + state % 6 ))
  local line="" i
  for (( i = 0; i < count; i++ )); do
    state=$(( (state * 1103515245 + 12345) & 0x7fffffff ))
    line+="\${words[(state >> 16) % \${#words[@]}]} "
  done
  printf '%s\\n' "\${line% }" >> corpus.partial
}

# The work directory survives retries and engine restarts, so a later attempt carries on from here
# instead of starting over.
touch corpus.partial
written=$(wc -l < corpus.partial)
echo "attempt $BR_ATTEMPT: $written of $INPUT_LINES lines already written"

for (( n = written + 1; n <= INPUT_LINES; n++ )); do
  if (( BR_ATTEMPT == 1 && INPUT_INTERRUPT_AT > 0 && n > INPUT_INTERRUPT_AT )); then
    echo "attempt $BR_ATTEMPT: stopping after $INPUT_INTERRUPT_AT lines, asking for a retry"
    exit 75
  fi
  write_line "$n"
  (( n % 2000000 == 0 )) && echo "$n of $INPUT_LINES lines, last: $(tail -n 8 corpus.partial | tr '\\n' ' ')"
done

wc -l < corpus.partial > "$OUTPUT_LINE_COUNT"
# The work directory and the outputs directory share a filesystem, so this move is cheap and the
# engine never sees a half-written artifact.
mv corpus.partial "$OUTPUT_CORPUS"
echo "attempt $BR_ATTEMPT: corpus finished"
`;

  const checkV1 = `#!/usr/bin/env bash
# ---
# name: check-corpus
# description: Refuse a corpus that is too short to be worth reporting on.
# inputs:
#   corpus:
#     type: file
#     description: The corpus text.
#   min_lines:
#     type: integer
#     description: The fewest lines an acceptable corpus has.
#     default: 1
# ---

lines=$(wc -l < "$INPUT_CORPUS")

if (( lines < INPUT_MIN_LINES )); then
  echo "check-corpus: $lines lines, need at least $INPUT_MIN_LINES" >&2
  # Another attempt would read the same file, so 78 tells the engine not to spend its retries.
  exit 78
fi

echo "check-corpus: $lines lines, need at least $INPUT_MIN_LINES, ok"
`;

  const countV1 = `#!/usr/bin/env bash
# ---
# name: count-words
# description: Count the words in a corpus with Python, run through uv.
# inputs:
#   corpus:
#     type: file
#     description: The corpus text.
# outputs:
#   total_words:
#     type: integer
#     description: Every word in the corpus, counting repeats.
# ---

uv run --quiet --no-project --script - <<'PY'
import collections
import os

with open(os.environ["INPUT_CORPUS"], encoding="utf-8") as corpus:
    counts = collections.Counter(corpus.read().split())

with open(os.environ["OUTPUT_TOTAL_WORDS"], "w", encoding="utf-8") as output:
    output.write(str(counts.total()))
PY
`;

  const countV2 = `#!/usr/bin/env bash
# ---
# name: count-words
# description: Count the words in a corpus with Python, run through uv.
# inputs:
#   corpus:
#     type: file
#     description: The corpus text.
#   top:
#     type: integer
#     description: How many of the most frequent words to return.
#     default: 5
# outputs:
#   total_words:
#     type: integer
#     description: Every word in the corpus, counting repeats.
#   top_words:
#     type: json
#     description: The most frequent words, as a list of objects with word and count.
#   counts:
#     type: file
#     description: One word,count row per distinct word, most frequent first.
# ---

uv run --quiet --no-project --script - <<'PY'
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
import collections
import csv
import json
import os

counts = collections.Counter()
with open(os.environ["INPUT_CORPUS"], encoding="utf-8") as corpus:
    for number, line in enumerate(corpus, 1):
        counts.update(line.split())
        if number % 4_000_000 == 0:
            print(f"count-words: read {number} lines, {len(counts)} distinct so far", flush=True)

# Ties break alphabetically so the same corpus always gives the same output.
ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
top = [{"word": word, "count": count} for word, count in ranked[: int(os.environ["INPUT_TOP"])]]
print(f"count-words: top words {json.dumps(top)}")

with open(os.environ["OUTPUT_TOTAL_WORDS"], "w", encoding="utf-8") as output:
    output.write(str(counts.total()))

with open(os.environ["OUTPUT_TOP_WORDS"], "w", encoding="utf-8") as output:
    json.dump(top, output)

with open(os.environ["OUTPUT_COUNTS"], "w", encoding="utf-8", newline="") as output:
    writer = csv.writer(output, lineterminator="\\n")
    writer.writerow(["word", "count"])
    writer.writerows(ranked)

print(f"count-words: {counts.total()} words, {len(counts)} distinct")
PY
`;

  const renderV1 = `#!/usr/bin/env bash
# ---
# name: render-report
# description: Render the word counts as a Markdown report with TypeScript, run through bun.
# inputs:
#   title:
#     type: string
#     description: The heading of the report.
#   total_words:
#     type: integer
#     description: Every word in the corpus, counting repeats.
#   top_words:
#     type: json
#     description: The most frequent words, as a list of objects with word and count.
#   counts:
#     type: file
#     description: One word,count row per distinct word, with a header row.
# outputs:
#   report:
#     type: file
#     description: The report as Markdown.
#   report_bytes:
#     type: integer
#     description: The size of the report in bytes.
# ---

bun run - <<'TS'
type WordCount = { word: string; count: number };

const title = process.env.INPUT_TITLE!;
const totalWords = Number(process.env.INPUT_TOTAL_WORDS!);
const topWords: WordCount[] = JSON.parse(process.env.INPUT_TOP_WORDS!);
const rows = (await Bun.file(process.env.INPUT_COUNTS!).text()).trimEnd().split("\\n");
const distinctWords = rows.length - 1;

const report = [
  \`# \${title}\`,
  "",
  \`\${totalWords} words, \${distinctWords} distinct.\`,
  "",
  "| Word | Count |",
  "| --- | --- |",
  ...topWords.map(({ word, count }) => \`| \${word} | \${count} |\`),
  "",
].join("\\n");

const bytes = await Bun.write(process.env.OUTPUT_REPORT!, report);
await Bun.write(process.env.OUTPUT_REPORT_BYTES!, String(bytes));
console.log(\`render-report: \${bytes} bytes\`);
TS
`;

  const blocks = [
    {
      name: "generate-corpus",
      versions: [
        { version: 1, published: "2026-08-02", note: "First version.", sha256: sha256Hex(generateV1), source: generateV1 },
        { version: 2, published: "2026-09-14", note: "Same bytes whatever the attempt count, and carry on after a retry.", sha256: sha256Hex(generateV2), source: generateV2 },
        { version: 3, published: "2026-10-21", note: "Print progress every two million lines.", sha256: sha256Hex(generateV3), source: generateV3 },
      ],
    },
    {
      name: "check-corpus",
      versions: [{ version: 1, published: "2026-09-14", note: "First version.", sha256: sha256Hex(checkV1), source: checkV1 }],
    },
    {
      name: "count-words",
      versions: [
        { version: 1, published: "2026-09-30", note: "First version.", sha256: sha256Hex(countV1), source: countV1 },
        { version: 2, published: "2026-10-28", note: "Return the top words and a file of all counts.", sha256: sha256Hex(countV2), source: countV2 },
      ],
    },
    {
      name: "render-report",
      versions: [{ version: 1, published: "2026-10-28", note: "First version.", sha256: sha256Hex(renderV1), source: renderV1 }],
    },
  ];

  const WORDS = "amber birch cedar delta ember fjord grove heron inlet juniper kestrel larch";
  const last = `${WORDS} ${WORDS} ${WORDS} ${WORDS} ${WORDS}`;

  // What one run of a block prints, as [seconds into the step, stream, text]. A fourth element marks
  // the line where a new attempt begins. {name} is filled from the step's bound `with` and run id.
  const logs = {
    "generate-corpus": [
      [0, "sys", "attempt 1 of {max_attempts} started in /var/lib/bashreactor/runs/{run}/generate", 1],
      [1, "out", "attempt 1: 0 of {lines} lines already written"],
      [1402, "out", `2000000 of {lines} lines, last: ${last}`],
      [2811, "out", `4000000 of {lines} lines, last: ${last}`],
      [4207, "out", `6000000 of {lines} lines, last: ${last}`],
      [5620, "out", `8000000 of {lines} lines, last: ${last}`],
      [7034, "out", `10000000 of {lines} lines, last: ${last}`],
      [8440, "out", `12000000 of {lines} lines, last: ${last}`],
      [8441, "out", "attempt 1: stopping after {interrupt_at} lines, asking for a retry"],
      [8441, "sys", "exit 75: the block asked for a retry, waiting 1s"],
      [8442, "sys", "attempt 2 of {max_attempts} started, work directory kept", 2],
      [8443, "out", "attempt 2: 12000000 of {lines} lines already written"],
      [9851, "out", `14000000 of {lines} lines, last: ${last}`],
      [11260, "out", `16000000 of {lines} lines, last: ${last}`],
      [12672, "out", `18000000 of {lines} lines, last: ${last}`],
      [14083, "out", `20000000 of {lines} lines, last: ${last}`],
      [14090, "out", "attempt 2: corpus finished"],
      [14090, "sys", "exit 0: outputs corpus, line_count recorded"],
    ],
    "check-corpus": [
      [0, "sys", "attempt 1 of {max_attempts} started in /var/lib/bashreactor/runs/{run}/check", 1],
      [41, "out", "check-corpus: {lines} lines, need at least {min_lines}, ok"],
      [41, "sys", "exit 0"],
    ],
    "count-words": [
      [0, "sys", "attempt 1 of {max_attempts} started in /var/lib/bashreactor/runs/{run}/count", 1],
      [2, "out", "uv: no project, running a script from stdin with python 3.13.1"],
      [1810, "out", "count-words: read 4000000 lines, 12 distinct so far"],
      [3644, "out", "count-words: read 8000000 lines, 12 distinct so far"],
      [5463, "out", "count-words: read 12000000 lines, 12 distinct so far"],
      [7290, "err", "count-words: resident memory at 71 percent of the limit, the counter stays small but the corpus reader buffers a lot, consider a smaller read size if this block runs next to other work on the same machine"],
      [7291, "out", "count-words: read 16000000 lines, 12 distinct so far"],
      [9108, "out", "count-words: read 20000000 lines, 12 distinct so far"],
      [9140, "out", 'count-words: top words [{"word": "ember", "count": 11941204}, {"word": "juniper", "count": 11938877}, {"word": "cedar", "count": 11937012}, {"word": "kestrel", "count": 11936540}, {"word": "amber", "count": 11934118}]'],
      [9143, "out", "count-words: 143002118 words, 12 distinct"],
      [9143, "sys", "exit 0: outputs total_words, top_words, counts recorded"],
    ],
    "render-report": [
      [0, "sys", "attempt 1 of {max_attempts} started in /var/lib/bashreactor/runs/{run}/report", 1],
      [1, "out", "bun: running a script from stdin"],
      [3, "out", "render-report: 412 bytes"],
      [3, "sys", "exit 0: outputs report, report_bytes recorded"],
    ],
  };

  // The log a failed run's attempt leaves. Only the block a fixture run fails needs one.
  const failures = {
    "generate-corpus": [
      [0, "sys", "attempt 1 of {max_attempts} started in /var/lib/bashreactor/runs/{run}/generate", 1],
      [1, "out", "attempt 1: 0 of {lines} lines already written"],
      [904, "err", "/var/lib/bashreactor/runs/{run}/generate/run.sh: line 33: corpus.partial: No space left on device"],
      [904, "sys", "exit 1: waiting 1s before attempt 2"],
      [905, "sys", "attempt 2 of {max_attempts} started, work directory kept", 2],
      [906, "out", "attempt 2: 1290811 of {lines} lines already written"],
      [907, "err", "/var/lib/bashreactor/runs/{run}/generate/run.sh: line 33: corpus.partial: No space left on device"],
      [907, "sys", "exit 1: waiting 1s before attempt 3"],
      [908, "sys", "attempt 3 of {max_attempts} started, work directory kept", 3],
      [909, "out", "attempt 3: 1290811 of {lines} lines already written"],
      [910, "err", "/var/lib/bashreactor/runs/{run}/generate/run.sh: line 33: corpus.partial: No space left on device"],
      [910, "sys", "exit 1: no attempts left, this step failed"],
    ],
  };

  // The run.json fixtures. Times are built relative to page load so the live run still looks alive;
  // every value follows SPEC 4.9.
  const NOW = Date.now();
  const iso = (agoSeconds) => new Date(NOW - agoSeconds * 1000).toISOString();
  const at = (startedAgo, offsetSeconds) => iso(startedAgo - offsetSeconds);

  const topWords = [
    { word: "ember", count: 11941204 },
    { word: "juniper", count: 11938877 },
    { word: "cedar", count: 11937012 },
    { word: "kestrel", count: 11936540 },
    { word: "amber", count: 11934118 },
  ];
  const corpusPath = (attempt) => `steps/generate/attempts/${attempt}/outputs/corpus`;
  const countsPath = "steps/count/attempts/1/outputs/counts";
  const reportPath = "steps/report/attempts/1/outputs/report";

  const run42 = (() => {
    const started = 16130;
    const t = (s) => at(started, s);
    return {
      schema: 1,
      id: "20261104T093000Z-3fa9c2d1",
      pipeline: "word-report",
      status: "running",
      created_at: iso(started),
      finished_at: null,
      cancel_requested_at: null,
      inputs: { lines: 20000000, seed: 7, title: "Word report" },
      outputs: null,
      steps: {
        generate: {
          name: "Generate the corpus",
          status: "succeeded",
          block: { uses: "./generate-corpus.sh", name: "generate-corpus", sha256: sha256Hex(generateV3) },
          needs: [],
          with: { lines: 20000000, seed: 7, interrupt_at: 12000000 },
          outputs: { corpus: corpusPath(2), line_count: 20000000 },
          failure: null,
          attempts_used: 2,
          next_attempt_at: null,
          attempts: [
            { n: 1, status: "failed", pid: 48211, pid_start: 91827364, started_at: t(0), finished_at: t(8441), exit_code: 75, signal: null, failure: { code: "retry_requested", message: "exit 75" } },
            { n: 2, status: "succeeded", pid: 48230, pid_start: 91827466, started_at: t(8442), finished_at: t(14090), exit_code: 0, signal: null, failure: null },
          ],
        },
        check: {
          name: "Check the corpus is long enough",
          status: "succeeded",
          block: { uses: "./check-corpus.sh", name: "check-corpus", sha256: sha256Hex(checkV1) },
          needs: ["generate"],
          with: { corpus: corpusPath(2), min_lines: 100 },
          outputs: {},
          failure: null,
          attempts_used: 1,
          next_attempt_at: null,
          attempts: [
            { n: 1, status: "succeeded", pid: 48240, pid_start: 91827511, started_at: t(14090), finished_at: t(14131), exit_code: 0, signal: null, failure: null },
          ],
        },
        count: {
          name: "Count the words",
          status: "running",
          block: { uses: "./count-words.sh", name: "count-words", sha256: sha256Hex(countV2) },
          needs: ["generate"],
          with: { corpus: corpusPath(2), top: 5 },
          outputs: null,
          failure: null,
          attempts_used: 1,
          next_attempt_at: null,
          attempts: [
            { n: 1, status: "running", pid: 48299, pid_start: 91827601, started_at: t(14091), finished_at: null, exit_code: null, signal: null, failure: null },
          ],
        },
        report: {
          name: "Render the report",
          status: "pending",
          block: { uses: "./render-report.sh", name: "render-report", sha256: sha256Hex(renderV1) },
          needs: ["generate", "check", "count"],
          with: null,
          outputs: null,
          failure: null,
          attempts_used: 0,
          next_attempt_at: null,
          attempts: [],
        },
      },
    };
  })();

  const run41 = (() => {
    const started = 94210;
    const t = (s) => at(started, s);
    const exit1 = { code: "exit_nonzero", message: "exit 1" };
    const attempt = (n, from, to) => ({
      n,
      status: "failed",
      pid: 47100 + n,
      pid_start: 91700000 + n,
      started_at: t(from),
      finished_at: t(to),
      exit_code: 1,
      signal: null,
      failure: exit1,
    });
    return {
      schema: 1,
      id: "20261104T061500Z-7b2a90c4",
      pipeline: "word-report",
      status: "failed",
      created_at: iso(started),
      finished_at: t(910),
      cancel_requested_at: null,
      inputs: { lines: 20000000, seed: 7, title: "Word report" },
      outputs: null,
      steps: {
        generate: {
          name: "Generate the corpus",
          status: "failed",
          block: { uses: "./generate-corpus.sh", name: "generate-corpus", sha256: sha256Hex(generateV3) },
          needs: [],
          with: { lines: 20000000, seed: 7, interrupt_at: 12000000 },
          outputs: null,
          failure: { code: "exit_nonzero", message: "No space left on device (exit 1)" },
          attempts_used: 3,
          next_attempt_at: null,
          attempts: [attempt(1, 0, 904), attempt(2, 905, 907), attempt(3, 908, 910)],
        },
        check: {
          name: "Check the corpus is long enough",
          status: "skipped",
          block: { uses: "./check-corpus.sh", name: "check-corpus", sha256: sha256Hex(checkV1) },
          needs: ["generate"],
          with: null,
          outputs: null,
          failure: null,
          attempts_used: 0,
          next_attempt_at: null,
          attempts: [],
        },
        count: {
          name: "Count the words",
          status: "skipped",
          block: { uses: "./count-words.sh", name: "count-words", sha256: sha256Hex(countV2) },
          needs: ["generate"],
          with: null,
          outputs: null,
          failure: null,
          attempts_used: 0,
          next_attempt_at: null,
          attempts: [],
        },
        report: {
          name: "Render the report",
          status: "skipped",
          block: { uses: "./render-report.sh", name: "render-report", sha256: sha256Hex(renderV1) },
          needs: ["generate", "check", "count"],
          with: null,
          outputs: null,
          failure: null,
          attempts_used: 0,
          next_attempt_at: null,
          attempts: [],
        },
      },
    };
  })();

  const run40 = (() => {
    const started = 179800;
    const t = (s) => at(started, s);
    return {
      schema: 1,
      id: "20261103T083000Z-9e1d5f02",
      pipeline: "word-report",
      status: "succeeded",
      created_at: iso(started),
      finished_at: t(23237),
      cancel_requested_at: null,
      inputs: { lines: 20000000, seed: 7, title: "Word report" },
      outputs: { report: reportPath, total_words: 143002118 },
      steps: {
        generate: {
          name: "Generate the corpus",
          status: "succeeded",
          block: { uses: "./generate-corpus.sh", name: "generate-corpus", sha256: sha256Hex(generateV3) },
          needs: [],
          with: { lines: 20000000, seed: 7, interrupt_at: 12000000 },
          outputs: { corpus: corpusPath(2), line_count: 20000000 },
          failure: null,
          attempts_used: 2,
          next_attempt_at: null,
          attempts: [
            { n: 1, status: "failed", pid: 43111, pid_start: 91217364, started_at: t(0), finished_at: t(8441), exit_code: 75, signal: null, failure: { code: "retry_requested", message: "exit 75" } },
            { n: 2, status: "succeeded", pid: 43130, pid_start: 91217466, started_at: t(8442), finished_at: t(14090), exit_code: 0, signal: null, failure: null },
          ],
        },
        check: {
          name: "Check the corpus is long enough",
          status: "succeeded",
          block: { uses: "./check-corpus.sh", name: "check-corpus", sha256: sha256Hex(checkV1) },
          needs: ["generate"],
          with: { corpus: corpusPath(2), min_lines: 100 },
          outputs: {},
          failure: null,
          attempts_used: 1,
          next_attempt_at: null,
          attempts: [
            { n: 1, status: "succeeded", pid: 43140, pid_start: 91217511, started_at: t(14090), finished_at: t(14131), exit_code: 0, signal: null, failure: null },
          ],
        },
        count: {
          name: "Count the words",
          status: "succeeded",
          block: { uses: "./count-words.sh", name: "count-words", sha256: sha256Hex(countV2) },
          needs: ["generate"],
          with: { corpus: corpusPath(2), top: 5 },
          outputs: { total_words: 143002118, top_words: topWords, counts: countsPath },
          failure: null,
          attempts_used: 1,
          next_attempt_at: null,
          attempts: [
            { n: 1, status: "succeeded", pid: 43199, pid_start: 91217601, started_at: t(14091), finished_at: t(23234), exit_code: 0, signal: null, failure: null },
          ],
        },
        report: {
          name: "Render the report",
          status: "succeeded",
          block: { uses: "./render-report.sh", name: "render-report", sha256: sha256Hex(renderV1) },
          needs: ["generate", "check", "count"],
          with: {
            title: "Word report: 20000000 lines",
            total_words: 143002118,
            top_words: topWords,
            counts: countsPath,
          },
          outputs: { report: reportPath, report_bytes: 412 },
          failure: null,
          attempts_used: 1,
          next_attempt_at: null,
          attempts: [
            { n: 1, status: "succeeded", pid: 43220, pid_start: 91217701, started_at: t(23234), finished_at: t(23237), exit_code: 0, signal: null, failure: null },
          ],
        },
      },
    };
  })();

  const runs = [run42, run41, run40];

  return { pipeline, blocks, logs, failures, runs };
})();
