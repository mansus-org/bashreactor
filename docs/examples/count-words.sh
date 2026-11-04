#!/usr/bin/env bash
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

with open(os.environ["INPUT_CORPUS"], encoding="utf-8") as corpus:
    counts = collections.Counter(corpus.read().split())

# Ties break alphabetically so the same corpus always gives the same output.
ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
top = [{"word": word, "count": count} for word, count in ranked[: int(os.environ["INPUT_TOP"])]]

with open(os.environ["OUTPUT_TOTAL_WORDS"], "w", encoding="utf-8") as output:
    output.write(str(counts.total()))

with open(os.environ["OUTPUT_TOP_WORDS"], "w", encoding="utf-8") as output:
    json.dump(top, output)

with open(os.environ["OUTPUT_COUNTS"], "w", encoding="utf-8", newline="") as output:
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(["word", "count"])
    writer.writerows(ranked)

print(f"count-words: {counts.total()} words, {len(counts)} distinct")
PY
