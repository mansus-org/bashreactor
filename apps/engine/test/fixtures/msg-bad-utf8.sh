#!/usr/bin/env bash
# ---
# name: msg-bad-utf8
# description: Writes bytes that are not text at all.
# outputs:
#   label:
#     type: string
#     description: Meant to hold text.
# ---

printf '\xff\xfe\n' > "$OUTPUT_LABEL"
