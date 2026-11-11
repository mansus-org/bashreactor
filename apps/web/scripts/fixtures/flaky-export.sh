#!/usr/bin/env bash
# ---
# name: flaky-export
# description: Export the day's rows; the first attempt always loses its connection.
# inputs:
#   rows:
#     type: integer
#     description: How many rows to export.
#     default: 1200
# outputs:
#   exported:
#     type: integer
#     description: How many rows were written.
# ---

echo "flaky-export: attempt $BR_ATTEMPT, exporting $INPUT_ROWS rows"
if (( BR_ATTEMPT == 1 )); then
  echo "flaky-export: connection reset by peer" >&2
  # 75 asks for another attempt (SPEC 2.8).
  exit 75
fi
echo "$INPUT_ROWS" > "$OUTPUT_EXPORTED"
echo "flaky-export: wrote $INPUT_ROWS rows"
