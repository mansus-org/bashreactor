#!/usr/bin/env bash
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
const rows = (await Bun.file(process.env.INPUT_COUNTS!).text()).trimEnd().split("\n");
const distinctWords = rows.length - 1;

const report = [
  `# ${title}`,
  "",
  `${totalWords} words, ${distinctWords} distinct.`,
  "",
  "| Word | Count |",
  "| --- | --- |",
  ...topWords.map(({ word, count }) => `| ${word} | ${count} |`),
  "",
].join("\n");

const bytes = await Bun.write(process.env.OUTPUT_REPORT!, report);
await Bun.write(process.env.OUTPUT_REPORT_BYTES!, String(bytes));
console.log(`render-report: ${bytes} bytes`);
TS
