#!/usr/bin/env bash
# ---
# name: msg-bad-integer
# description: Writes text where its header promises an integer.
# outputs:
#   count:
#     type: integer
#     description: Meant to hold a number.
# ---

echo "notanint" > "$OUTPUT_COUNT"
