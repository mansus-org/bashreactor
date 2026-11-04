#!/usr/bin/env bash
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
