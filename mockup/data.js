// All the mockup's fake data. Nothing else in mockup/ holds a pipeline, a block or a log line.
//
// The pipeline is stored as YAML text because in the product the YAML is the document: the graph
// is derived from it, never stored next to it. A block's inputs and outputs are not listed here
// either, they are read from the front matter of its source.
//
// RECONCILE: this follows docs/examples/word-report.yaml and its block files as the spec task had
// them in progress, with bigger numbers (lines, timeouts) so a run lasts hours, and progress lines
// added to two block files so a log has something to stream. Run and version records have no
// schema yet; `runs`, `versions`, `logs` and `failures` below are the mockup's guess at them.

window.BashreactorData = (() => {
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
        { version: 1, published: "2026-08-02", note: "First version.", source: generateV1 },
        { version: 2, published: "2026-09-14", note: "Same bytes whatever the attempt count, and carry on after a retry.", source: generateV2 },
        { version: 3, published: "2026-10-21", note: "Print progress every two million lines.", source: generateV3 },
      ],
    },
    {
      name: "check-corpus",
      versions: [{ version: 1, published: "2026-09-14", note: "First version.", source: checkV1 }],
    },
    {
      name: "count-words",
      versions: [
        { version: 1, published: "2026-09-30", note: "First version.", source: countV1 },
        { version: 2, published: "2026-10-28", note: "Return the top words and a file of all counts.", source: countV2 },
      ],
    },
    {
      name: "render-report",
      versions: [{ version: 1, published: "2026-10-28", note: "First version.", source: renderV1 }],
    },
  ];

  const WORDS = "amber birch cedar delta ember fjord grove heron inlet juniper kestrel larch";
  const last = `${WORDS} ${WORDS} ${WORDS} ${WORDS} ${WORDS}`;

  // What one run of a block prints, as [seconds into the step, stream, text]. A fourth element marks
  // the line where a new attempt begins. {name} is filled from the step's inputs and context.
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

  // What the attempts that end badly print. Only the blocks a fixture run fails need one.
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

  // Output values per block, for the step panel of the run view. {name} works as in `logs`.
  const outputValues = {
    "generate-corpus": { corpus: "/var/lib/bashreactor/runs/{run}/outputs/generate/corpus", line_count: "{lines}" },
    "check-corpus": {},
    "count-words": {
      total_words: "143002118",
      top_words: '[{"word":"ember","count":11941204},{"word":"juniper","count":11938877},{"word":"cedar","count":11937012},{"word":"kestrel","count":11936540},{"word":"amber","count":11934118}]',
      counts: "/var/lib/bashreactor/runs/{run}/outputs/count/counts",
    },
    "render-report": { report: "/var/lib/bashreactor/runs/{run}/outputs/report/report", report_bytes: "412" },
  };

  // Steps not named in a run's `steps` are queued. `shown` is how many lines of the block's log had
  // already arrived when the page opened; the rest stream in from there.
  const runs = [
    {
      id: 42,
      startedAgo: 14400 + 1730,
      inputs: { lines: 20000000, seed: 7, title: "Word report" },
      steps: {
        generate: { state: "succeeded", attempt: 2, seconds: 14090 },
        check: { state: "succeeded", attempt: 1, seconds: 41 },
        count: { state: "running", attempt: 1, seconds: 1999, shown: 3 },
      },
    },
    {
      id: 41,
      startedAgo: 94210,
      finishedAgo: 93300,
      inputs: { lines: 20000000, seed: 7, title: "Word report" },
      steps: {
        generate: { state: "failed", attempt: 3, seconds: 910, error: "No space left on device. All 3 attempts are used, and the work directory is kept." },
        check: { state: "cancelled", reason: "generate failed" },
        count: { state: "cancelled", reason: "generate failed" },
        report: { state: "cancelled", reason: "generate failed" },
      },
    },
    {
      id: 40,
      startedAgo: 179800,
      finishedAgo: 156500,
      inputs: { lines: 20000000, seed: 7, title: "Word report" },
      steps: {
        generate: { state: "succeeded", attempt: 2, seconds: 14090 },
        check: { state: "succeeded", attempt: 1, seconds: 41 },
        count: { state: "succeeded", attempt: 1, seconds: 9143 },
        report: { state: "succeeded", attempt: 1, seconds: 3 },
      },
    },
  ];

  return { pipeline, blocks, logs, failures, outputValues, runs };
})();
