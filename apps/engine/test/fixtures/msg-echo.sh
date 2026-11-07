#!/usr/bin/env bash
# ---
# name: msg-echo
# description: Does its little job and leaves cleanly.
# outputs:
#   said:
#     type: string
#     description: The word it said.
# ---

echo "hello" > "$OUTPUT_SAID"
