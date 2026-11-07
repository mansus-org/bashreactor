#!/usr/bin/env bash
# ---
# name: msg-huge-string
# description: Writes a string output far past the size a value may be.
# outputs:
#   blob:
#     type: string
#     description: Meant to hold at most 64 KiB.
# ---

awk 'BEGIN { for (i = 0; i < 70000; i++) printf "x" }' > "$OUTPUT_BLOB"
