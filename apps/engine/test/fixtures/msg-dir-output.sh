#!/usr/bin/env bash
# ---
# name: msg-dir-output
# description: Leaves a directory where its output file belongs.
# outputs:
#   count:
#     type: integer
#     description: Meant to hold a file.
# ---

mkdir -p "$OUTPUT_COUNT"
