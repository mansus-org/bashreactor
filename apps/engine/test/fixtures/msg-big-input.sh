#!/usr/bin/env bash
# ---
# name: msg-big-input
# description: Takes a string input it would echo back.
# inputs:
#   text:
#     type: string
#     description: Far too much of it, in this test.
# outputs:
#   said:
#     type: string
#     description: The same text, if it ever gets here.
# ---

printf '%s' "$INPUT_TEXT" > "$OUTPUT_SAID"
